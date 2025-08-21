/**
 * Ficheiro: index.js
 * Descrição: Firebase Cloud Functions para o backend do projeto Aurora Clipping.
 * Funcionalidades:
 * 1. Robô agendado e manual para recolha e análise de notícias.
 * 2. Análise de imagens com a Cloud Vision API.
 * 3. Análise de vídeos com a Video Intelligence API.
 * 4. Análise de sentimento com a Natural Language API.
 * 5. Função para apagar empresas e todos os seus dados associados.
 */

// Importação dos módulos necessários
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios"); // Para fazer pedidos HTTP para APIs de notícias/RSS

// Importação dos clientes das APIs de Inteligência Artificial da Google
const { ImageAnnotatorClient } = require("@google-cloud/vision");
const { VideoIntelligenceServiceClient } = require("@google-cloud/video-intelligence");
const { LanguageServiceClient } = require("@google-cloud/language");

// Inicialização do Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// CORREÇÃO: Declara os clientes no escopo global, mas não os inicializa.
// Isto é conhecido como "lazy initialization" e previne erros de deploy.
let visionClient;
let videoClient;
let languageClient;

// --- LÓGICA PRINCIPAL DO ROBÔ DE NOTÍCIAS ---

/**
 * Função principal que busca e processa notícias para todas as empresas ativas.
 */
async function executarRoboDeNoticias() {
    console.log("Iniciando execução do robô de notícias.");

    // CORREÇÃO: Inicializa os clientes de API apenas na primeira vez que a função é executada.
    if (!visionClient) visionClient = new ImageAnnotatorClient();
    if (!videoClient) videoClient = new VideoIntelligenceServiceClient();
    if (!languageClient) languageClient = new LanguageServiceClient();

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


/**
 * Função auxiliar para apagar uma coleção em lotes.
 */
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(db, query, resolve) {
    const snapshot = await query.get();

    const batchSize = snapshot.size;
    if (batchSize === 0) {
        resolve();
        return;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();

    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}
