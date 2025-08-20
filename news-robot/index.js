const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const logger = require("firebase-functions/logger");
const cors = require("cors")({ origin: true });
const { LanguageServiceClient } = require('@google-cloud/language');
const { SpeechClient } = require('@google-cloud/speech');
const { PubSub } = require('@google-cloud/pubsub');
const Parser = require('rss-parser');
const vision = require('@google-cloud/vision');
const video = require('@google-cloud/video-intelligence');

admin.initializeApp();
const db = admin.firestore();
const languageClient = new LanguageServiceClient();
const visionClient = new vision.ImageAnnotatorClient();
const videoClient = new video.VideoIntelligenceServiceClient();
const speechClient = new SpeechClient();
const pubsub = new PubSub();
const rssParser = new Parser();

// --- Lógica Principal do Robô (com Multi-API e Análise de IA) ---
const fetchAndStoreNews = async () => {
  logger.info("Iniciando o robô de busca de notícias...");

  try {
    // Busca as configurações globais primeiro (chaves de API, fontes)
    const globalSettingsDoc = await db.collection("settings").doc("global").get();
    if (!globalSettingsDoc.exists) {
        logger.error("Configurações globais não encontradas. Abortando.");
        return { success: false, message: "Configurações globais não encontradas." };
    }
    const globalSettings = globalSettingsDoc.data();
    const { apiKeyNewsApi, apiKeyGNews, apiKeyYoutube, apiKeyBlogger, bloggerId, rssUrl } = globalSettings;

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

      if (!settingsDoc.exists || keywordsSnapshot.empty) {
        logger.warn(`Configurações ou palavras-chave em falta para ${companyName}.`);
        return;
      }
      
      const settings = settingsDoc.data();
      const { searchScope = 'br', searchState = '', fetchOnlyNew = false } = settings;
      let newArticlesFoundForCompany = false;
      const keywords = keywordsSnapshot.docs.map(doc => doc.data().word);

      for (const originalKeyword of keywords) {
        let keyword = originalKeyword;
        
        if (searchScope === 'state' && searchState) {
            const states = {"AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas", "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul", "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná", "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina", "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins"};
            keyword = `${keyword} ${states[searchState] || ''}`;
        }
        
        const searchPromises = [];

        if (apiKeyNewsApi) {
            let url;
            if (searchScope === 'international') {
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
        
        if (apiKeyBlogger && bloggerId) {
            const bloggerIds = bloggerId.split('\n').filter(id => id.trim() !== '');
            bloggerIds.forEach(id => {
                const url = `https://www.googleapis.com/blogger/v3/blogs/${id.trim()}/posts?key=${apiKeyBlogger}`;
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
            });
        }
        
        if (rssUrl) {
            const rssUrls = rssUrl.split('\n').filter(url => url.trim() !== '');
            rssUrls.forEach(url => {
                searchPromises.push(rssParser.parseURL(url.trim()).then(feed => {
                    const matchedItems = [];
                    (feed.items || []).forEach(item => {
                        const content = item.contentSnippet || item.content || '';
                        if (item.title.toLowerCase().includes(originalKeyword.toLowerCase()) || content.toLowerCase().includes(originalKeyword.toLowerCase())) {
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
            let sentiment = null;
            let entities = [];
            let visionLabels = [];

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

            if (article.urlToImage) {
                try {
                    const [result] = await visionClient.labelDetection(article.urlToImage);
                    const labels = result.labelAnnotations;
                    visionLabels = labels.map(label => label.description);
                } catch (visionError) {
                    logger.error("Erro na Vision API:", visionError.message);
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
              visionLabels: visionLabels,
            };
            const articleId = Buffer.from(article.url).toString("base64").replace(/\//g, '_');
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

// --- Trigger 4: Excluir Palavra-Chave e Alertas Associados ---
exports.deleteKeyword = onCall({ region: "southamerica-east1" }, async (request) => {
    const { companyId, keywordId, keyword } = request.data;
    if (!companyId || !keywordId || !keyword) {
        throw new HttpsError('invalid-argument', 'Dados insuficientes para excluir a palavra-chave.');
    }

    logger.info(`Iniciando exclusão da palavra-chave ${keyword} para a empresa ${companyId}...`);
    
    // Exclui a palavra-chave
    const keywordRef = db.collection('companies').doc(companyId).collection('keywords').doc(keywordId);
    await keywordRef.delete();
    logger.info(`Palavra-chave ${keyword} excluída.`);

    // Exclui os alertas associados
    const articlesRef = db.collection('companies').doc(companyId).collection('articles');
    const articlesQuery = articlesRef.where('keyword', '==', keyword);
    const articlesSnapshot = await articlesQuery.get();
    
    if (articlesSnapshot.empty) {
        logger.info(`Nenhum alerta encontrado para a palavra-chave ${keyword}.`);
        return { success: true, message: 'Palavra-chave excluída com sucesso.' };
    }

    const batch = db.batch();
    articlesSnapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    logger.info(`${articlesSnapshot.size} alertas associados à palavra-chave ${keyword} foram excluídos.`);

    return { success: true, message: 'Palavra-chave e alertas associados foram excluídos com sucesso.' };
});

// --- Trigger 5: Transcrever Áudio com Speech-to-Text ---
exports.transcribeAudio = onCall({ region: "southamerica-east1" }, async (request) => {
    const { gcsUri } = request.data;
    if (!gcsUri) {
        throw new HttpsError('invalid-argument', 'O URI do Google Cloud Storage é obrigatório.');
    }

    logger.info(`Iniciando transcrição para o ficheiro: ${gcsUri}`);

    const audio = {
        uri: gcsUri,
    };
    const config = {
        encoding: 'MP3',
        sampleRateHertz: 16000,
        languageCode: 'pt-BR',
    };
    const requestSpec = {
        audio: audio,
        config: config,
    };

    try {
        const [operation] = await speechClient.longRunningRecognize(requestSpec);
        const [response] = await operation.promise();
        const transcription = response.results
            .map(result => result.alternatives[0].transcript)
            .join('\n');
        
        logger.info(`Transcrição concluída: ${transcription.substring(0, 100)}...`);
        return { success: true, transcription: transcription };

    } catch (error) {
        logger.error("Erro na API Speech-to-Text:", error);
        throw new HttpsError('internal', 'Erro ao transcrever o áudio.');
    }
});
