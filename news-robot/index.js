const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// --- Lógica Principal do Robô (Refatorada) ---
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

      const settings = settingsDoc.data();
      const apiKey = settings.apiKey;
      const apiProvider = settings.apiProvider || 'newsapi';
      const searchScope = settings.searchScope || 'br';
      const searchState = settings.searchState || '';

      if (!apiKey) {
        logger.warn(`Nenhuma chave de API configurada para ${companyName}.`);
        return;
      }

      if (keywordsSnapshot.empty) {
        logger.info(`Nenhuma palavra-chave encontrada para ${companyName}.`);
        return;
      }

      let newArticlesFoundForCompany = false;

      for (const keywordDoc of keywordsSnapshot.docs) {
        let keyword = keywordDoc.data().word;
        
        if (searchScope === 'state' && searchState) {
            const states = {"AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins"};
            keyword = `${keyword} ${states[searchState] || ''}`;
        }
        
        logger.info(`Buscando notícias para "${keyword}" da empresa ${companyName} via ${apiProvider}...`);
        
        let url;
        let articles = [];

        try {
            if (apiProvider === 'youtube') {
                url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(keyword)}&type=video&order=date&maxResults=10&key=${apiKey}`;
                const response = await axios.get(url);
                // Adapta a resposta do YouTube para o nosso formato
                articles = (response.data.items || []).map(item => ({
                    title: item.snippet.title,
                    description: item.snippet.description,
                    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                    source: { name: item.snippet.channelTitle, url: `https://www.youtube.com/channel/${item.snippet.channelId}` },
                    publishedAt: new Date(item.snippet.publishedAt),
                }));
            } else if (apiProvider === 'gnews') {
                url = `https://gnews.io/api/v4/search?q="${encodeURIComponent(keyword)}"&lang=pt&country=br&max=10&apikey=${apiKey}`;
                const response = await axios.get(url);
                articles = response.data.articles || [];
            } else { // Padrão é newsapi
                if (searchScope === 'international') {
                    url = `https://newsapi.org/v2/everything?q="${encodeURIComponent(keyword)}"&language=pt&apiKey=${apiKey}`;
                } else {
                    url = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(keyword)}&country=br&language=pt&apiKey=${apiKey}`;
                }
                const response = await axios.get(url);
                articles = response.data.articles || [];
            }

            if (articles.length === 0) {
                logger.info(`Nenhum item novo encontrado para "${keyword}".`);
                continue;
            }

            const batch = db.batch();
            articles.forEach((article) => {
                const articleData = {
                  title: article.title,
                  description: article.description,
                  url: article.url,
                  source: { name: article.source.name, url: article.source.url || null },
                  publishedAt: new Date(article.publishedAt),
                  keyword: keywordDoc.data().word, // Salva a palavra-chave original
                  companyId: companyId,
                };
                const articleId = Buffer.from(article.url).toString("base64");
                const articleRef = db.collection("companies").doc(companyId).collection("articles").doc(articleId);
                batch.set(articleRef, articleData, { merge: true });
            });

            await batch.commit();
            logger.info(`${articles.length} itens salvos para "${keyword}".`);
            
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
