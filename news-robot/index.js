/**
 * IMPORTANTE: Este é o código COMPLETO e ATUALIZADO para o servidor (Firebase Cloud Functions).
 * ...
 * * * * NOVA FUNCIONALIDADE (SET/2025): Integração com Vision AI e Video Intelligence AI
 * * para análise de logotipos, OCR em imagens e transcrição de áudio de vídeos.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const Parser = require('rss-parser');

// ADICIONADO: Importa as novas bibliotecas do Google Cloud
const { LanguageServiceClient } = require('@google-cloud/language');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { Client } = require("@googlemaps/google-maps-services-js");

admin.initializeApp();
const db = admin.firestore();
const parser = new Parser();

// ADICIONADO: Inicializa os clientes das novas APIs
const languageClient = new LanguageServiceClient();
const translationClient = new TranslationServiceClient();
const visionClient = new ImageAnnotatorClient();
const videoClient = new VideoIntelligenceServiceClient();
const mapsClient = new Client({});

const GNEWS_URL = "https://gnews.io/api/v4/search";
const NEWSAPI_URL = "https://newsapi.org/v2/everything";
const BLOGGER_URL = "https://www.googleapis.com/blogger/v3/blogs";
const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const APP_ID = "noticias-6e952";
const GOOGLE_PROJECT_ID = "noticias-6e952";

// Aumentado para 9 minutos para dar tempo para a análise de IA, especialmente vídeo
const runtimeOpts = {
  timeoutSeconds: 540, 
  memory: '2GB' // Aumenta a memória para processamento de vídeo
};
const regionalFunctions = functions.region("southamerica-east1").runWith(runtimeOpts);


// --- Funções Auxiliares ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const findMatchingKeywords = (article, keywords) => {
    let contentToSearch = (article.title || "").toLowerCase();
    contentToSearch += " " + (article.contentSnippet || article.description || article.content || "").toLowerCase();
    // Adiciona a transcrição do vídeo e o texto da imagem (OCR) à busca de palavras-chave
    if (article.ai?.videoTranscription) {
        contentToSearch += " " + article.ai.videoTranscription.toLowerCase();
    }
    if (article.ai?.ocrText) {
        contentToSearch += " " + article.ai.ocrText.toLowerCase();
    }
    const matchedKeywords = keywords.filter(kw => {
        const lowerCaseKw = kw.toLowerCase();
        return contentToSearch.includes(lowerCaseKw);
    });
    return matchedKeywords;
};

async function geocodeLocation(locationName, apiKey) {
    if (!locationName || !apiKey) return null;
    const locationKey = locationName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cacheRef = db.doc(`artifacts/${APP_ID}/public/data/geocache/${locationKey}`);
    try {
        const cacheDoc = await cacheRef.get();
        if (cacheDoc.exists) {
            return cacheDoc.data();
        }
        const response = await mapsClient.geocode({
            params: {
                address: `${locationName}, Brasil`,
                key: apiKey,
                language: 'pt-BR',
                region: 'BR'
            }
        });
        if (response.data.results && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            await cacheRef.set(location);
            return location;
        }
        return null;
    } catch (error) {
        functions.logger.error(`Erro de Geocoding para '${locationName}':`, error.message);
        return null;
    }
}

async function detectAndTranslate(text) {
    if (!text || text.length < 20) {
        return { originalText: text, translatedText: text, languageCode: 'pt', translated: false };
    }
    const request = {
        parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
        content: text,
        mimeType: 'text/plain',
    };
    try {
        const [response] = await translationClient.detectLanguage(request);
        const detectedLanguage = response.languages[0];
        if (detectedLanguage.languageCode.toLowerCase() !== 'pt') {
            const translateRequest = {
                parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
                contents: [text],
                mimeType: 'text/plain',
                sourceLanguageCode: detectedLanguage.languageCode,
                targetLanguageCode: 'pt',
            };
            const [translateResponse] = await translationClient.translateText(translateRequest);
            const translation = translateResponse.translations[0];
            return { originalText: text, translatedText: translation.translatedText, languageCode: detectedLanguage.languageCode, translated: true };
        }
        return { originalText: text, translatedText: text, languageCode: 'pt', translated: false };
    } catch (error) {
        functions.logger.error("Erro na API de Tradução:", error.message);
        return { originalText: text, translatedText: text, languageCode: 'und', translated: false };
    }
}

function normalizeArticle(article, sourceApi) {
    try {
        switch (sourceApi) {
            case 'gnews':
                return {
                    title: article.title, description: article.description, url: article.url, image: article.image || null,
                    publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)),
                    source: { name: article.source.name, url: article.source.url }, author: article.author || null,
                };
            case 'newsapi':
                return {
                    title: article.title, description: article.description, url: article.url, image: article.urlToImage || null,
                    publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)),
                    source: { name: article.source.name, url: null }, author: article.author || null,
                };
            case 'blogger':
                const blogName = article.blog ? article.blog.name : 'Blogger';
                return {
                    title: article.title, description: (article.content || "").substring(0, 500).replace(/<[^>]*>?/gm, '') + '...',
                    url: article.url, image: null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.published)),
                    source: { name: blogName, url: article.url }, author: article.author?.displayName || null,
                };
            case 'rss':
                return {
                    title: article.title, description: (article.contentSnippet || article.content || "").substring(0, 500),
                    url: article.link, image: article.enclosure?.url || null,
                    publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.isoDate)),
                    source: { name: article.creator || 'RSS Feed', url: article.link }, author: article.creator || null,
                };
            case 'youtube':
                return {
                    title: article.snippet.title, description: article.snippet.description, url: `https://www.youtube.com/watch?v=${article.id.videoId}`,
                    image: article.snippet.thumbnails.high.url || null,
                    publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.snippet.publishedAt)),
                    source: { name: 'YouTube', url: `https://www.youtube.com/channel/${article.snippet.channelId}` }, author: article.snippet.channelTitle || null,
                    videoId: article.id.videoId
                };
            default: return null;
        }
    } catch (e) {
        functions.logger.error(`Erro ao normalizar artigo da fonte ${sourceApi}:`, e, article);
        return null;
    }
}

async function analyzeArticleWithAI(article, settings) {
    const textContent = `${article.title}. ${article.description}`;
    let languageData = { sentiment: { score: 0, magnitude: 0 }, entities: [], categories: [] };
    let visionData = { logos: [], ocrText: '' };
    let videoData = { videoTranscription: '' };

    if (textContent && textContent.length > 50 && !textContent.startsWith('http')) {
        try {
            const document = { content: textContent, type: 'PLAIN_TEXT', language: 'pt' };
            const [sentimentResult, entitiesResult, categoriesResult] = await Promise.all([
                languageClient.analyzeSentiment({ document }),
                languageClient.analyzeEntities({ document }),
                languageClient.classifyText({ document })
            ]);
            languageData.sentiment = sentimentResult[0].documentSentiment;
            languageData.entities = entitiesResult[0].entities.filter(e => e.salience > 0.01 && e.type !== 'OTHER').map(e => ({ name: e.name, type: e.type, salience: e.salience }));
            languageData.categories = categoriesResult[0].categories.map(c => ({ name: c.name, confidence: c.confidence }));
        } catch (error) {
            functions.logger.error("Erro na Natural Language AI:", error.message);
        }
    }
    
    if (article.image && settings.apiKeyVision) {
        try {
            const [logoResult] = await visionClient.logoDetection(article.image);
            visionData.logos = logoResult.logoAnnotations.map(logo => ({ description: logo.description, score: logo.score }));
            const [textResult] = await visionClient.textDetection(article.image);
            visionData.ocrText = textResult.fullTextAnnotation ? textResult.fullTextAnnotation.text : '';
        } catch (err) {
            functions.logger.warn(`Vision AI error para imagem ${article.image}:`, err.message);
        }
    }

    if (article.videoId && settings.apiKeyVideoIntelligence) {
        functions.logger.warn(`A transcrição de vídeo para ${article.videoId} foi pulada. Requer upload para o Google Cloud Storage.`);
    }

    return { ...languageData, ...visionData, ...videoData };
}

async function fetchAllNews() {
    functions.logger.info("=======================================");
    functions.logger.info("INICIANDO BUSCA DE NOTÍCIAS COM TRADUÇÃO, IA E GEOCODIFICAÇÃO...");

    const globalSettingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/global`);
    const globalSettingsDoc = await globalSettingsRef.get();
    if (!globalSettingsDoc.exists) {
        throw new Error("Configurações globais não encontradas.");
    }
    const settings = globalSettingsDoc.data();
    const firebaseApiKey = settings.apiKeyFirebaseNews; 

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const companiesSnapshot = await db.collection(`artifacts/${APP_ID}/public/data/companies`).where("status", "==", "active").get();
    if (companiesSnapshot.empty) {
        functions.logger.warn("Nenhuma empresa ativa encontrada para processar.");
        return { success: true, message: "Nenhuma empresa ativa encontrada." };
    }

    let articlesToSaveCount = 0;
    const allCompaniesData = []; 

    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        const companySettingsDoc = await db.doc(`artifacts/${APP_ID}/public/data/settings/${companyId}`).get();
        const fetchOnlyNew = companySettingsDoc.exists && companySettingsDoc.data().fetchOnlyNew === true;
        const existingUrls = new Set();
        const articlesQuery = db.collection(`artifacts/${APP_ID}/users/${companyId}/articles`).select('url');
        const pendingQuery = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).where('companyId', '==', companyId).select('url');
        const [articlesSnapshot, pendingSnapshot] = await Promise.all([articlesQuery.get(), pendingQuery.get()]);
        
        articlesSnapshot.forEach(doc => existingUrls.add(doc.data().url));
        pendingSnapshot.forEach(doc => existingUrls.add(doc.data().url));
        const keywordsSnapshot = await db.collection(`artifacts/${APP_ID}/users/${companyId}/keywords`).get();
        if (!keywordsSnapshot.empty) {
            const keywordsList = keywordsSnapshot.docs.map(doc => doc.data().word);
            allCompaniesData.push({ companyId, companyName, keywordsList, fetchOnlyNew, existingUrls });
        }
    }

    const processAndSaveArticle = async (normalizedArticle, company, matchedKeywords) => {
        if (!normalizedArticle || company.existingUrls.has(normalizedArticle.url)) {
            return;
        }
        
        const translatedTitle = await detectAndTranslate(normalizedArticle.title);
        const translatedDesc = await detectAndTranslate(normalizedArticle.description);
        normalizedArticle.title = translatedTitle.translatedText;
        normalizedArticle.description = translatedDesc.translatedText;
        
        const aiData = await analyzeArticleWithAI(normalizedArticle, settings);
        const finalMatchedKeywords = findMatchingKeywords({ ...normalizedArticle, ai: aiData }, company.keywordsList);

        if (finalMatchedKeywords.length === 0) {
            return;
        }

        let geolocation = null;
        if (aiData.entities && aiData.entities.length > 0) {
            const firstLocation = aiData.entities.find(e => e.type === 'LOCATION');
            if (firstLocation) {
                geolocation = await geocodeLocation(firstLocation.name, firebaseApiKey);
            }
        }

        const articleData = {
            ...normalizedArticle,
            keywords: finalMatchedKeywords,
            companyId: company.companyId,
            companyName: company.companyName,
            status: "pending",
            ai: aiData,
            sentiment: { score: aiData.sentiment.score, magnitude: aiData.sentiment.magnitude },
            translationInfo: {
                translated: translatedTitle.translated || translatedDesc.translated,
                originalLanguage: translatedTitle.languageCode
            },
            geolocation: geolocation
        };

        const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
        const batch = db.batch();
        batch.set(pendingAlertRef, articleData);
        await batch.commit();
        
        company.existingUrls.add(normalizedArticle.url);
        articlesToSaveCount++;
    };

    for (const company of allCompaniesData) {
        functions.logger.info(`--- Processando empresa: ${company.companyName} ---`);
        const combinedQuery = company.keywordsList.map(kw => `"${kw}"`).join(" OR ");
        
        if (settings.apiKeyGNews1) {
            await delay(1000);
            const currentHour = new Date().getHours();
            let gnewsApiKey = settings.apiKeyGNews4;
            if (currentHour >= 0 && currentHour < 6) gnewsApiKey = settings.apiKeyGNews1;
            else if (currentHour >= 6 && currentHour < 12) gnewsApiKey = settings.apiKeyGNews2;
            else if (currentHour >= 12 && currentHour < 18) gnewsApiKey = settings.apiKeyGNews3;
            if(gnewsApiKey) {
                const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(combinedQuery)}&lang=pt,en,es&token=${gnewsApiKey}`;
                try {
                    const response = await axios.get(queryUrl);
                    if (response.data && response.data.articles) {
                        for (const article of response.data.articles) {
                            const matchedKeywords = findMatchingKeywords(article, company.keywordsList);
                            if (matchedKeywords.length > 0 && (!company.fetchOnlyNew || new Date(article.publishedAt) >= twentyFourHoursAgo)) {
                                const normalized = normalizeArticle(article, 'gnews');
                                await processAndSaveArticle(normalized, company, matchedKeywords);
                            }
                        }
                    }
                } catch (e) { functions.logger.error(`Erro GNews para ${company.companyName}:`, e.message); }
            }
        }
        
        if (settings.apiKeyNewsApi) {
            await delay(1000);
            const queryUrl = `${NEWSAPI_URL}?q=${encodeURIComponent(combinedQuery)}&language=pt,en,es&apiKey=${settings.apiKeyNewsApi}`;
            try {
                const response = await axios.get(queryUrl);
                if (response.data && response.data.articles) {
                    for (const article of response.data.articles) {
                        const matchedKeywords = findMatchingKeywords(article, company.keywordsList);
                        if (matchedKeywords.length > 0 && (!company.fetchOnlyNew || new Date(article.publishedAt) >= twentyFourHoursAgo)) {
                            const normalized = normalizeArticle(article, 'newsapi');
                            await processAndSaveArticle(normalized, company, matchedKeywords);
                        }
                    }
                }
            } catch (e) { functions.logger.error(`Erro NewsAPI para ${company.companyName}:`, e.message); }
        }
    }

    const rssUrls = settings.rssUrl ? settings.rssUrl.split('\n').filter(url => url.trim() !== '') : [];
    if (rssUrls.length > 0) {
        functions.logger.info(`--- Processando ${rssUrls.length} Feeds RSS para todas as empresas ---`);
        for (const rssUrl of rssUrls) {
            try {
                await delay(1000);
                const feed = await parser.parseURL(rssUrl);
                if (feed && feed.items) {
                    for (const item of feed.items) {
                        for (const company of allCompaniesData) {
                             const matchedKeywords = findMatchingKeywords(item, company.keywordsList);
                             if (matchedKeywords.length > 0 && (!company.fetchOnlyNew || new Date(item.isoDate) >= twentyFourHoursAgo)) {
                                const normalized = normalizeArticle(item, 'rss');
                                await processAndSaveArticle(normalized, company, matchedKeywords);
                            }
                        }
                    }
                }
            } catch (e) {
                functions.logger.error(`Erro ao buscar o feed RSS: ${rssUrl}. Mensagem: ${e.message}`);
            }
        }
    }
    
    functions.logger.info(`Busca concluída. ${articlesToSaveCount} novos artigos únicos foram guardados na fila de aprovação.`);
    return { success: true, totalSaved: articlesToSaveCount };
}

exports.manualFetch = regionalFunctions.https.onCall(async (data, context) => {
    try {
        return await fetchAllNews();
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função manualFetch:", error);
        throw new functions.https.HttpsError("internal", "Ocorreu um erro interno no servidor.", error.message);
    }
});

exports.scheduledFetch = regionalFunctions.pubsub.schedule("every 30 minutes")
  .timeZone("America/Sao_Paulo")
  .onRun(async (context) => {
    try {
        await fetchAllNews();
        return null;
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função scheduledFetch:", error);
        return null;
    }
});
exports.approveAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários."); }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    const pendingAlertDoc = await pendingAlertRef.get();
    if (!pendingAlertDoc.exists) { throw new functions.https.HttpsError("not-found", "Alerta pendente não encontrado."); }
    const alertData = pendingAlertDoc.data();
    if (!alertData) { throw new functions.https.HttpsError("internal", "Dados do alerta estão corrompidos."); }
    const companyId = alertData.companyId;
    await db.collection(`artifacts/${appId}/users/${companyId}/articles`).add({ ...alertData, status: "approved", approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    await pendingAlertRef.delete();
    const settingsRef = db.doc(`artifacts/${appId}/public/data/settings/${companyId}`);
    await db.runTransaction(async (transaction) => {
        const settingsDoc = await transaction.get(settingsRef);
        const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
        transaction.set(settingsRef, { newAlertsCount }, { merge: true });
    });
    return { success: true };
});

exports.rejectAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários."); }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    await pendingAlertRef.delete();
    return { success: true };
});

async function deleteCollection(collectionRef) {
    const snapshot = await collectionRef.get();
    if (snapshot.size === 0) return;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
}

exports.deleteCompany = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId } = data;
    if (!appId || !companyId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da empresa são necessários."); }
    await deleteCollection(db.collection(`artifacts/${appId}/users/${companyId}/users`));
    await deleteCollection(db.collection(`artifacts/${appId}/users/${companyId}/keywords`));
    await deleteCollection(db.collection(`artifacts/${appId}/users/${companyId}/articles`));
    await db.doc(`artifacts/${appId}/public/data/companies/${companyId}`).delete();
    await db.doc(`artifacts/${appId}/public/data/settings/${companyId}`).delete();
    const pendingAlertsSnapshot = await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).where("companyId", "==", companyId).get();
    const pendingBatch = db.batch();
    pendingAlertsSnapshot.docs.forEach(doc => pendingBatch.delete(doc.ref));
    await pendingBatch.commit();
    const deletionRequestsSnapshot = await db.collection(`artifacts/${appId}/public/data/deletionRequests`).where("companyId", "==", companyId).get();
    const requestsBatch = db.batch();
    deletionRequestsSnapshot.docs.forEach(doc => requestsBatch.delete(doc.ref));
    await requestsBatch.commit();
    return { success: true };
});

exports.deleteKeywordAndArticles = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, keyword } = data;
    if (!appId || !companyId || !keyword) { throw new functions.https.HttpsError("invalid-argument", "ID da aplicação, da empresa e palavra-chave são necessários."); }
    const articlesToDelete = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).where("keywords", "array-contains", keyword).get();
    const batch = db.batch();
    articlesToDelete.docs.forEach(doc => { batch.delete(doc.ref); });
    await batch.commit();
    const keywordRef = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).where("word", "==", keyword).get();
    if (!keywordRef.empty) {
        await db.doc(`artifacts/${appId}/users/${companyId}/keywords/${keywordRef.docs[0].id}`).delete();
    }
    return { success: true };
});

exports.manageDeletionRequest = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, requestId, approve } = data;
    if (!appId || !requestId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da solicitação são necessários."); }
    const requestRef = db.doc(`artifacts/${appId}/public/data/deletionRequests/${requestId}`);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) { throw new functions.https.HttpsError("not-found", "Solicitação de exclusão não encontrada."); }
    const requestData = requestDoc.data();
    if (!requestData) { throw new functions.https.HttpsError("internal", "Dados da solicitação estão corrompidos."); }
    const articleRef = db.doc(`artifacts/${appId}/users/${requestData.companyId}/articles/${requestData.articleId}`);
    if (approve) {
        await articleRef.delete();
        await requestRef.update({ status: "approved" });
    } else {
        await articleRef.update({ deletionRequestStatus: null });
        await requestRef.update({ status: "denied" });
    }
    return { success: true };
});

exports.requestAlertDeletion = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, companyName, articleId, articleTitle, justification } = data;
    if (!appId || !companyId || !articleId || !justification) { throw new functions.https.HttpsError("invalid-argument", "Informações incompletas para a solicitação de exclusão."); }
    await db.collection(`artifacts/${appId}/public/data/deletionRequests`).add({ companyId, companyName, articleId, articleTitle, justification, status: "pending", requestedAt: admin.firestore.FieldValue.serverTimestamp() });
    const articleRef = db.doc(`artifacts/${appId}/users/${companyId}/articles/${articleId}`);
    await articleRef.update({ deletionRequestStatus: 'pending' });
    return { success: true };
});

exports.manualAddAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, title, description, url, source, keywords } = data;
    if (!appId || !companyId || !title || !url || !source || !keywords || !Array.isArray(keywords) || keywords.length === 0) { throw new functions.https.HttpsError("invalid-argument", "Dados incompletos ou inválidos para adicionar um alerta."); }
    const companyDoc = await db.doc(`artifacts/${appId}/public/data/companies/${companyId}`).get();
    if (!companyDoc.exists) { throw new functions.https.HttpsError("not-found", "Empresa não encontrada."); }
    const companyName = companyDoc.data()?.name;
    const alertData = { title, description, url, source: { name: source, url: "" }, publishedAt: admin.firestore.FieldValue.serverTimestamp(), keywords, companyId, companyName, status: "approved", };
    await db.collection(`artifacts/${appId}/users/${companyId}/articles`).add(alertData);
    const settingsRef = db.doc(`artifacts/${appId}/public/data/settings/${companyId}`);
    await db.runTransaction(async (transaction) => {
        const settingsDoc = await transaction.get(settingsRef);
        const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
        transaction.set(settingsRef, { newAlertsCount }, { merge: true });
    });
    return { success: true };
});

function getChannelCategory(sourceName) {
    const name = (sourceName || "").toLowerCase();
    if (name.includes('youtube')) return 'YouTube';
    if (name.includes('globo') || name.includes('g1') || name.includes('uol') || name.includes('terra') || name.includes('r7')) return 'Sites';
    if (name.includes('veja') || name.includes('istoé') || name.includes('exame')) return 'Revistas';
    if (name.includes('cbn') || name.includes('bandeirantes')) return 'Rádios';
    return 'Sites';
}

function getPredominantSentiment(percentages) {
    if (percentages.positive > percentages.neutral && percentages.positive > percentages.negative) return 'Positivo';
    if (percentages.negative > percentages.positive && percentages.negative > percentages.neutral) return 'Negativo';
    return 'Neutro';
}
function getTopCount(counts) {
    if (Object.keys(counts).length === 0) return 'N/A';
    return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

exports.generateSuperAdminReport = regionalFunctions.https.onCall(async (data, context) => {
    const { appId } = data;
    if (!appId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }
    functions.logger.info("Iniciando geração do relatório geral de empresas...");
    const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
    const reportData = [];
    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        functions.logger.info(`Processando relatório para: ${companyName} (ID: ${companyId})`);
        
        const articlesSnapshot = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).get();
        const totalAlerts = articlesSnapshot.size;
        
        let positiveCount = 0, neutralCount = 0, negativeCount = 0;
        const channelCounts = {}, vehicleCounts = {};
        
        if (articlesSnapshot.size > 0) {
            articlesSnapshot.docs.forEach(doc => {
                const article = doc.data();
                const score = article.sentiment?.score ?? 0;
                if (score > 0.2) positiveCount++;
                else if (score < -0.2) negativeCount++;
                else neutralCount++;
                const channel = article.source?.name ? getChannelCategory(article.source.name) : 'Outros';
                channelCounts[channel] = (channelCounts[channel] || 0) + 1;
                const vehicle = article.source?.name || 'Outros';
                vehicleCounts[vehicle] = (vehicleCounts[vehicle] || 0) + 1;
            });
        }

        const totalSentiments = positiveCount + neutralCount + negativeCount;
        const sentimentPercentage = {
            positive: totalSentiments > 0 ? parseFloat(((positiveCount / totalSentiments) * 100).toFixed(2)) : 0,
            neutral: totalSentiments > 0 ? parseFloat(((neutralCount / totalSentiments) * 100).toFixed(2)) : 0,
            negative: totalSentiments > 0 ? parseFloat(((negativeCount / totalSentiments) * 100).toFixed(2)) : 0,
        };
        
        const predominantSentiment = getPredominantSentiment(sentimentPercentage);
        const topChannel = getTopCount(channelCounts);
        const topVehicle = getTopCount(vehicleCounts);
        reportData.push({ companyId, companyName, totalAlerts, sentimentPercentage, predominantSentiment, topChannel, topVehicle });
    }
    functions.logger.info("Relatório geral gerado com sucesso.");
    return reportData;
});

