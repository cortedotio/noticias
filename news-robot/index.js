/**
 * Ficheiro: index.js
 * Descrição: Firebase Cloud Functions (2ª Geração) para o backend do projeto Aurora Clipping.
 * Funcionalidades:
 * 1. Robô agendado e manual para recolha e análise de notícias da GNews.
 * 2. Análise de imagens com a Cloud Vision API.
 * 3. Análise de vídeos com a Video Intelligence API.
 * 4. Análise de sentimento com a Natural Language API.
 * 5. Função para apagar empresas e todos os seus dados associados.
 * 6. Funções para gestão de alertas (inserção manual, pedidos de exclusão, etc.).
 */

// Importação dos módulos da 2ª Geração
const { onCall, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");

// Importação dos módulos necessários
const admin = require("firebase-admin");
const axios = require("axios");

// Importação dos clientes das APIs de Inteligência Artificial da Google
const { ImageAnnotatorClient } = require("@google-cloud/vision");
const { VideoIntelligenceServiceClient } = require("@google-cloud/video-intelligence");
const { LanguageServiceClient } = require("@google-cloud/language");

// Inicialização do Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// --- FUNÇÕES AUXILIARES DO ROBÔ ---

/**
 * Seleciona a chave de API correta da GNews com base na hora atual.
 * @param {object} globalSettings - As configurações globais com as chaves de API.
 * @returns {string|null} A chave de API ou nulo se não for encontrada.
 */
function getGNewsApiKey(globalSettings) {
    const currentHour = new Date().getHours();
    if (currentHour >= 0 && currentHour < 6) return globalSettings.apiKeyGNews1;
    if (currentHour >= 6 && currentHour < 12) return globalSettings.apiKeyGNews2;
    if (currentHour >= 12 && currentHour < 18) return globalSettings.apiKeyGNews3;
    return globalSettings.apiKeyGNews4; // 18:00 - 23:59
}

/**
 * Busca artigos na API da GNews.
 * @param {string[]} keywords - Lista de palavras-chave a pesquisar.
 * @param {string} apiKey - A chave de API da GNews a ser usada.
 * @param {string} searchScope - O escopo da pesquisa ('br', 'international').
 * @returns {Promise<object[]>} Uma lista de artigos formatados.
 */
async function buscarArtigosGNews(keywords, apiKey, searchScope) {
    if (!apiKey) {
        logger.warn("Nenhuma chave de API da GNews encontrada para o horário atual.");
        return [];
    }

    const query = keywords.map(k => `"${k}"`).join(" OR ");
    let url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&token=${apiKey}&lang=pt`;

    if (searchScope === 'br' || searchScope === 'state') {
        url += '&country=br';
    }

    try {
        const response = await axios.get(url);
        if (response.data && response.data.articles) {
            return response.data.articles.map(article => ({
                title: article.title,
                description: article.description,
                url: article.url,
                source: { name: article.source.name },
                publishedAt: new Date(article.publishedAt),
                imageUrl: article.image,
                keyword: keywords.find(k => 
                    article.title.toLowerCase().includes(k.toLowerCase()) || 
                    article.description.toLowerCase().includes(k.toLowerCase())
                ) || keywords[0],
            }));
        }
        return [];
    } catch (error) {
        logger.error("Erro ao buscar notícias da GNews API:", error.response ? error.response.data : error.message);
        return [];
    }
}

// --- LÓGICA PRINCIPAL DO ROBÔ DE NOTÍCIAS ---

/**
 * Função principal que busca e processa notícias para todas as empresas ativas.
 */
async function executarRoboDeNoticias() {
    logger.info("Iniciando execução do robô de notícias.");

    const visionClient = new ImageAnnotatorClient();
    const videoClient = new VideoIntelligenceServiceClient();
    const languageClient = new LanguageServiceClient();

    const globalSettingsDoc = await db.collection("settings").doc("global").get();
    if (!globalSettingsDoc.exists) {
        logger.error("Configurações globais (chaves de API, fontes) não encontradas.");
        return;
    }
    const globalSettings = globalSettingsDoc.data();

    const companiesSnapshot = await db.collection("companies").where("status", "==", "active").get();
    if (companiesSnapshot.empty) {
        logger.info("Nenhuma empresa ativa encontrada para processar.");
        return;
    }

    const processamentoPromises = companiesSnapshot.docs.map(async (companyDoc) => {
        const companyId = companyDoc.id;
        const companyData = companyDoc.data();
        logger.info(`Processando empresa: ${companyData.name} (${companyId})`);

        const keywordsSnapshot = await db.collection("companies").doc(companyId).collection("keywords").get();
        const keywords = keywordsSnapshot.docs.map(doc => doc.data().word);

        if (keywords.length === 0) {
            logger.warn(`Nenhuma palavra-chave para a empresa ${companyData.name}.`);
            return;
        }

        const settingsDoc = await db.collection("settings").doc(companyId).get();
        const companySettings = settingsDoc.exists() ? settingsDoc.data() : {};
        
        const gnewsApiKey = getGNewsApiKey(globalSettings);
        const artigosEncontrados = await buscarArtigosGNews(keywords, gnewsApiKey, companySettings.searchScope);

        if (artigosEncontrados.length === 0) {
            logger.info(`Nenhum artigo novo encontrado para ${companyData.name}.`);
            return;
        }

        let novosAlertasContador = 0;

        for (const artigo of artigosEncontrados) {
            try {
                const textContent = `${artigo.title}. ${artigo.description}`;
                const [sentimentResult] = await languageClient.analyzeSentiment({
                    document: { content: textContent, type: 'PLAIN_TEXT' },
                });
                artigo.sentiment = {
                    score: sentimentResult.documentSentiment.score,
                    magnitude: sentimentResult.documentSentiment.magnitude,
                };
            } catch (error) {
                logger.error(`Erro na API Natural Language:`, error.message);
            }

            if (artigo.imageUrl) {
                try {
                    const [result] = await visionClient.labelDetection(artigo.imageUrl);
                    artigo.tagsDeImagem = result.labelAnnotations.map(label => label.description);
                } catch (error) {
                    logger.error(`Erro na API Vision para a imagem ${artigo.imageUrl}:`, error.message);
                }
            }
            
            await db.collection("companies").doc(companyId).collection("articles").add({
                ...artigo,
                publishedAt: admin.firestore.Timestamp.fromDate(new Date(artigo.publishedAt)),
            });
            novosAlertasContador++;
        }

        if (novosAlertasContador > 0) {
            const settingsRef = db.collection("settings").doc(companyId);
            await settingsRef.set({
                newAlerts: true,
                newAlertsCount: admin.firestore.FieldValue.increment(novosAlertasContador)
            }, { merge: true });
            logger.info(`${novosAlertasContador} novos alertas adicionados para ${companyData.name}.`);
        }
    });

    await Promise.all(processamentoPromises);
    logger.info("Execução do robô de notícias finalizada.");
}

// --- CLOUD FUNCTIONS EXPOSTAS ---

// 1. Função acionada manualmente
exports.manualFetch = onRequest({ region: "southamerica-east1" }, async (req, res) => {
    logger.info("Acionamento manual recebido.");
    try {
        await executarRoboDeNoticias();
        res.status(200).json({ success: true, message: "Robô executado com sucesso." });
    } catch (error) {
        logger.error("Erro na execução manual do robô:", error);
        res.status(500).json({ success: false, message: "Ocorreu um erro no servidor." });
    }
});

// 2. Função agendada
exports.scheduledFetch = onSchedule({ region: "southamerica-east1", schedule: "every 30 minutes" }, async (event) => {
    logger.info("Execução agendada do robô iniciada.");
    try {
        await executarRoboDeNoticias();
    } catch (error) {
        logger.error("Erro na execução agendada do robô:", error);
    }
    return null;
});

// 3. Função para apagar uma empresa
exports.deleteCompany = onCall({ region: "southamerica-east1" }, async (request) => {
    const companyId = request.data.companyId;
    if (!companyId) {
        throw new functions.https.HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');
    }

    logger.info(`Iniciando exclusão da empresa: ${companyId}`);
    
    await deleteCollection(db, `companies/${companyId}/users`, 100);
    await deleteCollection(db, `companies/${companyId}/keywords`, 100);
    await deleteCollection(db, `companies/${companyId}/articles`, 100);
    await db.collection("settings").doc(companyId).delete();
    await db.collection("companies").doc(companyId).delete();

    logger.info(`Empresa ${companyId} excluída com sucesso.`);
    return { success: true, message: "Empresa e dados associados foram excluídos." };
});

// --- NOVAS FUNÇÕES PARA SUPER ADMIN ---

exports.manualAddAlert = onCall({ region: "southamerica-east1" }, async (request) => {
    const { companyId, title, description, url, source, keyword } = request.data;
    if (!companyId || !title || !url || !source || !keyword) {
        throw new functions.https.HttpsError('invalid-argument', 'Todos os campos são obrigatórios.');
    }
    const newAlert = {
        title, description, url, source: { name: source }, keyword,
        publishedAt: admin.firestore.Timestamp.now(),
        isManual: true,
    };
    await db.collection("companies").doc(companyId).collection("articles").add(newAlert);
    return { success: true, message: "Alerta inserido manualmente." };
});

exports.requestAlertDeletion = onCall({ region: "southamerica-east1" }, async (request) => {
    const { companyId, companyName, articleId, articleTitle, justification } = request.data;
    if (!companyId || !articleId || !justification) {
        throw new functions.https.HttpsError('invalid-argument', 'Faltam dados para a solicitação.');
    }
    await db.collection("deletionRequests").add({
        companyId, companyName, articleId, articleTitle, justification,
        status: 'pending',
        requestedAt: admin.firestore.Timestamp.now()
    });
    return { success: true, message: "Solicitação de exclusão enviada." };
});

exports.manageDeletionRequest = onCall({ region: "southamerica-east1" }, async (request) => {
    const { requestId, approve } = request.data;
    if (!requestId) throw new functions.https.HttpsError('invalid-argument', 'ID da solicitação é obrigatório.');
    
    const requestRef = db.collection("deletionRequests").doc(requestId);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) throw new functions.https.HttpsError('not-found', 'Solicitação não encontrada.');
    
    if (approve) {
        const { companyId, articleId } = requestDoc.data();
        await db.collection("companies").doc(companyId).collection("articles").doc(articleId).delete();
        await requestRef.update({ status: 'approved' });
        return { success: true, message: "Solicitação aprovada e alerta excluído." };
    } else {
        await requestRef.update({ status: 'denied' });
        return { success: true, message: "Solicitação negada." };
    }
});

exports.deleteKeywordAndArticles = onCall({ region: "southamerica-east1" }, async (request) => {
    const { companyId, keyword } = request.data;
    if (!companyId || !keyword) throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos.');

    const keywordQuery = db.collection(`companies/${companyId}/keywords`).where("word", "==", keyword);
    const keywordSnapshot = await keywordQuery.get();
    const batch = db.batch();
    keywordSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    const articlesQuery = db.collection(`companies/${companyId}/articles`).where("keyword", "==", keyword);
    await deleteCollection(db, articlesQuery, 100);

    await batch.commit();
    return { success: true, message: "Palavra-chave e alertas associados foram excluídos." };
});

exports.generateSuperAdminReport = onCall({ region: "southamerica-east1" }, async (request) => {
    const companiesSnapshot = await db.collection("companies").get();
    const reportData = [];

    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyData = companyDoc.data();
        const articlesSnapshot = await db.collection(`companies/${companyId}/articles`).get();
        
        if (articlesSnapshot.empty) continue;

        const articles = articlesSnapshot.docs.map(doc => doc.data());
        const totalAlerts = articles.length;

        const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
        articles.forEach(art => {
            if (art.sentiment) {
                if (art.sentiment.score > 0.2) sentimentCounts.positive++;
                else if (art.sentiment.score < -0.2) sentimentCounts.negative++;
                else sentimentCounts.neutral++;
            } else sentimentCounts.neutral++;
        });

        const predominantSentiment = Object.keys(sentimentCounts).reduce((a, b) => sentimentCounts[a] > sentimentCounts[b] ? a : b);

        const channelCounts = articles.reduce((acc, art) => {
            const channel = (art.source.name || "").toLowerCase().includes('youtube') ? 'YouTube' : 'Sites/Outros';
            acc[channel] = (acc[channel] || 0) + 1;
            return acc;
        }, {});
        const topChannel = Object.keys(channelCounts).reduce((a, b) => channelCounts[a] > channelCounts[b] ? a : b, 'N/A');

        const vehicleCounts = articles.reduce((acc, art) => {
            acc[art.source.name] = (acc[art.source.name] || 0) + 1;
            return acc;
        }, {});
        const topVehicle = Object.keys(vehicleCounts).reduce((a, b) => vehicleCounts[a] > vehicleCounts[b] ? a : b, 'N/A');

        reportData.push({
            companyName: companyData.name,
            totalAlerts,
            sentimentPercentage: {
                positive: ((sentimentCounts.positive / totalAlerts) * 100).toFixed(1),
                neutral: ((sentimentCounts.neutral / totalAlerts) * 100).toFixed(1),
                negative: ((sentimentCounts.negative / totalAlerts) * 100).toFixed(1),
            },
            predominantSentiment,
            topChannel,
            topVehicle
        });
    }
    return reportData;
});

/**
 * Função auxiliar para apagar uma coleção ou query em lotes.
 */
async function deleteCollection(db, collectionRefOrQuery, batchSize) {
    const query = collectionRefOrQuery.limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(db, query, resolve) {
    const snapshot = await query.get();
    if (snapshot.size === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}
