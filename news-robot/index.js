// index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { Timestamp } = require("firebase-admin/firestore");

// Inicializa o Firebase Admin SDK para interagir com o Firestore
admin.initializeApp();
const db = admin.firestore();

// O link para a API do GNews
const GNEWS_URL = "https://gnews.io/api/v4/search";

/**
 * Funções auxiliares para apagar subcoleções de forma eficiente.
 * A Cloud Function `deleteCompany` chamará esta função.
 */
async function deleteCollection(collectionRef) {
  const snapshot = await collectionRef.get();
  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    batch.delete(doc.ref);
  });
  await batch.commit();
}

/**
 * Função para aprovar um alerta. Move o alerta da fila de pendentes
 * para a coleção de artigos da empresa e a coleção de artigos global.
 */
exports.approveAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "O ID da aplicação e do alerta são necessários."
      );
    }

    const pendingAlertRef = db.collection("artifacts").doc(appId).collection("public/data/pendingAlerts").doc(alertId);
    const pendingAlertDoc = await pendingAlertRef.get();

    if (!pendingAlertDoc.exists) {
      throw new functions.https.HttpsError(
        "not-found",
        "Alerta pendente não encontrado."
      );
    }

    const alertData = pendingAlertDoc.data();
    if (!alertData) {
      throw new functions.https.HttpsError(
        "internal",
        "Dados do alerta estão corrompidos."
      );
    }
    const companyId = alertData.companyId;

    // 1. Adiciona o alerta aprovado à coleção da empresa
    const newArticleRef = await db.collection("artifacts").doc(appId).collection(`users/${companyId}/articles`).add({
      ...alertData,
      status: "approved",
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. Remove o alerta da coleção de pendentes
    await pendingAlertRef.delete();

    // 3. Atualiza o contador de novos alertas para a empresa
    const settingsRef = db.collection("artifacts").doc(appId).collection("public/data/settings").doc(companyId);
    await db.runTransaction(async (transaction) => {
      const settingsDoc = await transaction.get(settingsRef);
      const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
      transaction.update(settingsRef, { newAlertsCount });
    });

    return { success: true };
  });

/**
 * Função para rejeitar um alerta, simplesmente o removendo da fila de pendentes.
 */
exports.rejectAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "O ID da aplicação e do alerta são necessários."
      );
    }
    const pendingAlertRef = db.collection("artifacts").doc(appId).collection("public/data/pendingAlerts").doc(alertId);
    await pendingAlertRef.delete();
    return { success: true };
  });

/**
 * Função para excluir uma empresa e todos os seus dados.
 */
exports.deleteCompany = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId } = data;
    if (!appId || !companyId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "O ID da aplicação e da empresa são necessários."
      );
    }
    
    // Deleta todas as subcoleções (usuários, palavras-chave, artigos)
    await deleteCollection(db.collection("artifacts").doc(appId).collection(`users/${companyId}/users`));
    await deleteCollection(db.collection("artifacts").doc(appId).collection(`users/${companyId}/keywords`));
    await deleteCollection(db.collection("artifacts").doc(appId).collection(`users/${companyId}/articles`));

    // Deleta o documento da empresa e as configurações
    await db.collection("artifacts").doc(appId).collection("public/data/companies").doc(companyId).delete();
    await db.collection("artifacts").doc(appId).collection("public/data/settings").doc(companyId).delete();

    // Remove alertas pendentes e solicitações de exclusão relacionados
    const pendingAlertsSnapshot = await db.collection("artifacts").doc(appId).collection("public/data/pendingAlerts").where("companyId", "==", companyId).get();
    const pendingBatch = db.batch();
    pendingAlertsSnapshot.docs.forEach(doc => pendingBatch.delete(doc.ref));
    await pendingBatch.commit();

    const deletionRequestsSnapshot = await db.collection("artifacts").doc(appId).collection("public/data/deletionRequests").where("companyId", "==", companyId).get();
    const requestsBatch = db.batch();
    deletionRequestsSnapshot.docs.forEach(doc => requestsBatch.delete(doc.ref));
    await requestsBatch.commit();

    return { success: true };
  });

/**
 * Função para deletar uma palavra-chave e todos os artigos a ela associados.
 */
exports.deleteKeywordAndArticles = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, keyword } = data;
    if (!appId || !companyId || !keyword) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "O ID da aplicação, da empresa e a palavra-chave são necessários."
      );
    }

    const articlesToDelete = await db
      .collection("artifacts").doc(appId).collection(`users/${companyId}/articles`)
      .where("keyword", "==", keyword)
      .get();
    
    const batch = db.batch();
    articlesToDelete.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    const keywordRef = await db
      .collection("artifacts").doc(appId).collection(`users/${companyId}/keywords`)
      .where("word", "==", keyword)
      .get();
    
    if (!keywordRef.empty) {
      await db.collection("artifacts").doc(appId).collection(`users/${companyId}/keywords`).doc(keywordRef.docs[0].id).delete();
    }

    return { success: true };
  });

/**
 * Função para gerenciar solicitações de exclusão de alertas.
 */
exports.manageDeletionRequest = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, requestId, approve } = data;
    if (!appId || !requestId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "O ID da aplicação e da solicitação são necessários."
      );
    }

    const requestRef = db.collection("artifacts").doc(appId).collection("public/data/deletionRequests").doc(requestId);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) {
      throw new functions.https.HttpsError(
        "not-found",
        "Solicitação de exclusão não encontrada."
      );
    }
    
    const requestData = requestDoc.data();
    if (!requestData) {
      throw new functions.https.HttpsError(
        "internal",
        "Dados da solicitação estão corrompidos."
      );
    }

    if (approve) {
      await db.collection("artifacts").doc(appId).collection(`users/${requestData.companyId}/articles`).doc(requestData.articleId).delete();
      await requestRef.update({ status: "approved" });
    } else {
      await requestRef.update({ status: "denied" });
    }

    return { success: true };
  });

/**
 * Função para o usuário solicitar a exclusão de um alerta.
 */
exports.requestAlertDeletion = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, companyName, articleId, articleTitle, justification } = data;

    if (!appId || !companyId || !articleId || !justification) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Informações incompletas para a solicitação de exclusão."
      );
    }

    await db.collection("artifacts").doc(appId).collection("public/data/deletionRequests").add({
      companyId,
      companyName,
      articleId,
      articleTitle,
      justification,
      status: "pending",
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true };
  });

/**
 * Função para adicionar um alerta manualmente pelo Super Admin.
 */
exports.manualAddAlert = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId, companyId, title, description, url, source, keyword } = data;
    if (!appId || !companyId || !title || !url || !source || !keyword) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Dados incompletos para adicionar um alerta."
      );
    }

    const companyDoc = await db.collection("artifacts").doc(appId).collection("public/data/companies").doc(companyId).get();
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

    await db.collection("artifacts").doc(appId).collection(`users/${companyId}/articles`).add(alertData);
    
    // Atualiza o contador de novos alertas
    const settingsRef = db.collection("artifacts").doc(appId).collection("public/data/settings").doc(companyId);
    await db.runTransaction(async (transaction) => {
      const settingsDoc = await transaction.get(settingsRef);
      const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
      transaction.update(settingsRef, { newAlertsCount });
    });

    return { success: true };
  });

/**
 * Função para gerar um relatório geral para o Super Admin.
 */
exports.generateSuperAdminReport = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId } = data;
    if (!appId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }

    const companiesSnapshot = await db.collection("artifacts").doc(appId).collection("public/data/companies").get();
    const reportData = [];

    for (const companyDoc of companiesSnapshot.docs) {
      const companyId = companyDoc.id;
      const companyName = companyDoc.data().name;

      const articlesSnapshot = await db.collection("artifacts").doc(appId).collection(`users/${companyId}/articles`).get();
      const totalAlerts = articlesSnapshot.size;

      let positiveCount = 0;
      let neutralCount = 0;
      let negativeCount = 0;
      const channelCounts = {};
      const vehicleCounts = {};
      
      articlesSnapshot.docs.forEach(doc => {
        const article = doc.data();
        // Contagem de sentimento
        const score = article.sentiment?.score || 0;
        if (score > 0.2) positiveCount++;
        else if (score < -0.2) negativeCount++;
        else neutralCount++;

        // Contagem de canal
        const channel = article.source?.name ? getChannelCategory(article.source.name) : 'Outros';
        channelCounts[channel] = (channelCounts[channel] || 0) + 1;

        // Contagem de veículo
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

      reportData.push({
        companyName,
        totalAlerts,
        sentimentPercentage,
        predominantSentiment,
        topChannel,
        topVehicle,
      });
    }

    return reportData;
  });

/**
 * Função que aciona a coleta de notícias.
 * Ela pode ser chamada manualmente (via HTTP) ou por um agendamento.
 */
exports.manualFetch = functions
  .region("southamerica-east1")
  .https.onCall(async (data, context) => {
    const { appId } = data;
    if (!appId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }
    functions.logger.info("Iniciando a coleta manual de notícias.");

    try {
      // 1. Acessa as chaves de API do Firestore
      const globalSettingsRef = db.collection("artifacts").doc(appId).collection("public/data/settings").doc("global");
      const globalSettingsDoc = await globalSettingsRef.get();
      const settings = globalSettingsDoc.data();

      if (!settings) {
        throw new Error("Configurações globais não encontradas.");
      }

      // 2. Determina qual chave de API usar com base na hora atual
      const currentHour = new Date().getHours();
      let currentApiKey = '';

      if (currentHour >= 0 && currentHour < 6) { // 00:00 - 05:59
        currentApiKey = settings.apiKeyGNews1;
      } else if (currentHour >= 6 && currentHour < 12) { // 06:00 - 11:59
        currentApiKey = settings.apiKeyGNews2;
      } else if (currentHour >= 12 && currentHour < 18) { // 12:00 - 17:59
        currentApiKey = settings.apiKeyGNews3;
      } else { // 18:00 - 23:59
        currentApiKey = settings.apiKeyGNews4;
      }

      if (!currentApiKey) {
        throw new Error(
          `Nenhuma chave de API do GNews encontrada para o período das ${currentHour}h.`
        );
      }

      functions.logger.info(`Usando a chave de API para o período das ${currentHour}h.`);

      // 3. Itera sobre todas as empresas ativas
      const companiesSnapshot = await db
        .collection("artifacts").doc(appId).collection("public/data/companies")
        .where("status", "==", "active")
        .get();

      for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyData = companyDoc.data();
        const companyName = companyData.name;

        functions.logger.info(`Processando empresa: ${companyName}`);

        // Acessa as palavras-chave da empresa
        const keywordsSnapshot = await db
          .collection("artifacts").doc(appId).collection(`users/${companyId}/keywords`)
          .get();

        // Itera sobre as palavras-chave para buscar as notícias
        for (const keywordDoc of keywordsSnapshot.docs) {
          const keyword = keywordDoc.data().word;

          // Monta a URL da API do GNews
          const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(
            keyword
          )}&lang=pt&country=br&token=${currentApiKey}`;

          try {
            // Faz a chamada à API
            const response = await fetch(queryUrl);
            const data = await response.json();

            if (data.errors) {
              functions.logger.error(
                `Erro na API para a palavra-chave '${keyword}': ${data.errors.join(
                  ", "
                )}`
              );
              continue;
            }

            // 4. Salva os novos artigos no Firestore
            for (const article of data.articles) {
              const articleData = {
                title: article.title,
                description: article.description,
                url: article.url,
                image: article.image || null,
                publishedAt: admin.firestore.Timestamp.fromDate(
                  new Date(article.publishedAt)
                ),
                source: {
                  name: article.source.name,
                  url: article.source.url,
                },
                keyword: keyword,
                companyId: companyId,
                companyName: companyName,
                // Adiciona o artigo em uma coleção de alertas pendentes para aprovação
                status: "pending",
              };

              // Adiciona o alerta à coleção de alertas pendentes globalmente
              await db.collection("artifacts").doc(appId).collection("public/data/pendingAlerts").add(articleData);
            }
          } catch (fetchError) {
            functions.logger.error(
              `Erro ao buscar notícias para a palavra-chave '${keyword}':`,
              fetchError
            );
          }
        }
      }

      functions.logger.info("Coleta de notícias concluída com sucesso.");
      return { success: true };
    } catch (error) {
      functions.logger.error("Erro fatal na função de coleta:", error);
      throw new functions.https.HttpsError(
        "internal",
        "Ocorreu um erro interno no servidor."
      );
    }
  });


// --- Funções de ajuda para o relatório ---
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
