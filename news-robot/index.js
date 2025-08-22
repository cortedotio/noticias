/**
 * Ficheiro: index.js
 * Descrição: Firebase Cloud Functions para o backend do projeto Aurora Clipping.
 * Funcionalidades:
 * 1. Robô agendado e manual para recolha e análise de notícias.
 * 2. Análise de imagens com a Cloud Vision API.
 * 3. Análise de vídeos com a Video Intelligence API.
 * 4. Análise de sentimento com a Natural Language API.
 * 5. Função para apagar empresas e todos os seus dados associados.
 * 6. NOVAS FUNÇÕES: Inserção manual de alertas, gestão de pedidos de exclusão,
 * exclusão de palavra-chave com histórico, e geração de relatório para Super Admin.
 */

// Importação dos módulos necessários
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");

// Inicialização do Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// --- LÓGICA PRINCIPAL DO ROBÔ DE NOTÍCIAS ---

/**
 * Função principal que busca e processa notícias para todas as empresas ativas.
 */
async function executarRoboDeNoticias() {
    console.log("Iniciando execução do robô de notícias.");

    // CORREÇÃO: As bibliotecas e clientes das APIs da Google são importados e inicializados
    // aqui dentro para evitar erros de análise durante o deploy.
    const { ImageAnnotatorClient } = require("@google-cloud/vision");
    const { VideoIntelligenceServiceClient } = require("@google-cloud/video-intelligence");
    const { LanguageServiceClient } = require("@google-cloud/language");

    const visionClient = new ImageAnnotatorClient();
    const videoClient = new VideoIntelligenceServiceClient();
    const languageClient = new LanguageServiceClient();

    // Busca as chaves de API globais e fontes de notícias
    const globalSettingsDoc = await db.collection("settings").doc("global").get();
    if (!globalSettingsDoc.exists) {
        console.error("Configurações globais (chaves de API, fontes) não encontradas.");
        return;
    }
    const globalSettings = globalSettingsDoc.data();

    // Busca todas as empresas ativas
    const companiesSnapshot = await db.collection("companies").where("status", "==", "active").get();
    if (companiesSnapshot.empty) {
        console.log("Nenhuma empresa ativa encontrada para processar.");
        return;
    }

    // Processa cada empresa em paralelo
    const processamentoPromises = companiesSnapshot.docs.map(async (companyDoc) => {
        const companyId = companyDoc.id;
        const companyData = companyDoc.data();
        console.log(`Processando empresa: ${companyData.name} (${companyId})`);

        const keywordsSnapshot = await db.collection("companies").doc(companyId).collection("keywords").get();
        const keywords = keywordsSnapshot.docs.map(doc => doc.data().word);

        if (keywords.length === 0) {
            console.log(`Nenhuma palavra-chave para a empresa ${companyData.name}.`);
            return;
        }

        let artigosEncontrados = [];
        if (globalSettings.rssUrl) {
            const urlsRSS = globalSettings.rssUrl.split('\n');
            console.log(`Buscando em ${urlsRSS.length} feeds RSS para as palavras: ${keywords.join(", ")}`);
            // A sua lógica real de busca de notícias entraria aqui.
        }
        
        // --- SIMULAÇÃO DE ARTIGOS ENCONTRADOS (substitua pela sua lógica real) ---
        artigosEncontrados = [
            {
                title: "Nova tecnologia de IA revoluciona o mercado de carros",
                description: "Uma startup apresentou um novo sistema de visão computacional para veículos autónomos.",
                url: "https://exemplo.com/noticia1",
                source: { name: "Exemplo News" },
                publishedAt: new Date(),
                keyword: keywords[0] || "tecnologia",
                imageUrl: "https://storage.googleapis.com/cloud-samples-data/vision/label/wakeupcat.jpg",
            }
        ];
        // --- FIM DA SIMULAÇÃO ---

        if (artigosEncontrados.length === 0) {
            console.log(`Nenhum artigo novo encontrado para ${companyData.name}.`);
            return;
        }

        let novosAlertasContador = 0;

        for (const artigo of artigosEncontrados) {
            // Análise de Sentimento (Natural Language API)
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
                console.error(`Erro na API Natural Language:`, error.message);
            }

            // Análise de Imagem (Cloud Vision)
            if (artigo.imageUrl) {
                try {
                    console.log(`Analisando imagem: ${artigo.imageUrl}`);
                    const [result] = await visionClient.labelDetection(artigo.imageUrl);
                    artigo.tagsDeImagem = result.labelAnnotations.map(label => label.description);
                } catch (error) {
                    console.error(`Erro na API Vision para a imagem ${artigo.imageUrl}:`, error.message);
                }
            }

            // Análise de Vídeo (Video Intelligence)
            if (artigo.videoUrl && artigo.videoUrl.startsWith('gs://')) {
                try {
                    console.log(`Analisando vídeo: ${artigo.videoUrl}`);
                    const [operation] = await videoClient.annotateVideo({
                        inputUri: artigo.videoUrl,
                        features: ["LABEL_DETECTION"],
                    });
                    const [results] = await operation.promise();
                    const videoLabels = results.annotationResults[0].segmentLabelAnnotations;
                    artigo.tagsDeVideo = videoLabels.map(label => label.entity.description);
                } catch (error) {
                    console.error(`Erro na API Video Intelligence para o vídeo ${artigo.videoUrl}:`, error.message);
                }
            }
            
            // Salva o artigo enriquecido no Firestore
            await db.collection("companies").doc(companyId).collection("articles").add({
                ...artigo,
                publishedAt: admin.firestore.Timestamp.fromDate(new Date(artigo.publishedAt)),
            });
            novosAlertasContador++;
        }

        // Atualiza o contador de novos alertas para a empresa
        if (novosAlertasContador > 0) {
            const settingsRef = db.collection("settings").doc(companyId);
            await settingsRef.set({
                newAlerts: true,
                newAlertsCount: admin.firestore.FieldValue.increment(novosAlertasContador)
            }, { merge: true });
            console.log(`${novosAlertasContador} novos alertas adicionados para ${companyData.name}.`);
        }
    });

    await Promise.all(processamentoPromises);
    console.log("Execução do robô de notícias finalizada.");
}

// --- CLOUD FUNCTIONS EXPOSTAS ---

// 1. Função acionada manualmente a partir do painel de Super Admin
exports.manualFetch = functions
    .region("southamerica-east1")
    .https.onRequest(async (req, res) => {
        console.log("Acionamento manual recebido.");
        try {
            await executarRoboDeNoticias();
            res.status(200).json({ success: true, message: "Robô executado com sucesso." });
        } catch (error) {
            console.error("Erro na execução manual do robô:", error);
            res.status(500).json({ success: false, message: "Ocorreu um erro no servidor." });
        }
    });

// 2. Função agendada para executar o robô periodicamente (ex: a cada 30 minutos)
exports.scheduledFetch = functions
    .region("southamerica-east1")
    .pubsub.schedule("every 30 minutes")
    .onRun(async (context) => {
        console.log("Execução agendada do robô iniciada.");
        try {
            await executarRoboDeNoticias();
            return null;
        } catch (error) {
            console.error("Erro na execução agendada do robô:", error);
            return null;
        }
    });

// 3. Função para apagar uma empresa e todas as suas subcoleções
exports.deleteCompany = functions
    .region("southamerica-east1")
    .https.onCall(async (data, context) => {
        const companyId = data.companyId;
        if (!companyId) {
            throw new functions.https.HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');
        }

        console.log(`Iniciando exclusão da empresa: ${companyId}`);
        const companyRef = db.collection("companies").doc(companyId);

        await deleteCollection(db, `companies/${companyId}/users`, 100);
        await deleteCollection(db, `companies/${companyId}/keywords`, 100);
        await deleteCollection(db, `companies/${companyId}/articles`, 100);
        
        await db.collection("settings").doc(companyId).delete();
        await companyRef.delete();

        console.log(`Empresa ${companyId} excluída com sucesso.`);
        return { success: true, message: "Empresa e dados associados foram excluídos." };
    });

// --- NOVAS FUNÇÕES PARA SUPER ADMIN ---

exports.manualAddAlert = functions.region("southamerica-east1").https.onCall(async (data, context) => {
    const { companyId, title, description, url, source, keyword } = data;
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

exports.requestAlertDeletion = functions.region("southamerica-east1").https.onCall(async (data, context) => {
    const { companyId, companyName, articleId, articleTitle, justification } = data;
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

exports.manageDeletionRequest = functions.region("southamerica-east1").https.onCall(async (data, context) => {
    const { requestId, approve } = data;
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

exports.deleteKeywordAndArticles = functions.region("southamerica-east1").https.onCall(async (data, context) => {
    const { companyId, keyword } = data;
    if (!companyId || !keyword) throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos.');

    // Apagar a palavra-chave
    const keywordQuery = db.collection(`companies/${companyId}/keywords`).where("word", "==", keyword);
    const keywordSnapshot = await keywordQuery.get();
    const batch = db.batch();
    keywordSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    // Apagar os artigos associados
    const articlesQuery = db.collection(`companies/${companyId}/articles`).where("keyword", "==", keyword);
    await deleteCollection(db, articlesQuery, 100);

    await batch.commit();
    return { success: true, message: "Palavra-chave e alertas associados foram excluídos." };
});

exports.generateSuperAdminReport = functions.region("southamerica-east1").https.onCall(async (data, context) => {
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
