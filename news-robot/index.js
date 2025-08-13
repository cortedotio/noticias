const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true }); // Adiciona o CORS

admin.initializeApp();
const db = admin.firestore();

// --- Lógica Principal do Robô (Refatorada) ---
// Esta função contém toda a lógica de busca e salvamento de notícias.
const fetchAndStoreNews = async () => {
  logger.info("Iniciando o robô de busca de notícias (Google News via NewsAPI)...");

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

      const settings = settingsDoc.data();
      const apiKey = settings.apiKey;

      if (!apiKey) {
        logger.warn(`Nenhuma chave de API (NewsAPI.org) configurada para ${companyName}.`);
        return;
      }

      if (keywordsSnapshot.empty) {
        logger.info(`Nenhuma palavra-chave encontrada para ${companyName}.`);
        return;
      }

      let newArticlesFoundForCompany = false;

      for (const keywordDoc of keywordsSnapshot.docs) {
        const keyword = keywordDoc.data().word;
        logger.info(`Buscando notícias para "${keyword}" da empresa ${companyName}...`);

        const url = `https://newsapi.org/v2/everything?q="${encodeURIComponent(keyword)}"&sources=google-news-br&language=pt&apiKey=${apiKey}`;

        try {
          const response = await axios.get(url);
          const articles = response.data.articles || [];

          if (articles.length === 0) {
            logger.info(`Nenhum artigo novo encontrado para "${keyword}".`);
            continue;
          }

          const batch = db.batch();
          articles.forEach((article) => {
            const articleData = {
              title: article.title,
              description: article.description,
              url: article.url,
              source: { name: article.source.name, url: null },
              publishedAt: new Date(article.publishedAt),
              keyword: keyword,
              companyId: companyId,
            };
            const articleId = Buffer.from(article.url).toString("base64");
            const articleRef = db.collection("companies").doc(companyId).collection("articles").doc(articleId);
            batch.set(articleRef, articleData, { merge: true });
          });

          await batch.commit();
          logger.info(`${articles.length} artigos salvos para "${keyword}".`);
          
          if (articles.length > 0) {
            newArticlesFoundForCompany = true;
          }

        } catch (apiError) {
          logger.error(`Erro ao buscar notícias para a palavra-chave "${keyword}":`, apiError.response ? apiError.response.data : apiError.message);
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
// Esta função é executada a cada 30 minutos.
exports.scheduledFetch = onSchedule({
  schedule: "every 30 minutes",
  timeoutSeconds: 540,
  memory: "1GiB",
  region: "southamerica-east1"
}, async (event) => {
  return await fetchAndStoreNews();
});


// --- Trigger 2: Execução Manual (HTTP) ---
// Esta função pode ser chamada a qualquer momento através de um URL.
exports.manualFetch = onRequest({
    region: "southamerica-east1",
    timeoutSeconds: 540,
    memory: "1GiB",
}, (req, res) => {
    // Usa o middleware do CORS para permitir pedidos do seu site
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
