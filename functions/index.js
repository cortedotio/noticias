const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
admin.initializeApp();
const db = admin.firestore();

// =====================================================================================
// ROBÔ DE BUSCA DE NOTÍCIAS (Agendado)
// =====================================================================================
exports.fetchNewsRobot = functions
    .region("southamerica-east1")
    .runWith({ timeoutSeconds: 300, memory: "256MB" })
    .pubsub.schedule("every 30 minutes")
    .onRun(async (context) => {
        functions.logger.info("News Fetching Robot Started!");

        const companiesRef = db.collection("companies");
        const activeCompaniesQuery = companiesRef.where("status", "==", "active");
        
        let companiesSnapshot;
        try {
            companiesSnapshot = await activeCompaniesQuery.get();
        } catch (error) {
            functions.logger.error("Error fetching active companies:", error);
            return null;
        }

        if (companiesSnapshot.empty) {
            functions.logger.info("No active companies found. Exiting.");
            return null;
        }

        const promises = companiesSnapshot.docs.map(async (companyDoc) => {
            const company = { id: companyDoc.id, ...companyDoc.data() };
            functions.logger.log(`Processing company: ${company.name} (ID: ${company.id})`);

            const settingsDoc = await db.collection("settings").doc(company.id).get();
            const apiKey = settingsDoc.exists() ? settingsDoc.data().apiKey : null;
            const newsScope = settingsDoc.exists() ? settingsDoc.data().newsScope : 'br';
            
            let newAlertsCount = settingsDoc.exists() && settingsDoc.data().newAlerts 
                ? settingsDoc.data().newAlerts 
                : { total: 0, byKeyword: {} };

            if (!apiKey) {
                functions.logger.warn(`No API Key for company ${company.name}. Skipping.`);
                return;
            }

            const keywordsSnapshot = await db.collection("companies").doc(company.id).collection("keywords").get();
            if (keywordsSnapshot.empty) {
                functions.logger.warn(`No keywords for company ${company.name}. Skipping.`);
                return;
            }
            const keywords = keywordsSnapshot.docs.map(d => d.data().word);

            const recentArticlesSnapshot = await db.collection("companies").doc(company.id).collection("articles").orderBy("publishedAt", "desc").limit(200).get();
            const foundUrls = new Set(recentArticlesSnapshot.docs.map(d => d.data().url));

            let newItemsFoundForCompany = false;

            for (const keyword of keywords) {
                let searchUrl = `https://gnews.io/api/v4/search?q="${encodeURIComponent(keyword)}"&lang=pt&token=${apiKey}`;
                if (newsScope === 'br' || newsScope === 'us') {
                    searchUrl += `&country=${newsScope}`;
                }
                if (newsScope === 'br-state') {
                    searchUrl += `&country=br`;
                }

                try {
                    const response = await fetch(searchUrl);
                    if (!response.ok) {
                        functions.logger.error(`GNews API error for keyword "${keyword}" in company ${company.name}. Status: ${response.status}`);
                        continue;
                    }
                    const data = await response.json();

                    if (!data.articles || data.articles.length === 0) {
                        continue;
                    }

                    const batch = db.batch();
                    let articlesInBatch = 0;

                    data.articles.forEach(article => {
                        if (!foundUrls.has(article.url)) {
                            const articleWithKeyword = { ...article, keyword: keyword, publishedAt: new Date(article.publishedAt) };
                            const newArticleRef = db.collection("companies").doc(company.id).collection("articles").doc();
                            batch.set(newArticleRef, articleWithKeyword);
                            
                            newItemsFoundForCompany = true;
                            articlesInBatch++;
                            foundUrls.add(article.url);

                            newAlertsCount.total = (newAlertsCount.total || 0) + 1;
                            if (!newAlertsCount.byKeyword) {
                                newAlertsCount.byKeyword = {};
                            }
                            newAlertsCount.byKeyword[keyword] = (newAlertsCount.byKeyword[keyword] || 0) + 1;
                        }
                    });

                    if (articlesInBatch > 0) {
                        await batch.commit();
                        functions.logger.info(`Saved ${articlesInBatch} new articles for keyword "${keyword}" in company ${company.name}.`);
                    }

                } catch (error) {
                    functions.logger.error(`Failed to fetch or process news for keyword "${keyword}" in company ${company.name}:`, error);
                }
            }

            if (newItemsFoundForCompany) {
                await db.collection("settings").doc(company.id).set({ newAlerts: newAlertsCount }, { merge: true });
                functions.logger.log(`Updated newAlerts count for company ${company.name}:`, newAlertsCount);
            }
        });

        await Promise.all(promises);
        functions.logger.info("News Fetching Robot Finished!");
        return null;
    });

// =====================================================================================
// FUNÇÃO PARA EXCLUIR EMPRESA (Chamável)
// =====================================================================================
exports.deleteCompany = functions
    .region("southamerica-east1")
    .runWith({ timeoutSeconds: 540, memory: "1GB" })
    .https.onCall(async (data, context) => {
        const companyId = data.companyId;
        if (!companyId) {
            throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "companyId" argument.');
        }

        const companyPath = `companies/${companyId}`;
        const companyRef = db.doc(companyPath);
        functions.logger.log(`DELETION_START: Deleting all data for company: ${companyId}`);

        try {
            functions.logger.log(`DELETION_STEP: Deleting 'users' subcollection...`);
            await deleteCollection(db, `${companyPath}/users`, 200);
            
            functions.logger.log(`DELETION_STEP: Deleting 'keywords' subcollection...`);
            await deleteCollection(db, `${companyPath}/keywords`, 200);
            
            functions.logger.log(`DELETION_STEP: Deleting 'articles' subcollection...`);
            await deleteCollection(db, `${companyPath}/articles`, 200);
            
            functions.logger.log(`DELETION_STEP: Finished deleting all subcollections.`);
            
            functions.logger.log(`DELETION_STEP: Deleting main company document...`);
            await companyRef.delete();
            
            const settingsRef = db.collection("settings").doc(companyId);
            functions.logger.log(`DELETION_STEP: Deleting settings document...`);
            await settingsRef.delete();
            
            functions.logger.log(`DELETION_SUCCESS: All data for company ${companyId} has been deleted.`);
            return { success: true };
        } catch (error) {
            functions.logger.error(`DELETION_ERROR: Failed to delete company ${companyId}.`, error);
            throw new functions.https.HttpsError('internal', 'An error occurred during the deletion process.', error.message);
        }
    });

// =====================================================================================
// FUNÇÃO AUXILIAR PARA EXCLUSÃO RECURSIVA
// =====================================================================================
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(db, query, resolve) {
    const snapshot = await query.get();
    if (snapshot.size === 0) {
        return resolve();
    }
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}
