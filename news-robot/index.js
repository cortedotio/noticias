const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const Parser = require('rss-parser');

admin.initializeApp();
const db = admin.firestore();
const parser = new Parser();

// --- Função Principal do Robô de Coleta de Notícias ---
exports.fetchNewsRobot = functions.runWith({ timeoutSeconds: 540, memory: '1GB' }).pubsub.schedule('every 1 minutes').onRun(async (context) => {
    try {
        const globalSettingsDoc = await db.collection('settings').doc('global').get();
        const globalSettings = globalSettingsDoc.exists ? globalSettingsDoc.data() : {};

        const now = new Date();
        const hour = now.getUTCHours() - 3; // Ajuste para o fuso horário de Brasília (UTC-3)
        const gnewsApiKey = getGNewsApiKeyByTime(hour, globalSettings);
        const apiKeyYoutube = globalSettings.apiKeyYoutube;
        const rssUrls = globalSettings.rssUrl ? globalSettings.rssUrl.split('\n') : [];
        const bloggerIds = globalSettings.bloggerId ? globalSettings.bloggerId.split('\n') : [];

        const companiesSnapshot = await db.collection('companies').where('status', '==', 'active').get();
        
        for (const companyDoc of companiesSnapshot.docs) {
            const companyId = companyDoc.id;
            const companySettingsDoc = await db.collection('settings').doc(companyId).get();
            const companySettings = companySettingsDoc.exists ? companySettingsDoc.data() : {};
            const keywordsSnapshot = await db.collection('companies').doc(companyId).collection('keywords').get();
            const keywords = keywordsSnapshot.docs.map(doc => doc.data().word);

            if (keywords && keywords.length > 0) {
                const queryStr = keywords.join(' OR ');
                const newsPromises = [];
                const newsAdded = new Set();
                const lastFetchTimestamp = companySettings.lastFetchTimestamp ? companySettings.lastFetchTimestamp.toDate() : null;
                const fetchOnlyNew = companySettings.fetchOnlyNew;

                // Coleta de GNews
                if (gnewsApiKey) {
                    const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(queryStr)}&lang=pt&country=br&token=${gnewsApiKey}`;
                    newsPromises.push(axios.get(gnewsUrl).then(res => res.data.articles || []).catch(e => { console.error(`Erro GNews para ${companyId}: ${e.message}`); return []; }));
                }

                // Coleta de RSS
                for (const rssUrl of rssUrls) {
                    newsPromises.push(parser.parseURL(rssUrl).then(feed => feed.items).catch(e => { console.error(`Erro RSS para ${rssUrl}: ${e.message}`); return []; }));
                }

                // Coleta de Blogger (futuro)
                // if (apiKeyBlogger) { ... }

                const allNews = [].concat(...await Promise.all(newsPromises));
                const batch = db.batch();
                let newAlertsCount = 0;

                allNews.forEach(article => {
                    const articleUrl = article.url || article.link;
                    if (!articleUrl || newsAdded.has(articleUrl)) return;
                    newsAdded.add(articleUrl);

                    const publishedAt = article.publishedAt || article.isoDate;
                    if (fetchOnlyNew && lastFetchTimestamp && new Date(publishedAt) <= lastFetchTimestamp) {
                        return;
                    }
                    
                    const channel = getChannel(article.source.name || article.creator);
                    const newsRef = db.collection('companies').doc(companyId).collection('articles').doc();
                    
                    batch.set(newsRef, {
                        title: article.title,
                        description: article.description || article.contentSnippet || 'Sem descrição.',
                        url: articleUrl,
                        source: { name: article.source.name || article.creator || 'Desconhecida', url: article.source.url || '' },
                        publishedAt: new Date(publishedAt),
                        keyword: keywords.find(kw => article.title.toLowerCase().includes(kw.toLowerCase()) || (article.description && article.description.toLowerCase().includes(kw.toLowerCase()))),
                        channel: channel,
                        sentiment: { score: 0 }
                    });
                    newAlertsCount++;
                });

                if (newAlertsCount > 0) {
                    const companySettingsRef = db.collection('settings').doc(companyId);
                    batch.update(companySettingsRef, {
                        newAlertsCount: admin.firestore.FieldValue.increment(newAlertsCount),
                        lastFetchTimestamp: now
                    });
                }
                
                await batch.commit();
            }
        }
        console.log('Robô de notícias executado com sucesso.');
        return null;
    } catch (error) {
        console.error('Erro na função fetchNewsRobot:', error);
        return null;
    }
});

// Helper para selecionar a chave GNews com base no horário
function getGNewsApiKeyByTime(hour, settings) {
    if (hour >= 0 && hour <= 5) return settings.apiKeyGNews1;
    if (hour >= 6 && hour <= 11) return settings.apiKeyGNews2;
    if (hour >= 12 && hour <= 17) return settings.apiKeyGNews3;
    return settings.apiKeyGNews4;
}

// Helper para categorizar o canal
function getChannel(sourceName) {
    const name = (sourceName || '').toLowerCase();
    if (name.includes('youtube')) return 'YouTube';
    if (name.includes('blogger')) return 'Blogger';
    if (name.includes('globo') || name.includes('g1') || name.includes('uol') || name.includes('terra') || name.includes('r7')) return 'Sites';
    if (name.includes('veja') || name.includes('istoé') || name.includes('exame')) return 'Revistas';
    if (name.includes('cbn') || name.includes('bandeirantes')) return 'Rádios';
    return 'Sites';
}

// --- Funções Chamáveis (Callable Functions) ---

// Função para acionar o robô de forma manual
exports.manualFetch = functions.https.onCall(async (data, context) => {
    // Implementação simples, apenas dispara o robô agendado
    await exports.fetchNewsRobot(context);
    return { success: true, message: 'Robô executado com sucesso!' };
});

// Função para deletar uma empresa e todos os seus dados
exports.deleteCompany = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Apenas usuários autenticados podem excluir empresas.');
    const superAdminRoleDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!superAdminRoleDoc.exists || superAdminRoleDoc.data().role !== 'superadmin') throw new functions.https.HttpsError('permission-denied', 'Apenas super administradores podem excluir empresas.');

    const companyId = data.companyId;
    if (!companyId) throw new functions.https.HttpsError('invalid-argument', 'O ID da empresa é obrigatório.');

    try {
        const batch = db.batch();
        const collectionsToDelete = ['users', 'keywords', 'articles'];
        for (const collectionName of collectionsToDelete) {
            const snapshot = await db.collection('companies').doc(companyId).collection(collectionName).get();
            snapshot.forEach(doc => batch.delete(doc.ref));
        }

        batch.delete(db.collection('settings').doc(companyId));
        batch.delete(db.collection('companies').doc(companyId));
        
        await batch.commit();

        return { success: true };
    } catch (error) {
        console.error("Erro ao excluir empresa:", error);
        throw new functions.https.HttpsError('internal', 'Ocorreu um erro ao tentar excluir a empresa e seus dados.', error);
    }
});

// Função para deletar uma palavra-chave e os alertas associados
exports.deleteKeywordAndArticles = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    const superAdminRoleDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!superAdminRoleDoc.exists || superAdminRoleDoc.data().role !== 'superadmin') throw new functions.https.HttpsError('permission-denied', 'Permissão negada.');

    const { companyId, keyword } = data;
    if (!companyId || !keyword) throw new functions.https.HttpsError('invalid-argument', 'ID da empresa e palavra-chave são obrigatórios.');

    const batch = db.batch();
    const keywordQuery = await db.collection('companies').doc(companyId).collection('keywords').where('word', '==', keyword).get();
    keywordQuery.forEach(doc => batch.delete(doc.ref));

    const articlesQuery = await db.collection('companies').doc(companyId).collection('articles').where('keyword', '==', keyword).get();
    articlesQuery.forEach(doc => batch.delete(doc.ref));

    await batch.commit();
    return { success: true };
});

// Função para adicionar um alerta manualmente
exports.manualAddAlert = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    const superAdminRoleDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!superAdminRoleDoc.exists || superAdminRoleDoc.data().role !== 'superadmin') throw new functions.https.HttpsError('permission-denied', 'Permissão negada.');

    const { companyId, title, description, url, source, keyword } = data;
    if (!companyId || !title || !url || !source || !keyword) throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos.');

    const articleRef = db.collection('companies').doc(companyId).collection('articles').doc();
    await articleRef.set({
        title,
        description,
        url,
        source: { name: source, url: '' },
        publishedAt: new Date(),
        keyword,
        channel: 'Manual',
        sentiment: { score: 0 }
    });

    // Atualiza a contagem de alertas
    const companySettingsRef = db.collection('settings').doc(companyId);
    await companySettingsRef.update({
        newAlertsCount: admin.firestore.FieldValue.increment(1)
    });

    return { success: true };
});

// Função para usuários solicitarem a exclusão de um alerta
exports.requestAlertDeletion = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    const { companyId, companyName, articleId, articleTitle, justification } = data;
    if (!companyId || !articleId || !justification) throw new functions.https.HttpsError('invalid-argument', 'Dados incompletos.');

    const deletionRequestRef = db.collection('deletionRequests').doc();
    await deletionRequestRef.set({
        companyId,
        companyName,
        articleId,
        articleTitle,
        justification,
        requestedBy: context.auth.uid,
        requestedAt: new Date(),
        status: 'pending'
    });

    return { success: true };
});

// Função para o super admin gerenciar solicitações de exclusão
exports.manageDeletionRequest = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    const superAdminRoleDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!superAdminRoleDoc.exists || superAdminRoleDoc.data().role !== 'superadmin') throw new functions.https.HttpsError('permission-denied', 'Permissão negada.');

    const { requestId, approve } = data;
    const requestRef = db.collection('deletionRequests').doc(requestId);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) throw new functions.https.HttpsError('not-found', 'Solicitação não encontrada.');

    const request = requestDoc.data();
    if (approve) {
        // Exclui o alerta
        const articleRef = db.collection('companies').doc(request.companyId).collection('articles').doc(request.articleId);
        await articleRef.delete();
        await requestRef.update({ status: 'approved', approvedBy: context.auth.uid, approvedAt: new Date() });
    } else {
        await requestRef.update({ status: 'denied', deniedBy: context.auth.uid, deniedAt: new Date() });
    }
    
    return { success: true };
});

// Função para gerar o relatório geral de super admin
exports.generateSuperAdminReport = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Autenticação necessária.');
    const superAdminRoleDoc = await db.collection('users').doc(context.auth.uid).get();
    if (!superAdminRoleDoc.exists || superAdminRoleDoc.data().role !== 'superadmin') throw new functions.https.HttpsError('permission-denied', 'Permissão negada.');

    const reportData = [];
    const companiesSnapshot = await db.collection('companies').get();

    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        
        const articlesSnapshot = await db.collection('companies').doc(companyId).collection('articles').get();
        const articles = articlesSnapshot.docs.map(doc => doc.data());

        const totalAlerts = articles.length;
        if (totalAlerts === 0) {
            reportData.push({ companyName, totalAlerts: 0, sentimentPercentage: { positive: 0, neutral: 0, negative: 0 }, predominantSentiment: 'N/A', topChannel: 'N/A', topVehicle: 'N/A' });
            continue;
        }

        const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
        const channelCounts = {};
        const sourceCounts = {};

        articles.forEach(article => {
            const sentimentScore = article.sentiment?.score || 0;
            if (sentimentScore > 0.2) sentimentCounts.positive++;
            else if (sentimentScore < -0.2) sentimentCounts.negative++;
            else sentimentCounts.neutral++;

            const channel = article.channel || 'Desconhecido';
            channelCounts[channel] = (channelCounts[channel] || 0) + 1;

            const source = article.source?.name || 'Desconhecido';
            sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        });

        const predominantSentiment = Object.keys(sentimentCounts).reduce((a, b) => sentimentCounts[a] > sentimentCounts[b] ? a : b);
        const totalSentiments = sentimentCounts.positive + sentimentCounts.neutral + sentimentCounts.negative;
        const sentimentPercentage = {
            positive: ((sentimentCounts.positive / totalSentiments) * 100).toFixed(2),
            neutral: ((sentimentCounts.neutral / totalSentiments) * 100).toFixed(2),
            negative: ((sentimentCounts.negative / totalSentiments) * 100).toFixed(2)
        };
        const topChannel = Object.keys(channelCounts).reduce((a, b) => (channelCounts[a] > channelCounts[b] ? a : b) || 'N/A');
        const topVehicle = Object.keys(sourceCounts).reduce((a, b) => (sourceCounts[a] > sourceCounts[b] ? a : b) || 'N/A');

        reportData.push({ companyName, totalAlerts, sentimentPercentage, predominantSentiment, topChannel, topVehicle });
    }
    
    return reportData;
});