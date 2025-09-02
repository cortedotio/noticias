/**
 * IMPORTANTE: Este é o código COMPLETO e ATUALIZADO para o servidor (Firebase Cloud Functions).
 * Ele deve substituir o conteúdo do arquivo `index.js` no seu projeto Firebase.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");
// Importante: certifique-se de ter o 'axios' no seu package.json. Se não tiver, use 'node-fetch'.
const axios = require("axios"); 

admin.initializeApp();
const db = admin.firestore();

const GNEWS_URL = "https://gnews.io/api/v4/search";
const APP_ID = "noticias-6e952";

// Funções auxiliares (sem alterações)
async function deleteCollection(collectionRef) {
  const snapshot = await collectionRef.get();
  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    batch.delete(doc.ref);
  });
  await batch.commit();
}

function getChannelCategory(sourceName) {
    const name = sourceName.toLowerCase();
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

const findMatchingKeyword = (article, keywords) => {
  const title = (article.title || "").toLowerCase();
  const description = (article.description || "").toLowerCase();
  return keywords.find(kw => title.includes(kw.toLowerCase()) || description.includes(kw.toLowerCase())) || keywords[0];
};


// Cloud Functions (com a `manualFetch` atualizada para depuração)

exports.approveAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) {
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários.");
    }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    const pendingAlertDoc = await pendingAlertRef.get();
    if (!pendingAlertDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Alerta pendente não encontrado.");
    }
    const alertData = pendingAlertDoc.data();
    if (!alertData) {
      throw new functions.https.HttpsError("internal", "Dados do alerta estão corrompidos.");
    }
    const companyId = alertData.companyId;
    await db.collection(`artifacts/${appId}/users/${companyId}/articles`).add({
      ...alertData,
      status: "approved",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await pendingAlertRef.delete();
    const settingsRef = db.doc(`artifacts/${appId}/public/data/settings/${companyId}`);
    await db.runTransaction(async (transaction) => {
      const settingsDoc = await transaction.get(settingsRef);
      const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
      transaction.set(settingsRef, { newAlertsCount }, { merge: true });
    });
    return { success: true };
  });

exports.rejectAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) {
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários.");
    }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    await pendingAlertRef.delete();
    return { success: true };
  });

exports.deleteCompany = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId } = data;
    if (!appId || !companyId) {
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da empresa são necessários.");
    }
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

exports.deleteKeywordAndArticles = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, keyword } = data;
    if (!appId || !companyId || !keyword) {
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação, da empresa e a palavra-chave são necessários.");
    }
    const articlesToDelete = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).where("keyword", "==", keyword).get();
    const batch = db.batch();
    articlesToDelete.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    const keywordRef = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).where("word", "==", keyword).get();
    if (!keywordRef.empty) {
      await db.doc(`artifacts/${appId}/users/${companyId}/keywords/${keywordRef.docs[0].id}`).delete();
    }
    return { success: true };
  });

exports.manageDeletionRequest = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, requestId, approve } = data;
    if (!appId || !requestId) {
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da solicitação são necessários.");
    }
    const requestRef = db.doc(`artifacts/${appId}/public/data/deletionRequests/${requestId}`);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Solicitação de exclusão não encontrada.");
    }
    const requestData = requestDoc.data();
    if (!requestData) {
      throw new functions.https.HttpsError("internal", "Dados da solicitação estão corrompidos.");
    }
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

exports.requestAlertDeletion = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, companyName, articleId, articleTitle, justification } = data;
    if (!appId || !companyId || !articleId || !justification) {
      throw new functions.https.HttpsError("invalid-argument", "Informações incompletas para a solicitação de exclusão.");
    }
    await db.collection(`artifacts/${appId}/public/data/deletionRequests`).add({
      companyId,
      companyName,
      articleId,
      articleTitle,
      justification,
      status: "pending",
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const articleRef = db.doc(`artifacts/${appId}/users/${companyId}/articles/${articleId}`);
    await articleRef.update({ deletionRequestStatus: 'pending' });
    return { success: true };
  });

exports.manualAddAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, title, description, url, source, keyword } = data;
    if (!appId || !companyId || !title || !url || !source || !keyword) {
      throw new functions.https.HttpsError("invalid-argument", "Dados incompletos para adicionar um alerta.");
    }
    const companyDoc = await db.doc(`artifacts/${appId}/public/data/companies/${companyId}`).get();
    if (!companyDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Empresa não encontrada.");
    }
    const companyName = companyDoc.data()?.name;
    const alertData = {
      title,
      description,
      url,
      source: { name: source, url: "" },
      publishedAt: admin.firestore.FieldValue.serverTimestamp(),
      keyword,
      companyId,
      companyName,
      status: "approved",
    };
    await db.collection(`artifacts/${appId}/users/${companyId}/articles`).add(alertData);
    const settingsRef = db.doc(`artifacts/${appId}/public/data/settings/${companyId}`);
    await db.runTransaction(async (transaction) => {
      const settingsDoc = await transaction.get(settingsRef);
      const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
      transaction.set(settingsRef, { newAlertsCount }, { merge: true });
    });
    return { success: true };
  });

exports.generateSuperAdminReport = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId } = data;
    if (!appId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }
    const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
    const reportData = [];
    for (const companyDoc of companiesSnapshot.docs) {
      const companyId = companyDoc.id;
      const companyName = companyDoc.data().name;
      const articlesSnapshot = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).get();
      const totalAlerts = articlesSnapshot.size;
      let positiveCount = 0;
      let neutralCount = 0;
      let negativeCount = 0;
      const channelCounts = {};
      const vehicleCounts = {};
      articlesSnapshot.docs.forEach(doc => {
        const article = doc.data();
        const score = article.sentiment?.score || 0;
        if (score > 0.2) positiveCount++;
        else if (score < -0.2) negativeCount++;
        else neutralCount++;
        const channel = article.source?.name ? getChannelCategory(article.source.name) : 'Outros';
        channelCounts[channel] = (channelCounts[channel] || 0) + 1;
        const vehicle = article.source?.name || 'Outros';
        vehicleCounts[vehicle] = (vehicleCounts[vehicle] || 0) + 1;
      });
      const totalSentiments = positiveCount + neutralCount + negativeCount;
      const sentimentPercentage = {
        positive: totalSentiments > 0 ? parseFloat((positiveCount / totalSentiments * 100).toFixed(2)) : 0,
        neutral: totalSentiments > 0 ? parseFloat((neutralCount / totalSentiments * 100).toFixed(2)) : 0,
        negative: totalSentiments > 0 ? parseFloat((negativeCount / totalSentiments * 100).toFixed(2)) : 0,
      };
      const predominantSentiment = getPredominantSentiment(sentimentPercentage);
      const topChannel = getTopCount(channelCounts);
      const topVehicle = getTopCount(vehicleCounts);
      reportData.push({ companyName, totalAlerts, sentimentPercentage, predominantSentiment, topChannel, topVehicle });
    }
    return reportData;
  });

// =============================================================================================
// FUNÇÃO MANUALFETCH ATUALIZADA COM LOGS PARA DEPURAÇÃO
// =============================================================================================
exports.manualFetch = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    functions.logger.info("=======================================");
    functions.logger.info("INICIANDO BUSCA MANUAL DE NOTÍCIAS (VERSÃO DE DEPURAÇÃO)...");
    
    const { appId } = data;
    if (!appId) {
      functions.logger.error("ERRO CRÍTICO: O ID da aplicação é necessário.");
      throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }

    try {
      const globalSettingsRef = db.doc(`artifacts/${appId}/public/data/settings/global`);
      const globalSettingsDoc = await globalSettingsRef.get();
      if (!globalSettingsDoc.exists) {
        throw new Error("Configurações globais não encontradas.");
      }
      const settings = globalSettingsDoc.data();
      
      const currentHour = new Date().getHours();
      let currentApiKey = '';
      if (currentHour >= 0 && currentHour < 6) currentApiKey = settings.apiKeyGNews1;
      else if (currentHour >= 6 && currentHour < 12) currentApiKey = settings.apiKeyGNews2;
      else if (currentHour >= 12 && currentHour < 18) currentApiKey = settings.apiKeyGNews3;
      else currentApiKey = settings.apiKeyGNews4;

      if (!currentApiKey) {
        throw new Error(`Nenhuma chave de API do GNews encontrada para o período das ${currentHour}h.`);
      }
      functions.logger.info(`Usando a chave de API para o período das ${currentHour}h.`);

      const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).where("status", "==", "active").get();
      if (companiesSnapshot.empty) {
        functions.logger.warn("Nenhuma empresa ativa encontrada para processar.");
        return { success: true, message: "Nenhuma empresa ativa encontrada." };
      }

      let totalArticlesFound = 0;
      let totalArticlesSaved = 0;

      for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        functions.logger.info(`--- Processando empresa: ${companyName} ---`);

        const keywordsSnapshot = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).get();
        if (keywordsSnapshot.empty) {
          functions.logger.warn(`Nenhuma palavra-chave para a empresa ${companyName}, pulando.`);
          continue;
        }

        const keywordsList = keywordsSnapshot.docs.map(doc => doc.data().word);
        const searchQuery = keywordsList.map(kw => `"${kw}"`).join(" OR ");
        const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(searchQuery)}&lang=pt&country=br&token=${currentApiKey}`;
        
        functions.logger.info(`URL da API para ${companyName}: ${queryUrl}`);

        try {
          const response = await axios.get(queryUrl);
          const responseData = response.data;

          if (responseData.errors) {
            functions.logger.error(`Erro retornado pela API GNews para '${companyName}': ${responseData.errors.join(", ")}`);
            continue;
          }

          if (responseData.articles && responseData.articles.length > 0) {
            functions.logger.info(`-> API retornou ${responseData.articles.length} artigos para '${companyName}'.`);
            totalArticlesFound += responseData.articles.length;

            for (const article of responseData.articles) {
              const matchedKeyword = findMatchingKeyword(article, keywordsList);
              const articleData = {
                title: article.title,
                description: article.description,
                url: article.url,
                image: article.image || null,
                publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)),
                source: { name: article.source.name, url: article.source.url },
                keyword: matchedKeyword,
                companyId: companyId,
                companyName: companyName,
                status: "pending",
              };
              
              functions.logger.log(`Preparando para salvar artigo: "${article.title}"`);
              try {
                await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).add(articleData);
                totalArticlesSaved++;
                functions.logger.log(`   -> Artigo salvo com sucesso na fila de aprovação.`);
              } catch (saveError) {
                  functions.logger.error(`   !!! ERRO AO SALVAR ARTIGO NO FIRESTORE: ${saveError.message}`);
              }
            }
          } else {
            functions.logger.warn(`Nenhum artigo encontrado pela API para a busca da empresa '${companyName}'.`);
          }
        } catch (fetchError) {
          functions.logger.error(`!!! ERRO na chamada da API para a empresa '${companyName}':`, fetchError.message);
          if (fetchError.response) {
            functions.logger.error("   -> Resposta da API (com erro):", fetchError.response.data);
          }
        }
      }
      functions.logger.info("=======================================");
      functions.logger.info("BUSCA MANUAL CONCLUÍDA!");
      functions.logger.info(`Total de artigos encontrados: ${totalArticlesFound}`);
      functions.logger.info(`Total de artigos salvos na fila: ${totalArticlesSaved}`);
      functions.logger.info("=======================================");
      return { success: true, totalSaved: totalArticlesSaved };
    } catch (error) {
      functions.logger.error("!!!! ERRO FATAL na função manualFetch:", error);
      throw new functions.https.HttpsError("internal", "Ocorreu um erro interno no servidor.", error.message);
    }
  });


exports.scheduledFetch = functions
  .region("southamerica-east1")
  .pubsub.schedule("every 30 minutes")
  .timeZone("America/Sao_Paulo")
  .onRun(async (context) => {
    functions.logger.info("Iniciando a coleta AGENDADA de notícias (a cada 30 min).");
    const appId = APP_ID;
    try {
      // Reutiliza a lógica da função manualFetch
      // OBS: A função manualFetch precisa ser chamada internamente, o que não é o ideal.
      // A melhor prática seria extrair a lógica comum para uma função auxiliar.
      // Por simplicidade aqui, replicamos a lógica.
      const globalSettingsRef = db.doc(`artifacts/${appId}/public/data/settings/global`);
      const globalSettingsDoc = await globalSettingsRef.get();
      if (!globalSettingsDoc.exists) {
        throw new Error("Configurações globais não encontradas.");
      }
      const settings = globalSettingsDoc.data();
      
      const currentHour = new Date().getHours();
      let currentApiKey = '';
      if (currentHour >= 0 && currentHour < 6) currentApiKey = settings.apiKeyGNews1;
      else if (currentHour >= 6 && currentHour < 12) currentApiKey = settings.apiKeyGNews2;
      else if (currentHour >= 12 && currentHour < 18) currentApiKey = settings.apiKeyGNews3;
      else currentApiKey = settings.apiKeyGNews4;

      if (!currentApiKey) {
        throw new Error(`Nenhuma chave de API do GNews encontrada para o período das ${currentHour}h.`);
      }

      const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).where("status", "==", "active").get();
      for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        
        const keywordsSnapshot = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).get();
        if (keywordsSnapshot.empty) continue;

        const keywordsList = keywordsSnapshot.docs.map(doc => doc.data().word);
        const searchQuery = keywordsList.map(kw => `"${kw}"`).join(" OR ");
        const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(searchQuery)}&lang=pt&country=br&token=${currentApiKey}`;
        
        try {
          // Usando axios para consistência
          const response = await axios.get(queryUrl);
          const responseData = response.data;
          
          if (responseData.errors) {
            functions.logger.error(`(Agendado) Erro na API para '${companyName}': ${responseData.errors.join(", ")}`);
            continue;
          }
          
          if (responseData.articles && responseData.articles.length > 0) {
            for (const article of responseData.articles) {
              const matchedKeyword = findMatchingKeyword(article, keywordsList);
              const articleData = {
                title: article.title,
                description: article.description,
                url: article.url,
                image: article.image || null,
                publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)),
                source: { name: article.source.name, url: article.source.url },
                keyword: matchedKeyword,
                companyId: companyId,
                companyName: companyName,
                status: "pending",
              };
              await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).add(articleData);
            }
          }
        } catch (fetchError) {
          functions.logger.error(`(Agendado) Erro ao buscar notícias para '${companyName}':`, fetchError.message);
        }
      }
      functions.logger.info("Coleta AGENDADA de notícias concluída com sucesso.");
      return null;
    } catch (error) {
      functions.logger.error("Erro fatal na função AGENDADA de coleta:", error);
      return null;
    }
  });

