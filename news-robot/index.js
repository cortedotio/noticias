const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });
const { LanguageServiceClient } = require('@google-cloud/language');

admin.initializeApp();
const db = admin.firestore();
const languageClient = new LanguageServiceClient();

// --- Lógica Principal do Robô (Refatorada para Multi-API) ---
const fetchAndStoreNews = async () => {
  logger.info("Iniciando o robô de busca de notícias...");

  try {
    const companiesSnapshot = await db.collection("companies").where("status", "==", "active").get();

    if (companiesSnapshot.empty) {
      logger.info("Nenhuma empresa ativa encontrada.");
      return { success: true, message: "Nenhuma empresa ativa encontrada." };
    }

    const promises = companiesSnapshot.docs.map(async (companyDoc) => {
      const companyId = companyDoc.id;
      const companyName = companyDoc.data().name;
      logger.info(`Buscando configurações para a empresa: ${companyName}`);

      const settingsRef = db.collection("settings").doc(companyId);
      const keywordsRef = db.collection("companies").doc(companyId).collection("keywords");

      const [settingsDoc, keywordsSnapshot] = await Promise.all([
        settingsRef.get(),
        keywordsRef.get(),
      ]);

      if (!settingsDoc.exists) {
        logger.warn(`Nenhuma configuração encontrada para ${companyName}.`);
        return;
      }

      if (keywordsSnapshot.empty) {
        logger.info(`Nenhuma palavra-chave encontrada para ${companyName}.`);
        return;
      }

      const settings = settingsDoc.data();
      const { apiKeyNewsApi, apiKeyGNews, apiKeyYoutube, searchScope = 'br', searchState = '' } = settings;
      let newArticlesFoundForCompany = false;

      for (const keywordDoc of keywordsSnapshot.docs) {
        let originalKeyword = keywordDoc.data().word;
        let keyword = originalKeyword;
        
        if (searchScope === 'state' && searchState) {
            const states = {"AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins"};
            keyword = `${keyword} ${states[searchState] || ''}`;
        }
        
        const searchPromises = [];

        // Adiciona a busca na NewsAPI se a chave existir
        if (apiKeyNewsApi) {
            let url;
            if (searchScope === 'international') {
                url = `https://newsapi.org/v2/everything?q="${encodeURIComponent(keyword)}"&language=pt&apiKey=${apiKeyNewsApi}`;
            } else {
                url = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(keyword)}&country=br&language=pt&apiKey=${apiKeyNewsApi}`;
            }
            searchPromises.push(axios.get(url).then(res => res.data.articles || []));
        }

        // Adiciona a busca na GNews se a chave existir
        if (apiKeyGNews) {
            const url = `https://gnews.io/api/v4/search?q="${encodeURIComponent(keyword)}"&lang=pt&country=br&max=10&apikey=${apiKeyGNews}`;
            searchPromises.push(axios.get(url).then(res => res.data.articles || []));
        }

        // Adiciona a busca no YouTube se a chave existir
        if (apiKeyYoutube) {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(keyword)}&type=video&order=date&maxResults=10&key=${apiKeyYoutube}`;
            searchPromises.push(axios.get(url).then(res => (res.data.items || []).map(item => ({
                title: item.snippet.title,
                description: item.snippet.description,
                url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                source: { name: `YouTube - ${item.snippet.channelTitle}` },
                publishedAt: new Date(item.snippet.publishedAt),
            }))));
        }

        if (searchPromises.length === 0) {
            logger.info(`Nenhuma chave de API configurada para a palavra-chave "${originalKeyword}" da empresa ${companyName}.`);
            continue;
        }

        const results = await Promise.allSettled(searchPromises);
        let allArticles = [];
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                allArticles = allArticles.concat(result.value);
            } else {
                logger.error(`Falha na busca da API ${index + 1} para "${originalKeyword}":`, result.reason.message);
            }
        });

        if (allArticles.length === 0) {
            logger.info(`Nenhum item novo encontrado para "${originalKeyword}".`);
            continue;
        }

        const batch = db.batch();
        for (const article of allArticles) {
            let sentiment = null;
            let entities = [];

            if (article.description || article.title) {
                const document = {
                    content: `${article.title}. ${article.description || ''}`,
                    type: 'PLAIN_TEXT',
                };
                try {
                    const [sentimentResult] = await languageClient.analyzeSentiment({ document });
                    sentiment = sentimentResult.documentSentiment;
                    
                    const [entitiesResult] = await languageClient.analyzeEntities({ document });
                    entities = (entitiesResult.entities || [])
                        .filter(e => e.type !== 'OTHER' && e.salience > 0.01)
                        .slice(0, 5)
                        .map(e => e.name);

                } catch (langError) {
                    logger.error("Erro na Natural Language API:", langError.message);
                }
            }

            const articleData = {
              title: article.title,
              description: article.description,
              url: article.url,
              source: { name: article.source.name, url: article.source.url || null },
              publishedAt: new Date(article.publishedAt),
              keyword: originalKeyword,
              companyId: companyId,
              sentiment: sentiment,
              entities: entities,
            };
            const articleId = Buffer.from(article.url).toString("base64");
            const articleRef = db.collection("companies").doc(companyId).collection("articles").doc(articleId);
            batch.set(articleRef, articleData, { merge: true });
        }
        await batch.commit();
        logger.info(`${allArticles.length} itens analisados e salvos para "${originalKeyword}".`);
        
        if (allArticles.length > 0) {
            newArticlesFoundForCompany = true;
        }
      }

      if (newArticlesFoundForCompany) {
        await settingsRef.set({ newAlerts: true }, { merge: true });
        logger.info(`Sinal de notificação ativado para ${companyName}.`);
      }
    });

    await Promise.all(promises);
    logger.info("Robô de busca de notícias finalizado com sucesso.");
    return { success: true, message: "Busca de notícias finalizada com sucesso." };

  } catch (error) {
    logger.error("Erro geral na execução do robô de notícias:", error);
    throw new functions.https.HttpsError('internal', 'Erro interno ao executar o robô.');
  }
};


// --- Trigger 1: Agendamento Automático ---
exports.scheduledFetch = onSchedule({
  schedule: "every 30 minutes",
  timeoutSeconds: 540,
  memory: "1GiB",
  region: "southamerica-east1"
}, async (event) => {
  return await fetchAndStoreNews();
});


// --- Trigger 2: Execução Manual (HTTP) ---
exports.manualFetch = onRequest({
    region: "southamerica-east1",
    timeoutSeconds: 540,
    memory: "1GiB",
}, (req, res) => {
    cors(req, res, async () => {
        try {
            const result = await fetchAndStoreNews();
            res.status(200).send(result);
        } catch (error) {
            logger.error("Erro na execução manual:", error);
            res.status(500).send({ success: false, message: "Ocorreu um erro." });
        }
    });
});

// --- Trigger 3: Excluir Empresa e Subcoleções ---
exports.deleteCompany = onCall({ region: "southamerica-east1" }, async (request) => {
    const companyId = request.data.companyId;
    if (!companyId) {
        throw new functions.https.HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');
    }

    logger.info(`Iniciando exclusão da empresa ${companyId} e seus dados...`);
    const companyRef = db.collection('companies').doc(companyId);

    const collections = ['articles', 'keywords', 'users'];
    for (const collection of collections) {
        const snapshot = await companyRef.collection(collection).get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        logger.info(`Subcoleção ${collection} da empresa ${companyId} excluída.`);
    }

    await db.collection('settings').doc(companyId).delete();
    logger.info(`Configurações da empresa ${companyId} excluídas.`);

    await companyRef.delete();
    logger.info(`Empresa ${companyId} excluída com sucesso.`);

    return { success: true, message: 'Empresa e todos os dados associados foram excluídos.' };
});
