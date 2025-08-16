const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });
const { LanguageServiceClient } = require('@google-cloud/language');
const { PubSub } = require('@google-cloud/pubsub');

admin.initializeApp();
const db = admin.firestore();
const languageClient = new LanguageServiceClient();
const pubsub = new PubSub();

// --- Lógica Principal do Robô (com Multi-API e Análise de IA) ---
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

      if (!settingsDoc.exists() || keywordsSnapshot.empty) {
        logger.warn(`Configurações ou palavras-chave em falta para ${companyName}.`);
        return;
      }
      
      const settings = settingsDoc.data();
      const { apiKeyNewsApi, apiKeyGNews, apiKeyYoutube, apiKeyBlogger, bloggerId, searchScope = 'br', searchState = '', fetchOnlyNew = false } = settings;
      let newArticlesFoundForCompany = false;
      const keywords = keywordsSnapshot.docs.map(doc => doc.data().word);

      for (const originalKeyword of keywords) {
        let keyword = originalKeyword;
        
        if (searchScope === 'state' && searchState) {
            const states = {"AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins"};
            keyword = `${keyword} ${states[searchState] || ''}`;
        }
        
        const searchPromises = [];

        if (apiKeyNewsApi) { /* ... Lógica da NewsAPI ... */ }
        if (apiKeyGNews) { /* ... Lógica da GNews ... */ }
        if (apiKeyYoutube) { /* ... Lógica do YouTube ... */ }
        
        // Adiciona a busca no Blogger se a chave e o ID existirem
        if (apiKeyBlogger && bloggerId) {
            const url = `https://www.googleapis.com/blogger/v3/blogs/${bloggerId}/posts?key=${apiKeyBlogger}`;
            searchPromises.push(axios.get(url).then(res => {
                const posts = res.data.items || [];
                const matchedPosts = [];
                posts.forEach(post => {
                    const content = post.content.replace(/<[^>]*>?/gm, ''); // Remove HTML
                    if (post.title.toLowerCase().includes(originalKeyword.toLowerCase()) || content.toLowerCase().includes(originalKeyword.toLowerCase())) {
                        matchedPosts.push({
                            title: post.title,
                            description: content.substring(0, 200) + '...',
                            url: post.url,
                            source: { name: `Blogger - ${post.blog.name}` },
                            publishedAt: new Date(post.published),
                        });
                    }
                });
                return matchedPosts;
            }));
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

        if (fetchOnlyNew && allArticles.length > 0) {
            const articleIds = allArticles.map(article => Buffer.from(article.url).toString("base64").replace(/\//g, '_'));
            const existingDocs = await db.collection("companies").doc(companyId).collection("articles").where(admin.firestore.FieldPath.documentId(), 'in', articleIds).get();
            const existingIds = new Set(existingDocs.docs.map(doc => doc.id));
            allArticles = allArticles.filter(article => !existingIds.has(Buffer.from(article.url).toString("base64").replace(/\//g, '_')));
        }

        if (allArticles.length === 0) {
            logger.info(`Nenhum item novo encontrado para "${originalKeyword}".`);
            continue;
        }

        const batch = db.batch();
        for (const article of allArticles) {
            // ... (Lógica de Análise de Sentimento e Entidades) ...
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
        
        const topic = pubsub.topic('new-alerts');
        const message = {
            data: {
                companyId: companyId,
                companyName: companyName,
                timestamp: new Date().toISOString()
            }
        };
        await topic.publishMessage(message);
        logger.info(`Mensagem de notificação publicada no Pub/Sub para ${companyName}.`);
      }
    });

    await Promise.all(promises);
    logger.info("Robô de busca de notícias finalizado com sucesso.");
    return { success: true, message: "Busca de notícias finalizada com sucesso." };

  } catch (error) {
    logger.error("Erro geral na execução do robô de notícias:", error);
    throw new HttpsError('internal', 'Erro interno ao executar o robô.');
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
        throw new HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');
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
