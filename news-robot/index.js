/**
 * IMPORTANTE: Este é o código COMPLETO e ATUALIZADO para o servidor (Firebase Cloud Functions).
 * * LÓGICA ATUAL: Busca cada palavra-chave individualmente, inclui uma pausa (delay) de 1 segundo
 * * para evitar o erro 429, busca em TODAS as fontes (GNews, NewsAPI, YouTube, Blogger, RSS) e 
 * * aplica um filtro de 24 horas quando solicitado.
 * * * * CORREÇÃO (SET/2025): Refatorada a lógica de busca RSS para ser mais eficiente, buscando cada 
 * * feed apenas uma vez e verificando contra todas as palavras-chave, evitando erros 429.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// URLs das APIs
const GNEWS_URL = "https://gnews.io/api/v4/search";
const NEWSAPI_URL = "https://newsapi.org/v2/everything";
const BLOGGER_URL = "https://www.googleapis.com/blogger/v3/blogs";
const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const RSS2JSON_URL = "https://api.rss2json.com/v1/api.json";
const APP_ID = "noticias-6e952";

// Aumenta o tempo limite da função para 5 minutos (300 segundos) para evitar timeouts.
const runtimeOpts = {
  timeoutSeconds: 300,
  memory: '1GB'
};
const regionalFunctions = functions.region("southamerica-east1").runWith(runtimeOpts);


// --- Funções Auxiliares ---

// Cria uma pausa para evitar sobrecarregar as APIs
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const findMatchingKeywords = (article, keywords) => {
    const title = (article.title || "").toLowerCase();
    const bodyText = (article.description || article.content || "").toLowerCase();
    const matchedKeywords = keywords.filter(kw => {
        const lowerCaseKw = kw.toLowerCase();
        return title.includes(lowerCaseKw) || bodyText.includes(lowerCaseKw);
    });
    return matchedKeywords;
};

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
                 // Blogger API pode não retornar o nome do blog diretamente no item do post, pegamos da URL
                const blogName = article.blog ? article.blog.name : 'Blogger';
                return {
                    title: article.title, description: (article.content || "").substring(0, 250).replace(/<[^>]*>?/gm, '') + '...',
                    url: article.url, image: null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.published)),
                    source: { name: blogName, url: article.url }, author: article.author?.displayName || null,
                };
            case 'rss':
                return {
                    title: article.title, description: (article.description || "").substring(0, 250).replace(/<[^>]*>?/gm, '') + '...',
                    url: article.link, image: article.thumbnail || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.pubDate)),
                    source: { name: article.author || 'RSS Feed', url: article.link }, author: article.author || null,
                };
            case 'youtube':
                return {
                    title: article.snippet.title, description: article.snippet.description, url: `https://www.youtube.com/watch?v=${article.id.videoId}`,
                    image: article.snippet.thumbnails.high.url || null,
                    publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.snippet.publishedAt)),
                    source: { name: 'YouTube', url: `https://www.youtube.com/channel/${article.snippet.channelId}` }, author: article.snippet.channelTitle || null,
                };
            default: return null;
        }
    } catch (e) {
        functions.logger.error(`Erro ao normalizar artigo da fonte ${sourceApi}:`, e, article);
        return null;
    }
}

async function fetchAllNews() {
    functions.logger.info("=======================================");
    functions.logger.info("INICIANDO BUSCA DE NOTÍCIAS...");

    const globalSettingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/global`);
    const globalSettingsDoc = await globalSettingsRef.get();
    if (!globalSettingsDoc.exists) {
        throw new Error("Configurações globais não encontradas.");
    }
    const settings = globalSettingsDoc.data();

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const companiesSnapshot = await db.collection(`artifacts/${APP_ID}/public/data/companies`).where("status", "==", "active").get();
    if (companiesSnapshot.empty) {
        functions.logger.warn("Nenhuma empresa ativa encontrada para processar.");
        return { success: true, message: "Nenhuma empresa ativa encontrada." };
    }

    const batch = db.batch();
    let articlesToSaveCount = 0;
    const allCompaniesData = []; // Armazena dados das empresas para o passo 2 (RSS)

    // =======================================================================
    // PASSO 1: Busca em APIs que suportam palavras-chave na query (GNews, NewsAPI, etc.)
    // =======================================================================
    functions.logger.info("PASSO 1: Buscando em GNews, NewsAPI, YouTube e Blogger...");
    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        functions.logger.info(`--- A processar empresa: ${companyName} ---`);

        const companySettingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/${companyId}`);
        const companySettingsDoc = await companySettingsRef.get();
        const fetchOnlyNew = companySettingsDoc.exists && companySettingsDoc.data().fetchOnlyNew === true;

        if (fetchOnlyNew) {
            functions.logger.log(`[FILTRO ATIVO] Para ${companyName}, buscando apenas notícias das últimas 24 horas.`);
        }

        const existingUrls = new Set();
        const articlesQuery = db.collection(`artifacts/${APP_ID}/users/${companyId}/articles`).select('url');
        const pendingQuery = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).where('companyId', '==', companyId).select('url');
        const [articlesSnapshot, pendingSnapshot] = await Promise.all([articlesQuery.get(), pendingQuery.get()]);
        
        articlesSnapshot.forEach(doc => existingUrls.add(doc.data().url));
        pendingSnapshot.forEach(doc => existingUrls.add(doc.data().url));

        const keywordsSnapshot = await db.collection(`artifacts/${APP_ID}/users/${companyId}/keywords`).get();
        if (keywordsSnapshot.empty) {
            functions.logger.warn(`Nenhuma palavra-chave para a empresa ${companyName}, a saltar.`);
            continue;
        }

        const keywordsList = keywordsSnapshot.docs.map(doc => doc.data().word);
        
        // Armazena os dados para o passo de busca RSS
        allCompaniesData.push({ companyId, companyName, keywordsList, fetchOnlyNew, existingUrls });

        for (const keyword of keywordsList) {
            await delay(1000); // Pausa para evitar erro 429
            const searchQuery = `"${keyword}"`;

            // 1. Busca no GNews
            if (settings.apiKeyGNews1) {
                const currentHour = new Date().getHours();
                let gnewsApiKey = '';
                if (currentHour >= 0 && currentHour < 6) gnewsApiKey = settings.apiKeyGNews1;
                else if (currentHour >= 6 && currentHour < 12) gnewsApiKey = settings.apiKeyGNews2;
                else if (currentHour >= 12 && currentHour < 18) gnewsApiKey = settings.apiKeyGNews3;
                else gnewsApiKey = settings.apiKeyGNews4;

                if (gnewsApiKey) {
                    const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(searchQuery)}&lang=pt&country=br&token=${gnewsApiKey}`;
                    try {
                        const response = await axios.get(queryUrl);
                        if (response.data && response.data.articles) {
                            for (const article of response.data.articles) {
                                if (fetchOnlyNew && new Date(article.publishedAt) < twentyFourHoursAgo) continue;
                                if (existingUrls.has(article.url)) continue;
                                const matchedKeywords = findMatchingKeywords(article, [keyword]);
                                if (matchedKeywords.length > 0) {
                                    const normalized = normalizeArticle(article, 'gnews');
                                    if (normalized) {
                                        const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
                                        batch.set(pendingAlertRef, { ...normalized, keywords: matchedKeywords, companyId, companyName, status: "pending" });
                                        existingUrls.add(article.url);
                                        articlesToSaveCount++;
                                    }
                                }
                            }
                        }
                    } catch (e) { functions.logger.error(`Erro GNews (keyword: ${keyword}):`, e.message); }
                }
            }

            // 2. Busca no NewsAPI
            if (settings.apiKeyNewsApi) {
                const queryUrl = `${NEWSAPI_URL}?q=${encodeURIComponent(searchQuery)}&language=pt&apiKey=${settings.apiKeyNewsApi}`;
                try {
                    const response = await axios.get(queryUrl);
                    if (response.data && response.data.articles) {
                        for (const article of response.data.articles) {
                            if (fetchOnlyNew && new Date(article.publishedAt) < twentyFourHoursAgo) continue;
                            if (existingUrls.has(article.url)) continue;
                            const matchedKeywords = findMatchingKeywords(article, [keyword]);
                            if (matchedKeywords.length > 0) {
                                const normalized = normalizeArticle(article, 'newsapi');
                                if (normalized) {
                                    const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
                                    batch.set(pendingAlertRef, { ...normalized, keywords: matchedKeywords, companyId, companyName, status: "pending" });
                                    existingUrls.add(article.url);
                                    articlesToSaveCount++;
                                }
                            }
                        }
                    }
                } catch (e) { functions.logger.error(`Erro NewsAPI (keyword: ${keyword}):`, e.message); }
            }

            // 3. Busca no YouTube
            if (settings.apiKeyYoutube) {
                const queryUrl = `${YOUTUBE_URL}?part=snippet&q=${encodeURIComponent(searchQuery)}&type=video&key=${settings.apiKeyYoutube}`;
                try {
                    const response = await axios.get(queryUrl);
                    if (response.data && response.data.items) {
                        for (const item of response.data.items) {
                            const articleUrl = `https://www.youtube.com/watch?v=${item.id.videoId}`;
                            if (fetchOnlyNew && new Date(item.snippet.publishedAt) < twentyFourHoursAgo) continue;
                            if (existingUrls.has(articleUrl)) continue;
                            const matchedKeywords = findMatchingKeywords(item.snippet, [keyword]);
                            if (matchedKeywords.length > 0) {
                                const normalized = normalizeArticle(item, 'youtube');
                                if (normalized) {
                                    const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
                                    batch.set(pendingAlertRef, { ...normalized, keywords: matchedKeywords, companyId, companyName, status: "pending" });
                                    existingUrls.add(articleUrl);
                                    articlesToSaveCount++;
                                }
                            }
                        }
                    }
                } catch (e) { functions.logger.error(`Erro YouTube (keyword: ${keyword}):`, e.message); }
            }

            // 4. Busca em Blogs (Blogger)
            if (settings.apiKeyBlogger && settings.bloggerId) {
                const blogIds = settings.bloggerId.split('\n').filter(id => id.trim() !== '');
                for (const blogId of blogIds) {
                    const queryUrl = `${BLOGGER_URL}/${blogId}/posts/search?q=${encodeURIComponent(searchQuery)}&key=${settings.apiKeyBlogger}`;
                    try {
                        const response = await axios.get(queryUrl);
                        if (response.data && response.data.items) {
                            for (const item of response.data.items) {
                                if (fetchOnlyNew && new Date(item.published) < twentyFourHoursAgo) continue;
                                if (existingUrls.has(item.url)) continue;
                                const matchedKeywords = findMatchingKeywords(item, [keyword]);
                                if (matchedKeywords.length > 0) {
                                    const normalized = normalizeArticle(item, 'blogger');
                                    if (normalized) {
                                        const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
                                        batch.set(pendingAlertRef, { ...normalized, keywords: matchedKeywords, companyId, companyName, status: "pending" });
                                        existingUrls.add(item.url);
                                        articlesToSaveCount++;
                                    }
                                }
                            }
                        }
                    } catch (e) { functions.logger.error(`Erro Blogger (blogId: ${blogId}, keyword: ${keyword}):`, e.message); }
                }
            }
        }
    }


    // =======================================================================
    // PASSO 2: Busca em Feeds RSS de forma otimizada
    // =======================================================================
    const rssUrls = settings.rssUrl ? settings.rssUrl.split('\n').filter(url => url.trim() !== '') : [];
    if (rssUrls.length > 0) {
        functions.logger.info(`PASSO 2: Buscando em ${rssUrls.length} feeds RSS de forma otimizada...`);

        for (const rssUrl of rssUrls) {
            await delay(1500); // Pausa maior entre cada requisição de RSS
            let rssItems = [];
            try {
                functions.logger.log(`- Buscando feed: ${rssUrl}`);
                const queryUrl = `${RSS2JSON_URL}?rss_url=${encodeURIComponent(rssUrl)}`;
                const response = await axios.get(queryUrl);
                if (response.data && response.data.items) {
                    rssItems = response.data.items;
                }
            } catch (e) {
                functions.logger.error(`Erro ao buscar o feed RSS: ${rssUrl}. Status: ${e.response?.status}. Mensagem: ${e.message}`);
                continue; // Pula para o próximo feed se este falhar
            }

            if (rssItems.length > 0) {
                // Agora que temos os artigos, verificamos para cada empresa
                for (const company of allCompaniesData) {
                    for (const item of rssItems) {
                        // Aplica filtros de data e URLs duplicadas
                        if (company.fetchOnlyNew && new Date(item.pubDate) < twentyFourHoursAgo) continue;
                        if (company.existingUrls.has(item.link)) continue;

                        // Verifica se o artigo corresponde a alguma palavra-chave da empresa
                        const matchedKeywords = findMatchingKeywords(item, company.keywordsList);

                        if (matchedKeywords.length > 0) {
                            const normalized = normalizeArticle(item, 'rss');
                            if (normalized) {
                                const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
                                batch.set(pendingAlertRef, {
                                    ...normalized,
                                    keywords: matchedKeywords,
                                    companyId: company.companyId,
                                    companyName: company.companyName,
                                    status: "pending"
                                });
                                company.existingUrls.add(item.link); // Adiciona à lista para não duplicar nesta mesma execução
                                articlesToSaveCount++;
                            }
                        }
                    }
                }
            }
        }
    }
    
    if (articlesToSaveCount > 0) {
        await batch.commit();
    }
    functions.logger.info(`Busca concluída. ${articlesToSaveCount} novos artigos únicos foram guardados na fila de aprovação.`);
    functions.logger.info("=======================================");
    return { success: true, totalSaved: articlesToSaveCount };
}


// --- Funções Principais (Callable e Scheduled) ---

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


// --- Outras Funções ---

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