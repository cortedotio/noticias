const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// Esta função será executada automaticamente a cada 30 minutos.
exports.fetchNewsRobot = functions.runWith({ timeoutSeconds: 300, memory: "1GB" }).pubsub.schedule("every 30 minutes").onRun(async (context) => {
  console.log("Iniciando o robô de busca de notícias (Google News via NewsAPI)...");

  try {
    const companiesSnapshot = await db.collection("companies").where("status", "==", "active").get();

    if (companiesSnapshot.empty) {
      console.log("Nenhuma empresa ativa encontrada.");
      return null;
    }

    const promises = companiesSnapshot.docs.map(async (companyDoc) => {
      const companyId = companyDoc.id;
      const companyName = companyDoc.data().name;
      console.log(`Buscando configurações para a empresa: ${companyName}`);

      const settingsRef = db.collection("settings").doc(companyId);
      const keywordsRef = db.collection("companies").doc(companyId).collection("keywords");

      const [settingsDoc, keywordsSnapshot] = await Promise.all([
        settingsRef.get(),
        keywordsRef.get(),
      ]);

      if (!settingsDoc.exists) {
        console.log(`Nenhuma configuração encontrada para ${companyName}.`);
        return;
      }

      const settings = settingsDoc.data();
      const apiKey = settings.apiKey;

      if (!apiKey) {
        console.log(`Nenhuma chave de API (NewsAPI.org) configurada para ${companyName}.`);
        return;
      }

      if (keywordsSnapshot.empty) {
        console.log(`Nenhuma palavra-chave encontrada para ${companyName}.`);
        return;
      }

      let newArticlesFoundForCompany = false;

      for (const keywordDoc of keywordsSnapshot.docs) {
        const keyword = keywordDoc.data().word;
        console.log(`Buscando notícias para "${keyword}" da empresa ${companyName}...`);

        const url = `https://newsapi.org/v2/everything?q="${encodeURIComponent(keyword)}"&sources=google-news-br&language=pt&apiKey=${apiKey}`;

        try {
          const response = await axios.get(url);
          const articles = response.data.articles || [];

          if (articles.length === 0) {
            console.log(`Nenhum artigo novo encontrado para "${keyword}".`);
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
          console.log(`${articles.length} artigos salvos para "${keyword}".`);
          
          if (articles.length > 0) {
            newArticlesFoundForCompany = true;
          }

        } catch (apiError) {
          console.error(`Erro ao buscar notícias para a palavra-chave "${keyword}":`, apiError.response ? apiError.response.data : apiError.message);
        }
      }

      // *** LINHA DE CÓDIGO ADICIONADA ***
      // Se encontrámos novos artigos para esta empresa, ativamos a notificação.
      if (newArticlesFoundForCompany) {
        await settingsRef.set({ newAlerts: true }, { merge: true });
        console.log(`Sinal de notificação ativado para ${companyName}.`);
      }
    });

    await Promise.all(promises);
    console.log("Robô de busca de notícias finalizado com sucesso.");
    return null;

  } catch (error) {
    console.error("Erro geral na execução do robô de notícias:", error);
    return null;
  }
});
