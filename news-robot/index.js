const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });
const { LanguageServiceClient } = require('@google-cloud/language');
const { PubSub } = require('@google-cloud/pubsub');
const Parser = require('rss-parser');
const { getStorage } = require("firebase-admin/storage");

admin.initializeApp();
const db = admin.firestore();
const storage = getStorage();
const languageClient = new LanguageServiceClient();
const pubsub = new PubSub();
const rssParser = new Parser();

// --- Lógica Principal do Robô (com Configurações Globais) ---
const fetchAndStoreNews = async () => {
  logger.info("Iniciando o robô de busca de notícias...");

  try {
    // Busca as configurações globais (chaves de API e fontes de notícias)
    const [globalApiKeysDoc, globalSourcesDoc] = await Promise.all([
      db.collection("global_settings").doc("api_keys").get(),
      db.collection("global_settings").doc("news_sources").get()
    ]);

    if (!globalApiKeysDoc.exists() && !globalSourcesDoc.exists()) {
      logger.error("Configurações globais não encontradas. Abortando.");
      return { success: false, message: "Configurações globais não encontradas." };
    }

    const apiKeys = globalApiKeysDoc.data() || {};
    const newsSources = globalSourcesDoc.data() || {};
    const { newsapi: apiKeyNewsApi, gnews: apiKeyGNews, youtube: apiKeyYoutube, blogger: apiKeyBlogger } = apiKeys;
    const { bloggerIds, rssUrls } = newsSources;

    const companiesSnapshot = await db.collection("companies").get();

    if (companiesSnapshot.empty) {
      logger.info("Nenhuma empresa encontrada.");
      return { success: true, message: "Nenhuma empresa encontrada." };
    }

    const promises = companiesSnapshot.docs.map(async (companyDoc) => {
      const companyId = companyDoc.id;
      const companyData = companyDoc.data();
      const companyName = companyData.name;
      const settings = companyData.settings || {};
      const { newsScope = 'br', state: searchState = '', fetchOnlyNew = false } = settings;

      logger.info(`Buscando configurações e palavras-chave para a empresa: ${companyName}`);

      const keywordsSnapshot = await db.collection("companies").doc(companyId).collection("keywords").get();

      if (keywordsSnapshot.empty) {
        logger.warn(`Palavras-chave em falta para ${companyName}.`);
        return;
      }

      let newArticlesFoundForCompany = false;
      const keywords = keywordsSnapshot.docs.map(doc => doc.data().text);

      for (const originalKeyword of keywords) {
        let keyword = originalKeyword;

        if (newsScope === 'state' && searchState) {
          const states = { "AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins" };
          keyword = `${keyword} ${states[searchState] || ''}`;
        }

        const searchPromises = [];

        if (apiKeyNewsApi) {
          let url;
          if (newsScope === 'international') {
            url = `https://newsapi.org/v2/everything?q="${encodeURIComponent(keyword)}"&language=pt&apiKey=${apiKeyNewsApi}`;
          } else {
            url = `https://newsapi.org/v2/top-headlines?q=${encodeURIComponent(keyword)}&country=br&language=pt&apiKey=${apiKeyNewsApi}`;
          }
          searchPromises.push(axios.get(url).then(res => res.data.articles || []));
        }

        if (apiKeyGNews) {
          const url = `https://gnews.io/api/v4/search?q="${encodeURIComponent(keyword)}"&lang=pt&country=br&max=10&apikey=${apiKeyGNews}`;
          searchPromises.push(axios.get(url).then(res => res.data.articles || []));
        }

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

        if (apiKeyBlogger && Array.isArray(bloggerIds) && bloggerIds.length > 0) {
          bloggerIds.forEach(id => {
            const url = `https://www.googleapis.com/blogger/v3/blogs/${id.trim()}/posts?key=${apiKeyBlogger}`;
            searchPromises.push(axios.get(url).then(res => {
              const posts = res.data.items || [];
              const matchedPosts = [];
              posts.forEach(post => {
                const content = post.content.replace(/<[^>]*>?/gm, '');
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
          });
        }

        if (Array.isArray(rssUrls) && rssUrls.length > 0) {
          rssUrls.forEach(url => {
            searchPromises.push(rssParser.parseURL(url.trim()).then(feed => {
              const matchedItems = [];
              (feed.items || []).forEach(item => {
                const content = item.contentSnippet || item.content || '';
                if (item.title && item.title.toLowerCase().includes(originalKeyword.toLowerCase()) || content.toLowerCase().includes(originalKeyword.toLowerCase())) {
                  matchedItems.push({
                    title: item.title,
                    description: content.substring(0, 200) + '...',
                    url: item.link,
                    source: { name: feed.title || 'Feed RSS' },
                    publishedAt: new Date(item.pubDate),
                  });
                }
              });
              return matchedItems;
            }));
          });
        }

        const results = await Promise.allSettled(searchPromises);
        let allArticles = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            allArticles = allArticles.concat(result.value);
          } else {
            logger.error(`Falha na busca da fonte ${index + 1} para "${originalKeyword}":`, result.reason.message);
          }
        });

        if (fetchOnlyNew && allArticles.length > 0) {
          const articleUrls = allArticles.map(article => article.url);
          const existingDocs = await db.collection("companies").doc(companyId).collection("articles").where('url', 'in', articleUrls).get();
          const existingUrls = new Set(existingDocs.docs.map(doc => doc.data().url));
          allArticles = allArticles.filter(article => !existingUrls.has(article.url));
        }

        if (allArticles.length === 0) {
          logger.info(`Nenhum item novo encontrado para "${originalKeyword}".`);
          continue;
        }

        const batch = db.batch();
        for (const article of allArticles) {
          const fullText = `${article.title || ''}. ${article.description || ''}`;
          let sentiment = { score: 0, magnitude: 0, label: 'neutro' };
          let entities = [];

          if (fullText.trim()) {
            const document = { content: fullText, type: 'PLAIN_TEXT', };
            try {
              const [sentimentResult] = await languageClient.analyzeSentiment({ document });
              const [entitiesResult] = await languageClient.analyzeEntities({ document });
              
              sentiment.score = sentimentResult.documentSentiment.score;
              sentiment.magnitude = sentimentResult.documentSentiment.magnitude;

              if (sentiment.score > 0.2) sentiment.label = 'positivo';
              else if (sentiment.score < -0.2) sentiment.label = 'negativo';
              else sentiment.label = 'neutro';

              entities = (entitiesResult.entities || [])
                .filter(e => e.type !== 'OTHER' && e.salience > 0.01)
                .slice(0, 5)
                .map(e => e.name);

            } catch (langError) {
              logger.error("Erro na Natural Language API:", langError.message);
            }
          }

          const articleData = {
            title: article.title || 'Sem título',
            description: article.description || 'Sem descrição',
            url: article.url,
            source: article.source.name,
            publishedAt: new Date(article.publishedAt),
            keywords: [originalKeyword],
            isRead: false,
            sentiment: sentiment.label,
            sentimentScore: sentiment.score,
            sentimentMagnitude: sentiment.magnitude,
            entities: entities,
          };
          const articleId = Buffer.from(article.url).toString("base64").replace(/\//g, '_').replace(/\./g, '-');
          const articleRef = db.collection("companies").doc(companyId).collection("articles").doc(articleId);
          batch.set(articleRef, articleData, { merge: true });
        }
        await batch.commit();
        logger.info(`${allArticles.length} itens analisados e salvos para "${originalKeyword}".`);
        newArticlesFoundForCompany = true;
      }

      if (newArticlesFoundForCompany) {
        logger.info(`Sinal de notificação ativado para ${companyName}.`);
        const topic = pubsub.topic('new-alerts');
        const message = {
          data: Buffer.from(JSON.stringify({ companyId, companyName, timestamp: new Date().toISOString() }))
        };
        await topic.publishMessage(message);
        logger.info(`Mensagem de notificação publicada no Pub/Sub para ${companyName}.`);
      }
    });

    await Promise.allSettled(promises);
    logger.info("Robô de busca de notícias finalizado com sucesso.");
    return { success: true, message: "Busca de notícias finalizada com sucesso." };

  } catch (error) {
    logger.error("Erro geral na execução do robô de notícias:", error);
    throw new HttpsError('internal', 'Erro interno ao executar o robô.');
  }
};


// --- Trigger 1: Agendamento Automático (a cada 30 minutos) ---
exports.scheduledFetch = onSchedule({
  schedule: "every 30 minutes",
  timeoutSeconds: 540,
  memory: "1GiB",
  region: "southamerica-east1"
}, async (event) => {
  return await fetchAndStoreNews();
});


// --- Trigger 2: Execução Manual (chamável do frontend) ---
exports.triggerRobo = onCall({
  region: "southamerica-east1",
  timeoutSeconds: 540,
  memory: "1GiB",
}, async (request) => {
  if (request.auth.token.role !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Apenas super administradores podem disparar esta função.');
  }
  return await fetchAndStoreNews();
});

// --- Trigger 3: Excluir Empresa e Subcoleções ---
exports.deleteCompany = onCall({ region: "southamerica-east1" }, async (request) => {
  const companyId = request.data.companyId;
  if (!companyId) {
    throw new HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');
  }

  logger.info(`Iniciando exclusão da empresa ${companyId} e seus dados...`);
  const companyRef = db.collection('companies').doc(companyId);

  // Excluir subcoleções de forma recursiva
  const deleteCollection = async (collectionRef) => {
    const batchSize = 500;
    const query = collectionRef.limit(batchSize);
    return new Promise((resolve, reject) => {
      deleteQueryBatch(query, resolve).catch(reject);
    });
  };

  const deleteQueryBatch = async (query, resolve) => {
    const snapshot = await query.get();
    if (snapshot.size === 0) { resolve(); return; }

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    process.nextTick(() => {
      deleteQueryBatch(query, resolve);
    });
  };

  const collections = ['articles', 'keywords', 'users'];
  for (const collection of collections) {
    await deleteCollection(companyRef.collection(collection));
    logger.info(`Subcoleção ${collection} da empresa ${companyId} excluída.`);
  }

  // Excluir logo do Storage
  const logoRef = storage.bucket().file(`logos/${companyId}`);
  try {
    await logoRef.delete();
    logger.info(`Logo da empresa ${companyId} excluída.`);
  } catch (error) {
    if (error.code === 404) {
      logger.info(`Logo para a empresa ${companyId} não encontrada. Ignorando.`);
    } else {
      logger.error(`Erro ao excluir logo da empresa ${companyId}:`, error);
    }
  }

  await companyRef.delete();
  logger.info(`Empresa ${companyId} excluída com sucesso.`);

  return { success: true, message: 'Empresa e todos os dados associados foram excluídos.' };
});