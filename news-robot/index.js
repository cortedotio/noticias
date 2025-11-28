/**
 * IMPORTANTE: Este é o código COMPLETO e ATUALIZADO para o servidor (Firebase Cloud Functions).
 * ...
 * * * * CORREÇÃO FINAL (SET/2025): Removida a truncagem de texto para exibir o conteúdo completo.
 * * Reintroduzida e corrigida a lógica de busca do YouTube para garantir a captura de vídeos.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const Parser = require('rss-parser');

const { LanguageServiceClient } = require('@google-cloud/language');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { Client } = require("@googlemaps/google-maps-services-js");
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const parser = new Parser();

const languageClient = new LanguageServiceClient();
const translationClient = new TranslationServiceClient();
const visionClient = new ImageAnnotatorClient();
const videoClient = new VideoIntelligenceServiceClient();
const mapsClient = new Client({});

const GNEWS_URL = "https://gnews.io/api/v4/search";
const NEWSAPI_URL = "https://newsapi.org/v2/everything";
const BLOGGER_URL = "https://www.googleapis.com/blogger/v3/blogs";
const YOUTUBE_URL = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const APP_ID = "noticias-6e952";
const GOOGLE_PROJECT_ID = "noticias-6e952";

const runtimeOpts = {
  timeoutSeconds: 540,
  memory: '2GB'
};
const regionalFunctions = functions.region("southamerica-east1").runWith(runtimeOpts);

// --- Funções Auxiliares ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Descoberta automática de endpoints RSS
const COMMON_FEED_PATHS = ['/feed', '/rss', '/index.xml', '/atom.xml', '/rss.xml', '/feed.xml', '/feeds/posts/default'];

async function tryValidateFeed(url) {
    try {
        const feed = await parser.parseURL(url);
        return !!(feed && typeof feed.items !== 'undefined');
    } catch (e) {
        return false;
    }
}

async function discoverRssFeeds(baseSiteUrl) {
    const discovered = new Set();
    let base;
    try { base = new URL(baseSiteUrl); } catch { return discovered; }
    const homepageUrl = base.origin;

    const candidates = new Set();
    // Tentar coletar via tags <link rel="alternate" type="application/rss+xml|atom">
    for (const url of [base.href, homepageUrl]) {
        try {
            const resp = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (RSS Discovery Bot)' }, timeout: 8000 });
            const html = resp.data || '';
            const linkRegex = /<link[^>]*rel=["']?alternate["']?[^>]*>/gi;
            let m;
            while ((m = linkRegex.exec(html)) !== null) {
                const tag = m[0];
                if (/type=["']?(application\/(rss\+xml|atom\+xml))["']?/i.test(tag)) {
                    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
                    if (hrefMatch && hrefMatch[1]) {
                        try { const resolved = new URL(hrefMatch[1], url).href; candidates.add(resolved); } catch {}
                    }
                }
            }
        } catch (e) {
            functions.logger.warn(`Falha ao buscar HTML de ${url} para descoberta RSS: ${e.message}`);
        }
    }

    // Tentar caminhos comuns
    for (const path of COMMON_FEED_PATHS) {
        try { candidates.add(new URL(path, homepageUrl).href); } catch {}
    }

    const candidateArray = Array.from(candidates).slice(0, 20);
    for (const cand of candidateArray) {
        try {
            const ok = await tryValidateFeed(cand);
            if (ok) { discovered.add(cand); }
        } catch {}
        if (discovered.size >= 5) break; // limitar quantidade por site
    }
    return discovered;
}
const findMatchingKeywords = (article, keywords) => {
    const normalizeText = (txt) => String(txt || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let contentToSearch = '';
    contentToSearch += ' ' + (article.title || '');
    contentToSearch += ' ' + (article.contentSnippet || article.description || article.content || '');
    // Ampliar superfície: incluir autor e nome da fonte quando disponíveis
    contentToSearch += ' ' + (article.author || '');
    contentToSearch += ' ' + (article.source?.name || '');
    if (article.ai?.videoTranscription) {
        contentToSearch += ' ' + article.ai.videoTranscription;
    }
    if (article.ai?.ocrText) {
        contentToSearch += ' ' + article.ai.ocrText;
    }

    const normalizedContent = normalizeText(contentToSearch);
    const matchedKeywords = keywords.filter(kw => {
        const normalizedKw = normalizeText(kw);
        return normalizedKw && normalizedContent.includes(normalizedKw);
    });
    return matchedKeywords;
};

async function geocodeLocation(locationName, apiKey) {
    if (!locationName || !apiKey) return null;
    const locationKey = locationName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cacheRef = db.doc(`artifacts/${APP_ID}/public/data/geocache/${locationKey}`);
    try {
        const cacheDoc = await cacheRef.get();
        if (cacheDoc.exists) {
            return cacheDoc.data();
        }
        const response = await mapsClient.geocode({
            params: {
                address: `${locationName}, Brasil`,
                key: apiKey,
                language: 'pt-BR',
                region: 'BR'
            }
        });
        if (response.data.results && response.data.results.length > 0) {
            const location = response.data.results[0].geometry.location;
            await cacheRef.set(location);
            return location;
        }
        return null;
    } catch (error) {
        functions.logger.error(`Erro de Geocoding para '${locationName}':`, error.message);
        return null;
    }
}

async function detectAndTranslate(text) {
    // Normalizar o texto para evitar chamadas desnecessárias por diferenças triviais
    const normalize = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ').replace(/\s+/g, ' ').trim();
    const originalText = text || '';
    const normalizedText = normalize(originalText);
    if (!normalizedText || normalizedText.length < 20) {
        return { originalText, translatedText: originalText, languageCode: 'pt', translated: false };
    }

    // Cache de tradução: chave por SHA-256 do texto normalizado
    const hash = crypto.createHash('sha256').update(normalizedText).digest('hex');
    const cacheRef = db.doc(`artifacts/${APP_ID}/public/data/translationCache/${hash}`);
    try {
        const cacheSnap = await cacheRef.get();
        if (cacheSnap.exists) {
            const c = cacheSnap.data();
            const lang = (c.languageCode || 'und').toLowerCase();
            const translated = lang !== 'pt';
            return { originalText, translatedText: c.translatedText || originalText, languageCode: c.languageCode || 'und', translated };
        }
    } catch (e) {
        functions.logger.warn('Falha ao ler cache de tradução:', e.message);
    }

    const parent = `projects/${GOOGLE_PROJECT_ID}/locations/global`;
    const detectRequest = { parent, content: normalizedText, mimeType: 'text/plain' };

    try {
        const [detectResponse] = await translationClient.detectLanguage(detectRequest);
        const detectedLanguage = detectResponse.languages[0];
        const language = (detectedLanguage && detectedLanguage.languageCode) ? detectedLanguage.languageCode.toLowerCase() : 'und';
        if (language === 'pt') {
            // Cache como português para evitar redetecção
            try { await cacheRef.set({ translatedText: originalText, languageCode: 'pt', createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch {}
            return { originalText, translatedText: originalText, languageCode: 'pt', translated: false };
        }
        const translateRequest = {
            parent,
            contents: [normalizedText],
            mimeType: 'text/plain',
            sourceLanguageCode: detectedLanguage.languageCode,
            targetLanguageCode: 'pt',
        };
        const [translateResponse] = await translationClient.translateText(translateRequest);
        const translation = (translateResponse.translations && translateResponse.translations[0]) ? translateResponse.translations[0].translatedText : originalText;
        // Salvar no cache
        try { await cacheRef.set({ translatedText: translation, languageCode: detectedLanguage.languageCode, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch {}
        return { originalText, translatedText: translation, languageCode: detectedLanguage.languageCode, translated: true };
    } catch (error) {
        functions.logger.error('Erro na API de Tradução:', error.message);
        return { originalText, translatedText: originalText, languageCode: 'und', translated: false };
    }
}

function normalizeArticle(article, sourceApi) {
    try {
        switch (sourceApi) {
            case 'gnews': return { title: article.title, description: article.description, url: article.url, image: article.image || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), source: { name: article.source.name, url: article.source.url }, author: article.author || null, };
            case 'newsapi': return { title: article.title, description: article.description, url: article.url, image: article.urlToImage || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), source: { name: article.source.name, url: null }, author: article.author || null, };
            case 'blogger': const blogName = article.blog ? article.blog.name : 'Blogger'; return { title: article.title, description: (article.content || "").replace(/<[^>]*>?/gm, ''), url: article.url, image: null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.published)), source: { name: blogName, url: article.url }, author: article.author?.displayName || null, };
            case 'rss': {
                const rawSourceName = article.feedTitle || (article.link ? new URL(article.link).hostname.replace(/^www\./, '') : 'RSS');
                const sourceUrl = article.feedLink || article.link;
                const friendlySourceName = (() => {
                    const urlStr = sourceUrl || article.link || '';
                    const lower = (urlStr || '').toLowerCase();
                    if (rawSourceName && rawSourceName !== 'RSS' && rawSourceName !== 'RSS Feed') return rawSourceName;
                    if (lower.includes('metropoles.com')) return 'Metrópoles';
                    if (lower.includes('marretaurgente')) return 'Marreta Urgente';
                    return rawSourceName || 'RSS';
                })();
                return { title: article.title, description: (article.contentSnippet || article.content || "").replace(/<[^>]*>?/gm, ''), url: article.link, image: article.enclosure?.url || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.isoDate)), source: { name: friendlySourceName, url: sourceUrl }, author: article.creator || null, };
            }
            case 'youtube': return { title: article.snippet.title, description: article.snippet.description, url: `https://www.youtube.com/watch?v=${article.id.videoId}`, image: article.snippet.thumbnails.high.url || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.snippet.publishedAt)), source: { name: 'YouTube', url: `https://www.youtube.com/channel/${article.snippet.channelId}` }, author: article.snippet.channelTitle || null, videoId: article.id.videoId };
            default: return null;
        }
    } catch (e) {
        functions.logger.error(`Erro ao normalizar artigo da fonte ${sourceApi}:`, e, article);
        return null;
    }
}

async function analyzeArticleWithAI(article, settings) {
    const textContent = `${article.title}. ${article.description}`;
    let languageData = { sentiment: { score: 0, magnitude: 0 }, entities: [], categories: [] };
    let visionData = { logos: [], ocrText: '' };
    let videoData = { videoTranscription: '' };

    if (textContent && textContent.length > 50 && !textContent.startsWith('http')) {
        try {
            const document = { content: textContent, type: 'PLAIN_TEXT', language: 'pt' };
            const [sentimentResult, entitiesResult] = await Promise.all([
                languageClient.analyzeSentiment({ document }),
                languageClient.analyzeEntities({ document }),
            ]);
            languageData.sentiment = sentimentResult[0].documentSentiment;
            languageData.entities = entitiesResult[0].entities.filter(e => e.salience > 0.01 && e.type !== 'OTHER').map(e => ({ name: e.name, type: e.type, salience: e.salience }));
            languageData.categories = []; 
        } catch (error) {
            functions.logger.error("Erro na Natural Language AI:", error.message);
        }
    }
    
    // Gate do Vision AI com configuração global e filtro de relevância
    const visionEnabled = settings.visionEnabled === true;
    const logoEnabled = settings.visionLogoDetection === true;
    const ocrEnabled = settings.visionOcrText === true;
    const relevantOnly = settings.visionRelevantOnly === true;

    const isRelevantImage = (url) => {
        try {
            const u = (url || '').toLowerCase();
            const allowedExt = /(\.jpg|\.jpeg|\.png|\.webp)(\?|$)/i;
            if (!allowedExt.test(u)) return false;
            const badPatterns = ['logo', 'icon', 'placeholder', 'sprite', 'default', 'banner', 'favicon'];
            if (badPatterns.some(p => u.includes(p))) return false;
            const sizeParamMatch = u.match(/[?&](w|width|h|height)=(\d+)/);
            if (sizeParamMatch && Number(sizeParamMatch[2]) < 64) return false;
            return true;
        } catch {
            return false;
        }
    };

    if (article.image && settings.apiKeyVision && visionEnabled) {
        try {
            if (!relevantOnly || isRelevantImage(article.image)) {
                if (logoEnabled) {
                    const [logoResult] = await visionClient.logoDetection(article.image);
                    visionData.logos = logoResult.logoAnnotations.map(logo => ({ description: logo.description, score: logo.score }));
                }
                if (ocrEnabled) {
                    const [textResult] = await visionClient.textDetection(article.image);
                    visionData.ocrText = textResult.fullTextAnnotation ? textResult.fullTextAnnotation.text.replace(/\n/g, ' ') : '';
                }
            } else {
                functions.logger.info(`Imagem filtrada por relevância: ${article.image}`);
            }
        } catch (err) {
            functions.logger.warn(`Vision AI error para imagem ${article.image}:`, err.message);
        }
    }

    if (article.videoId && settings.apiKeyVideoIntelligence) {
        functions.logger.warn(`A transcrição de vídeo para ${article.videoId} foi pulada. Requer upload para o Google Cloud Storage.`);
    }

    return { ...languageData, ...visionData, ...videoData };
}

async function fetchAllNews() {
    functions.logger.info("=======================================");
    functions.logger.info("INICIANDO BUSCA DE NOTÍCIAS COM TRADUÇÃO, IA, MÍDIA E GEOCODIFICAÇÃO...");

    const globalSettingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/global`);
    const globalSettingsDoc = await globalSettingsRef.get();
    if (!globalSettingsDoc.exists) { throw new Error("Configurações globais não encontradas."); }
    const settings = globalSettingsDoc.data();
    const mapsApiKey = settings.apiKeyGoogleMaps || settings.apiKeyFirebaseNews; 
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Configurações do YouTube
    const youtubeChannels = settings.youtubeChannels ? settings.youtubeChannels.split('\n').map(s => s.trim()).filter(s => s.length > 0) : [];
    const youtubeFrequencyHours = Number(settings.youtubeFrequencyHours || 6);
    const youtubeFrequencyTime = (settings.youtubeFrequencyTime || '').trim(); // formato HH:MM
    const lastRun = settings.youtubeLastRun && typeof settings.youtubeLastRun.toDate === 'function' ? settings.youtubeLastRun.toDate() : null;
    const now = new Date();
    const frequencyOk = !lastRun || (now.getTime() - lastRun.getTime()) >= youtubeFrequencyHours * 60 * 60 * 1000;
    let desiredTimeOk = true;
    if (youtubeFrequencyTime) {
        const parts = youtubeFrequencyTime.split(':');
        const hh = Number(parts[0]);
        const mm = Number(parts[1]);
        if (!Number.isNaN(hh) && !Number.isNaN(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            const desiredToday = new Date(now);
            desiredToday.setHours(hh, mm, 0, 0);
            const diffMinutes = Math.abs((now.getTime() - desiredToday.getTime()) / 60000);
            // Permitir execução quando estiver dentro de uma janela de 30 minutos do horário desejado
            desiredTimeOk = diffMinutes <= 30;
        }
    }
    const canRunYouTube = frequencyOk && desiredTimeOk;
    // Gate para GNews configurável
    const gnewsLastRun = settings.gnewsLastRun && typeof settings.gnewsLastRun.toDate === 'function' ? settings.gnewsLastRun.toDate() : null;
    const gnewsFrequencyHours = Number(settings.gnewsFrequencyHours || 2);
    const canRunGNews = !gnewsLastRun || (now.getTime() - gnewsLastRun.getTime()) >= gnewsFrequencyHours * 60 * 60 * 1000;
    // Gate para RSS configurável
    const rssLastRun = settings.rssLastRun && typeof settings.rssLastRun.toDate === 'function' ? settings.rssLastRun.toDate() : null;
    const rssFrequencyMinutes = Number(settings.rssFrequencyMinutes || 10);
    const canRunRSS = !rssLastRun || (now.getTime() - rssLastRun.getTime()) >= rssFrequencyMinutes * 60 * 1000;

    // Gate específico para monitoramento de IDs de Canais (YouTube)
    const youtubeChannelsLastRun = settings.youtubeChannelsLastRun && typeof settings.youtubeChannelsLastRun.toDate === 'function' ? settings.youtubeChannelsLastRun.toDate() : null;
    const youtubeChannelsFrequencyMinutes = Number(settings.youtubeChannelsFrequencyMinutes || rssFrequencyMinutes);
    const canRunYouTubeChannels = !youtubeChannelsLastRun || (now.getTime() - youtubeChannelsLastRun.getTime()) >= youtubeChannelsFrequencyMinutes * 60 * 1000;

    let executedGNews = false;
    let executedRSS = false;
    let executedYouTubeKeywords = false;
    let executedYouTubeChannels = false;
    const newRssSites = new Set();
    const companiesSnapshot = await db.collection(`artifacts/${APP_ID}/public/data/companies`).where("status", "==", "active").get();
    if (companiesSnapshot.empty) {
        functions.logger.warn("Nenhuma empresa ativa encontrada para processar.");
        return { success: true, message: "Nenhuma empresa ativa encontrada." };
    }

    let articlesToSaveCount = 0;
    const allCompaniesData = []; 

    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        const companySettingsDoc = await db.doc(`artifacts/${APP_ID}/public/data/settings/${companyId}`).get();
        const fetchOnlyNew = companySettingsDoc.exists && companySettingsDoc.data().fetchOnlyNew === true;
        const captureChannels = (companySettingsDoc.exists && Array.isArray(companySettingsDoc.data().captureChannels) && companySettingsDoc.data().captureChannels.length > 0)
            ? companySettingsDoc.data().captureChannels
            : ['Sites','YouTube','Revistas','Rádios','TV'];
        const existingUrls = new Set();
        const articlesQuery = db.collection(`artifacts/${APP_ID}/users/${companyId}/articles`).select('url');
        const pendingQuery = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).where('companyId', '==', companyId).select('url');
        const [articlesSnapshot, pendingSnapshot] = await Promise.all([articlesQuery.get(), pendingQuery.get()]);
        
        articlesSnapshot.forEach(doc => existingUrls.add(doc.data().url));
        pendingSnapshot.forEach(doc => existingUrls.add(doc.data().url));
        const keywordsSnapshot = await db.collection(`artifacts/${APP_ID}/users/${companyId}/keywords`).get();
        if (!keywordsSnapshot.empty) {
            const keywordsList = keywordsSnapshot.docs.map(doc => doc.data().word);
            allCompaniesData.push({ companyId, companyName, keywordsList, fetchOnlyNew, captureChannels, existingUrls });
        }
    }

    const processAndSaveArticle = async (normalizedArticle, company, matchedKeywords) => {
        if (!normalizedArticle || company.existingUrls.has(normalizedArticle.url)) {
            return;
        }
        
        const translatedTitle = await detectAndTranslate(normalizedArticle.title);
        const translatedDesc = await detectAndTranslate(normalizedArticle.description);
        normalizedArticle.title = translatedTitle.translatedText;
        normalizedArticle.description = translatedDesc.translatedText;
        
        const aiData = await analyzeArticleWithAI(normalizedArticle, settings);
        // Unir matches da consulta (YouTube) com os detectados após tradução/IA
        const initialMatches = Array.isArray(matchedKeywords) ? matchedKeywords : [];
        const recomputedMatches = findMatchingKeywords({ ...normalizedArticle, ai: aiData }, company.keywordsList);
        const finalMatchedKeywords = Array.from(new Set([ ...initialMatches, ...recomputedMatches ]));

        if (finalMatchedKeywords.length === 0) {
            return;
        }

        let geolocation = null;
        if (aiData.entities && aiData.entities.length > 0) {
            const firstLocation = aiData.entities.find(e => e.type === 'LOCATION');
            if (firstLocation) {
                geolocation = await geocodeLocation(firstLocation.name, mapsApiKey);
            }
        }

        // Determinar categoria de canal a partir do nome da fonte
        const sourceName = normalizedArticle?.source?.name || normalizedArticle?.sourceName || '';
        const channelCategory = getChannelCategory(sourceName);
        // Checar se canal está permitido para a empresa
        const enabledChannels = Array.isArray(company.captureChannels) ? company.captureChannels : [];
        const channelEnabled = enabledChannels.length === 0 || enabledChannels.includes(channelCategory);
        if (!channelEnabled) {
            return; // pular artigo se canal não permitido
        }

        const articleData = {
            ...normalizedArticle,
            keywords: finalMatchedKeywords,
            companyId: company.companyId,
            companyName: company.companyName,
            status: "pending",
            ai: aiData,
            sentiment: { score: aiData.sentiment.score, magnitude: aiData.sentiment.magnitude },
            translationInfo: { translated: translatedTitle.translated || translatedDesc.translated, originalLanguage: translatedTitle.languageCode },
            geolocation: geolocation,
            channel: channelCategory
        };

        const pendingAlertRef = db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).doc();
        const batch = db.batch();
        batch.set(pendingAlertRef, articleData);
        await batch.commit();
        
        company.existingUrls.add(normalizedArticle.url);
        articlesToSaveCount++;
    };

    for (const company of allCompaniesData) {
        functions.logger.info(`--- Processando empresa: ${company.companyName} ---`);
        const combinedQuery = company.keywordsList.map(kw => `"${kw}"`).join(" OR ");
        
        if (canRunGNews && settings.apiKeyGNews1) {
            const currentHour = new Date().getHours();
            let gnewsApiKey = settings.apiKeyGNews4;
            if (currentHour >= 0 && currentHour < 6) gnewsApiKey = settings.apiKeyGNews1;
            else if (currentHour >= 6 && currentHour < 12) gnewsApiKey = settings.apiKeyGNews2;
            else if (currentHour >= 12 && currentHour < 18) gnewsApiKey = settings.apiKeyGNews3;
            if (gnewsApiKey) {
                executedGNews = true;
                for (const keyword of company.keywordsList) {
                    await delay(1000);
                    const searchQuery = `"${keyword}"`;
                    const queryUrl = `${GNEWS_URL}?q=${encodeURIComponent(searchQuery)}&lang=pt,en,es&token=${gnewsApiKey}`;
                    try {
                        const response = await axios.get(queryUrl);
                        if (response.data && response.data.articles) {
                            for (const article of response.data.articles) {
                                // Capturar site de origem e preparar para inclusão automática em RSS
                                const siteUrl = article?.source?.url;
                                if (siteUrl) {
                                    try {
                                        const u = new URL(siteUrl);
                                        newRssSites.add(u.origin);
                                    } catch {
                                        newRssSites.add(siteUrl);
                                    }
                                }
                                if (!company.fetchOnlyNew || new Date(article.publishedAt) >= twentyFourHoursAgo) {
                                    const normalized = normalizeArticle(article, 'gnews');
                                    await processAndSaveArticle(normalized, company, [keyword]);
                                }
                            }
                        }
                    } catch (e) { functions.logger.error(`Erro GNews (keyword: ${keyword}):`, e.message); }
                }
            }
        }
        
        if (settings.apiKeyNewsApi) {
            await delay(1000);
            const queryUrl = `${NEWSAPI_URL}?q=${encodeURIComponent(combinedQuery)}&language=pt,en,es&apiKey=${settings.apiKeyNewsApi}`;
            try {
                const response = await axios.get(queryUrl);
                if (response.data && response.data.articles) {
                    for (const article of response.data.articles) {
                        const matchedKeywords = findMatchingKeywords(article, company.keywordsList);
                        if (matchedKeywords.length > 0 && (!company.fetchOnlyNew || new Date(article.publishedAt) >= twentyFourHoursAgo)) {
                            const normalized = normalizeArticle(article, 'newsapi');
                            await processAndSaveArticle(normalized, company, matchedKeywords);
                        }
                    }
                }
            } catch (e) { functions.logger.error(`Erro NewsAPI para ${company.companyName}:`, e.message); }
        }

        // YouTube por canais configurados, com portão baseado em frequência
        if (settings.apiKeyYoutube && canRunYouTubeChannels && youtubeChannels.length > 0) {
             functions.logger.info(`--- Buscando YouTube por canais (${youtubeChannels.length}) sob gate específico de canais ---`);
             executedYouTubeChannels = true;
             for (const channelId of youtubeChannels) {
                await delay(1000);
                const publishedAfter = lastRun ? (lastRun.toDate ? lastRun.toDate().toISOString() : new Date(lastRun).toISOString()) : new Date(now.getTime() - youtubeFrequencyHours*60*60*1000).toISOString();
                // Para playlistItems.list, precisamos do uploads playlist do canal.
                // Obter a playlist padrão "uploads" via atalho: UCxxxx -> UUxxxx (mapeamento padrão do YouTube)
                const uploadsPlaylistId = channelId.startsWith('UC') ? `UU${channelId.substring(2)}` : channelId;
                const queryUrl = `${YOUTUBE_PLAYLIST_ITEMS_URL}?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=50&key=${settings.apiKeyYoutube}`;
                 try {
                     const response = await axios.get(queryUrl);
                     if (response.data && response.data.items) {
                         for (const item of response.data.items) {
                             if (!company.fetchOnlyNew || new Date(item.snippet.publishedAt) >= twentyFourHoursAgo) {
                                 const normalized = normalizeArticle({ ...item, id: { videoId: item.snippet?.resourceId?.videoId } }, 'youtube');
                                 const matchedKeywords = findMatchingKeywords(normalized, company.keywordsList);
                                 if (matchedKeywords.length > 0) {
                                     await processAndSaveArticle(normalized, company, matchedKeywords);
                                 }
                             }
                         }
                     }
                 } catch (e) { functions.logger.error(`Erro YouTube canal ${channelId} para ${company.companyName}:`, e.message); }
                // Auto-add channel to playlist if not present (only during frequency-gated search)
                if (!youtubeChannels.includes(channelId)) {
                    try {
                        const updatedList = [...youtubeChannels, channelId].join('\n');
                        await globalSettingsRef.set({ youtubeChannels: updatedList }, { merge: true });
                        functions.logger.info(`Canal adicionado à playlist de IDs: ${channelId}`);
                        youtubeChannels.push(channelId);
                    } catch (err) {
                        functions.logger.error(`Falha ao adicionar canal ${channelId} à playlist:`, err.message);
                    }
                }
            }
            // Atualiza última execução do RSS quando a busca por canais do YouTube roda sob esse gate
            try {
                await globalSettingsRef.set({ youtubeChannelsLastRun: admin.firestore.Timestamp.now() }, { merge: true });
            functions.logger.info(`youtubeChannelsLastRun atualizado (YouTube por canais).`);
        } catch (e) {
            functions.logger.error(`Falha ao atualizar youtubeChannelsLastRun (YouTube por canais):`, e.message);
            }
        }

        // CORREÇÃO: Lógica de busca do YouTube por palavra-chave mantida (sem portão)
        if (settings.apiKeyYoutube && canRunYouTube) {
            executedYouTubeKeywords = true;
            for (const keyword of company.keywordsList) {
               await delay(500);
               const queryUrl = `${YOUTUBE_URL}?part=snippet&q=${encodeURIComponent(`"${keyword}"`)}&type=video&key=${settings.apiKeyYoutube}`;
               try {
                    const response = await axios.get(queryUrl);
                    if (response.data && response.data.items) {
                        for (const item of response.data.items) {
                            if (!company.fetchOnlyNew || new Date(item.snippet.publishedAt) >= twentyFourHoursAgo) {
                                const normalized = normalizeArticle({ ...item, id: { videoId: item.id.videoId } }, 'youtube');
                                await processAndSaveArticle(normalized, company, [keyword]);
                                // Auto-add discovered channel to playlist when frequency gate is open
                                const discoveredChannelId = item?.snippet?.channelId;
                                if (canRunYouTube && discoveredChannelId && !youtubeChannels.includes(discoveredChannelId)) {
                                    try {
                                        const updatedList = [...youtubeChannels, discoveredChannelId].join('\n');
                                        await globalSettingsRef.set({ youtubeChannels: updatedList }, { merge: true });
                                        functions.logger.info(`Canal descoberto adicionado à playlist: ${discoveredChannelId}`);
                                        youtubeChannels.push(discoveredChannelId);
                                    } catch (err) {
                                        functions.logger.error(`Falha ao adicionar canal descoberto ${discoveredChannelId}:`, err.message);
                                    }
                                }
                            }
                        }
                    }
               } catch (e) { functions.logger.error(`Erro YouTube (keyword: ${keyword}):`, e.message); }
            }
        } else if (settings.apiKeyYoutube && !canRunYouTube) {
            functions.logger.info("Gate do YouTube por palavras-chave ativo — aguardando janela de frequência/horário.");
        }
        if (settings.apiKeyYoutube && !canRunYouTubeChannels && youtubeChannels.length > 0) {
            functions.logger.info("Gate específico de canais do YouTube ativo — aguardando janela de frequência.");
        }
    }

    const rssUrls = settings.rssUrl ? settings.rssUrl.split('\n').filter(url => url.trim() !== '') : [];
    if (rssUrls.length > 0 && canRunRSS) {
        functions.logger.info(`--- Processando ${rssUrls.length} Feeds RSS para todas as empresas ---`);
        executedRSS = true;
        for (const rssUrl of rssUrls) {
            try {
                await delay(1000);
                const feed = await parser.parseURL(rssUrl);
                if (feed && feed.items) {
                    for (const item of feed.items) {
                        // Propagar o nome e link do feed para o item, para que o "Fonte" seja correto
                        try {
                            item.feedTitle = feed.title || (feed.link ? new URL(feed.link).hostname.replace(/^www\./, '') : new URL(rssUrl).hostname.replace(/^www\./, ''));
                            item.feedLink = feed.link || rssUrl;
                        } catch (_) {
                            item.feedTitle = feed.title || 'RSS';
                            item.feedLink = feed.link || rssUrl;
                        }
                        for (const company of allCompaniesData) {
                             const matchedKeywords = findMatchingKeywords(item, company.keywordsList);
                             if (matchedKeywords.length > 0 && (!company.fetchOnlyNew || new Date(item.isoDate) >= twentyFourHoursAgo)) {
                                const normalized = normalizeArticle(item, 'rss');
                                await processAndSaveArticle(normalized, company, matchedKeywords);
                            }
                        }
                    }
                }
            } catch (e) {
                functions.logger.error(`Erro ao buscar o feed RSS: ${rssUrl}. Mensagem: ${e.message}`);
            }
        }
        // Atualiza última execução do RSS se gate foi utilizado
        try {
            await globalSettingsRef.set({ rssLastRun: admin.firestore.Timestamp.now() }, { merge: true });
            functions.logger.info(`rssLastRun atualizado.`);
        } catch (e) {
            functions.logger.error(`Falha ao atualizar rssLastRun:`, e.message);
        }
    } else if (rssUrls.length > 0 && !canRunRSS) {
        functions.logger.info(`Gate de RSS ativo. Próxima execução em ${rssFrequencyMinutes} minuto(s).`);
    }
    
    // Atualiza última execução do YouTube se gate foi utilizado
    if (canRunYouTube && executedYouTubeKeywords) {
        try {
            await globalSettingsRef.set({ youtubeLastRun: admin.firestore.Timestamp.now() }, { merge: true });
            functions.logger.info(`youtubeLastRun atualizado.`);
        } catch (e) {
            functions.logger.error(`Falha ao atualizar youtubeLastRun:`, e.message);
        }
    }
    // Descoberta automática e inclusão de feeds RSS válidos a partir dos sites capturados via GNews
    if (executedGNews && newRssSites.size > 0) {
        try {
            const discoveredFeeds = new Set();
            for (const site of newRssSites) {
                const feeds = await discoverRssFeeds(site);
                feeds.forEach(f => discoveredFeeds.add(f));
            }
            if (discoveredFeeds.size > 0) {
                const existingRssList = (settings.rssUrl || '').split('\n').map(s => s.trim()).filter(s => s);
                const existingSet = new Set(existingRssList);
                discoveredFeeds.forEach(f => { if (!existingSet.has(f)) existingSet.add(f); });
                const updatedList = Array.from(existingSet).join('\n');
                await globalSettingsRef.set({ rssUrl: updatedList }, { merge: true });
                functions.logger.info(`rssUrl atualizado com ${discoveredFeeds.size} feed(s) RSS válidos descobertos automaticamente.`);
            } else {
                functions.logger.warn(`Nenhum endpoint RSS válido descoberto para ${newRssSites.size} site(s) capturados do GNews.`);
            }
        } catch (e) {
            functions.logger.error(`Falha ao atualizar rssUrl automático (descoberta de feeds):`, e.message);
        }
    }
    // Atualiza última execução do GNews se gate foi utilizado
    if (executedGNews) {
        try {
            await globalSettingsRef.set({ gnewsLastRun: admin.firestore.Timestamp.now() }, { merge: true });
            functions.logger.info(`gnewsLastRun atualizado.`);
        } catch (e) {
            functions.logger.error(`Falha ao atualizar gnewsLastRun:`, e.message);
        }
    }

    functions.logger.info(`Busca concluída. ${articlesToSaveCount} novos artigos únicos foram guardados na fila de aprovação.`);
    return { success: true, totalSaved: articlesToSaveCount };
}

exports.manualFetch = regionalFunctions.https.onCall(async (data, context) => {
    try {
        return await fetchAllNews();
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função manualFetch:", error);
        throw new functions.https.HttpsError("internal", "Ocorreu um erro interno no servidor.", error.message);
    }
});

exports.scheduledFetch = regionalFunctions.pubsub.schedule("every 10 minutes")
  .timeZone("America/Sao_Paulo")
  .onRun(async (context) => {
    try {
        await fetchAllNews();
        return null;
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função scheduledFetch:", error);
        return null;
    }
});
exports.approveAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários."); }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    const pendingAlertDoc = await pendingAlertRef.get();
    if (!pendingAlertDoc.exists) { throw new functions.https.HttpsError("not-found", "Alerta pendente não encontrado."); }
    const alertData = pendingAlertDoc.data();
    if (!alertData) { throw new functions.https.HttpsError("internal", "Dados do alerta estão corrompidos."); }
    const companyId = alertData.companyId;
    await db.collection(`artifacts/${appId}/users/${companyId}/articles`).add({ ...alertData, status: "approved", approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    await pendingAlertRef.delete();
    const settingsRef = db.doc(`artifacts/${appId}/public/data/settings/${companyId}`);
    await db.runTransaction(async (transaction) => {
        const settingsDoc = await transaction.get(settingsRef);
        const newAlertsCount = (settingsDoc.data()?.newAlertsCount || 0) + 1;
        transaction.set(settingsRef, { newAlertsCount }, { merge: true });
    });
    return { success: true };
});

exports.rejectAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, alertId } = data;
    if (!appId || !alertId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e do alerta são necessários."); }
    const pendingAlertRef = db.doc(`artifacts/${appId}/public/data/pendingAlerts/${alertId}`);
    await pendingAlertRef.delete();
    return { success: true };
});

async function deleteCollection(collectionRef) {
    const snapshot = await collectionRef.get();
    if (snapshot.size === 0) return;
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
}

exports.deleteCompany = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId } = data;
    if (!appId || !companyId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da empresa são necessários."); }
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

exports.deleteKeywordAndArticles = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, keyword } = data;
    if (!appId || !companyId || !keyword) { throw new functions.https.HttpsError("invalid-argument", "ID da aplicação, da empresa e palavra-chave são necessários."); }
    const articlesToDelete = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).where("keywords", "array-contains", keyword).get();
    const batch = db.batch();
    articlesToDelete.docs.forEach(doc => { batch.delete(doc.ref); });
    await batch.commit();
    const keywordRef = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).where("word", "==", keyword).get();
    if (!keywordRef.empty) {
        await db.doc(`artifacts/${appId}/users/${companyId}/keywords/${keywordRef.docs[0].id}`).delete();
    }
    return { success: true };
});

exports.transferKeywordAndHistory = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, sourceCompanyId, destCompanyId, keyword } = data || {};
    if (!appId || !sourceCompanyId || !destCompanyId || !keyword) {
        throw new functions.https.HttpsError("invalid-argument", "ID da aplicação, empresas de origem/destino e palavra-chave são necessários.");
    }
    if (sourceCompanyId === destCompanyId) {
        throw new functions.https.HttpsError("failed-precondition", "A empresa de origem e destino devem ser diferentes.");
    }

    // Validar empresas e obter nomes
    const sourceCompanyRef = db.doc(`artifacts/${appId}/public/data/companies/${sourceCompanyId}`);
    const destCompanyRef = db.doc(`artifacts/${appId}/public/data/companies/${destCompanyId}`);
    const [sourceCompanyDoc, destCompanyDoc] = await Promise.all([sourceCompanyRef.get(), destCompanyRef.get()]);
    if (!sourceCompanyDoc.exists) throw new functions.https.HttpsError("not-found", "Empresa de origem não encontrada.");
    if (!destCompanyDoc.exists) throw new functions.https.HttpsError("not-found", "Empresa de destino não encontrada.");
    const sourceCompanyName = sourceCompanyDoc.data()?.name || sourceCompanyId;
    const destCompanyName = destCompanyDoc.data()?.name || destCompanyId;

    // Transferir documento da palavra-chave
    let keywordMoved = false;
    try {
        const srcKwSnap = await db.collection(`artifacts/${appId}/users/${sourceCompanyId}/keywords`).where("word", "==", keyword).get();
        if (!srcKwSnap.empty) {
            const kwDoc = srcKwSnap.docs[0];
            const kwData = kwDoc.data();
            // Evitar duplicação na empresa de destino
            const destKwSnap = await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).where("word", "==", keyword).get();
            if (destKwSnap.empty) {
                await db.doc(`artifacts/${appId}/users/${destCompanyId}/keywords/${kwDoc.id}`).set(kwData);
            }
            await kwDoc.ref.delete();
            keywordMoved = true;
        } else {
            // Se não existir na origem, garantir que exista na destino (opcional)
            const destKwSnap = await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).where("word", "==", keyword).get();
            if (destKwSnap.empty) {
                await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).add({ word: keyword, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                keywordMoved = true;
            }
        }
    } catch (e) {
        functions.logger.error("Falha ao mover palavra-chave:", String(e));
        throw new functions.https.HttpsError("internal", "Falha ao mover palavra-chave.");
    }

    // Transferir artigos aprovados que contenham a keyword
    let transferredArticlesCount = 0;
    const movedArticleIds = new Set();
    try {
        const srcArticlesSnap = await db.collection(`artifacts/${appId}/users/${sourceCompanyId}/articles`).where("keywords", "array-contains", keyword).get();
        const docs = srcArticlesSnap.docs;
        let batch = db.batch();
        let ops = 0;
        for (const docSnap of docs) {
            const dataDoc = docSnap.data();
            const destArticleRef = db.doc(`artifacts/${appId}/users/${destCompanyId}/articles/${docSnap.id}`);
            const newData = { ...dataDoc, companyId: destCompanyId, companyName: destCompanyName };
            batch.set(destArticleRef, newData);
            batch.delete(docSnap.ref);
            movedArticleIds.add(docSnap.id);
            transferredArticlesCount++;
            ops += 2;
            if (ops >= 400) { // margem para limite de 500
                await batch.commit();
                batch = db.batch();
                ops = 0;
            }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) {
        functions.logger.error("Falha ao transferir artigos:", String(e));
        throw new functions.https.HttpsError("internal", "Falha ao transferir artigos.");
    }

    // Atualizar pendências na fila de aprovação (pendingAlerts) que contenham a keyword
    let transferredPendingAlertsCount = 0;
    try {
        const pendingSnap = await db.collection(`artifacts/${appId}/public/data/pendingAlerts`)
            .where("companyId", "==", sourceCompanyId)
            .where("keywords", "array-contains", keyword)
            .get();
        let batch = db.batch();
        let ops = 0;
        for (const pdoc of pendingSnap.docs) {
            batch.update(pdoc.ref, { companyId: destCompanyId, companyName: destCompanyName });
            transferredPendingAlertsCount++;
            ops += 1;
            if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) {
        functions.logger.error("Falha ao atualizar pendências (pendingAlerts):", String(e));
        throw new functions.https.HttpsError("internal", "Falha ao atualizar pendências.");
    }

    // Transferir solicitações de exclusão relacionadas aos artigos movidos
    let transferredDeletionRequestsCount = 0;
    try {
        const delReqSnap = await db.collection(`artifacts/${appId}/public/data/deletionRequests`).where("companyId", "==", sourceCompanyId).get();
        let batch = db.batch();
        let ops = 0;
        for (const rdoc of delReqSnap.docs) {
            const rdata = rdoc.data();
            const articleId = rdata.articleId;
            if (articleId && movedArticleIds.has(articleId)) {
                batch.update(rdoc.ref, { companyId: destCompanyId, companyName: destCompanyName });
                transferredDeletionRequestsCount++;
                ops += 1;
                if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
            }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) {
        functions.logger.error("Falha ao transferir solicitações de exclusão:", String(e));
        throw new functions.https.HttpsError("internal", "Falha ao transferir solicitações de exclusão.");
    }

    return {
        success: true,
        keywordMoved,
        transferredArticlesCount,
        transferredPendingAlertsCount,
        transferredDeletionRequestsCount
    };
});

exports.manageDeletionRequest = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, requestId, approve } = data;
    if (!appId || !requestId) { throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da solicitação são necessários."); }
    const requestRef = db.doc(`artifacts/${appId}/public/data/deletionRequests/${requestId}`);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) { throw new functions.https.HttpsError("not-found", "Solicitação de exclusão não encontrada."); }
    const requestData = requestDoc.data();
    if (!requestData) { throw new functions.https.HttpsError("internal", "Dados da solicitação estão corrompidos."); }
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

exports.requestAlertDeletion = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, companyName, articleId, articleTitle, justification } = data;
    if (!appId || !companyId || !articleId || !justification) { throw new functions.https.HttpsError("invalid-argument", "Informações incompletas para a solicitação de exclusão."); }
    await db.collection(`artifacts/${appId}/public/data/deletionRequests`).add({ companyId, companyName, articleId, articleTitle, justification, status: "pending", requestedAt: admin.firestore.FieldValue.serverTimestamp() });
    const articleRef = db.doc(`artifacts/${appId}/users/${companyId}/articles/${articleId}`);
    await articleRef.update({ deletionRequestStatus: 'pending' });
    return { success: true };
});


function getChannelCategory(sourceName) {
    const name = (sourceName || "").toLowerCase();
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


exports.getCompanyKeywordReport = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, startDate, endDate } = data || {};
    if (!appId || !companyId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da empresa são necessários.");
    }
    functions.logger.info(`Gerando detalhes por palavra-chave para empresa ${companyId}...`);

    // Converter datas (se fornecidas) para Timestamp do Firestore com limites diários
    let startTs = null;
    let endTs = null;
    try {
        if (startDate) {
            const sd = new Date(startDate);
            if (!isNaN(sd)) {
                sd.setHours(0, 0, 0, 0);
                startTs = admin.firestore.Timestamp.fromDate(sd);
            }
        }
        if (endDate) {
            const ed = new Date(endDate);
            if (!isNaN(ed)) {
                ed.setHours(23, 59, 59, 999);
                endTs = admin.firestore.Timestamp.fromDate(ed);
            }
        }
    } catch (e) {
        functions.logger.warn("Datas de relatório inválidas recebidas para getCompanyKeywordReport:", { startDate, endDate, error: String(e) });
    }

    // Construir consulta com filtros de período, se houver
    let articlesQuery = db.collection(`artifacts/${appId}/users/${companyId}/articles`);
    if (startTs) articlesQuery = articlesQuery.where('publishedAt', '>=', startTs);
    if (endTs) articlesQuery = articlesQuery.where('publishedAt', '<=', endTs);
    const articlesSnapshot = await articlesQuery.get();

    const acc = new Map();

    articlesSnapshot.forEach(doc => {
        const article = doc.data() || {};
        const keywords = Array.isArray(article.keywords) ? article.keywords : [];
        const score = article.sentiment?.score ?? 0;
        const channel = (article.channel || (article.source?.name ? getChannelCategory(article.source.name) : 'Outros'));
        const vehicle = article.source?.name || 'Outros';
        let sentiment = 'neutral';
        if (score > 0.2) sentiment = 'positive';
        else if (score < -0.2) sentiment = 'negative';

        keywords.forEach(k => {
            const key = String(k || '').trim();
            if (!key) return;
            let row = acc.get(key);
            if (!row) {
                row = { keyword: key, totalAlerts: 0, counts: { positive: 0, neutral: 0, negative: 0 }, channelCounts: {}, vehicleCounts: {} };
                acc.set(key, row);
            }
            row.totalAlerts++;
            row.counts[sentiment]++;
            row.channelCounts[channel] = (row.channelCounts[channel] || 0) + 1;
            row.vehicleCounts[vehicle] = (row.vehicleCounts[vehicle] || 0) + 1;
        });
    });

    const result = Array.from(acc.values()).map(row => {
        const totalSentiments = row.counts.positive + row.counts.neutral + row.counts.negative;
        const sentimentPercentage = {
            positive: totalSentiments > 0 ? parseFloat(((row.counts.positive / totalSentiments) * 100).toFixed(2)) : 0,
            neutral: totalSentiments > 0 ? parseFloat(((row.counts.neutral / totalSentiments) * 100).toFixed(2)) : 0,
            negative: totalSentiments > 0 ? parseFloat(((row.counts.negative / totalSentiments) * 100).toFixed(2)) : 0,
        };
        const predominantSentiment = getPredominantSentiment(sentimentPercentage);
        const topChannel = getTopCount(row.channelCounts);
        const topVehicle = getTopCount(row.vehicleCounts);
        return { keyword: row.keyword, totalAlerts: row.totalAlerts, sentimentPercentage, predominantSentiment, topChannel, topVehicle };
    }).sort((a, b) => b.totalAlerts - a.totalAlerts);

    functions.logger.info(`Detalhes por palavra-chave gerados para empresa ${companyId}. Total de keywords: ${result.length}`);
    return result;
});



function resolveFriendlySourceNameFromUrl(urlStr, fallbackName) {
  try {
    const lower = (urlStr || '').toLowerCase();
    // Se já há um nome específico, mantenha
    if (fallbackName && !['rss', 'RSS', 'RSS Feed'].includes(fallbackName)) {
      return fallbackName;
    }
    // Mapeamentos amigáveis conhecidos
    if (lower.includes('metropoles.com')) return 'Metrópoles';
    if (lower.includes('marretaurgente')) return 'Marreta Urgente';
    // Caso contrário, derive do hostname
    try {
      const host = new URL(urlStr).hostname.replace(/^www\./, '');
      return host || (fallbackName || 'RSS');
    } catch {
      return fallbackName || 'RSS';
    }
  } catch {
    return fallbackName || 'RSS';
  }
}

exports.backfillRssSourceNames = regionalFunctions.https.onCall(async (data, context) => {
  const appId = data?.appId || APP_ID;
  const dryRun = !!data?.dryRun;
  let companiesProcessed = 0;
  let articlesChecked = 0;
  let articlesUpdated = 0;
  let pendingChecked = 0;
  let pendingUpdated = 0;

  functions.logger.info(`Iniciando backfill de nomes de fonte RSS (appId=${appId}, dryRun=${dryRun})`);

  const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
  for (const companyDoc of companiesSnapshot.docs) {
    const companyId = companyDoc.id;
    companiesProcessed++;
    // Artigos aprovados
    const articlesRef = db.collection(`artifacts/${appId}/users/${companyId}/articles`);
    const articlesQuery = await articlesRef.where('source.name', 'in', ['RSS', 'RSS Feed']).get();
    for (const doc of articlesQuery.docs) {
      const data = doc.data();
      articlesChecked++;
      const currentName = data?.source?.name || 'RSS';
      const urlStr = data?.source?.url || data?.url || '';
      const friendly = resolveFriendlySourceNameFromUrl(urlStr, currentName);
      if (friendly && friendly !== currentName) {
        if (!dryRun) {
          await doc.ref.update({ 'source.name': friendly });
        }
        articlesUpdated++;
      }
    }
    // Pendências
    const pendingRef = db.collection(`artifacts/${appId}/public/data/pendingAlerts`);
    const pendingQuery = await pendingRef.where('companyId', '==', companyId).where('source.name', 'in', ['RSS', 'RSS Feed']).get();
    for (const doc of pendingQuery.docs) {
      const data = doc.data();
      pendingChecked++;
      const currentName = data?.source?.name || 'RSS';
      const urlStr = data?.source?.url || data?.url || '';
      const friendly = resolveFriendlySourceNameFromUrl(urlStr, currentName);
      if (friendly && friendly !== currentName) {
        if (!dryRun) {
          await doc.ref.update({ 'source.name': friendly });
        }
        pendingUpdated++;
      }
    }
  }

  const result = { success: true, appId, dryRun, companiesProcessed, articlesChecked, articlesUpdated, pendingChecked, pendingUpdated };
  functions.logger.info(`Backfill concluído: ${JSON.stringify(result)}`);
  return result;
});




exports.manualAddAlert = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, url } = data || {};
    if (!appId || !companyId || !url) {
        throw new functions.https.HttpsError("invalid-argument", "ID da aplicação, da empresa e URL do artigo são necessários.");
    }

    // Validar empresa
    const companyDoc = await db.doc(`artifacts/${appId}/public/data/companies/${companyId}`).get();
    if (!companyDoc.exists) {
        throw new functions.https.HttpsError("not-found", "Empresa não encontrada.");
    }
    const companyName = companyDoc.data()?.name || companyId;

    // Extrair metadados básicos da página
    let pageHtml = "";
    let title = "";
    let description = "";
    try {
        const resp = await axios.get(url, { timeout: 10000 });
        pageHtml = String(resp.data || "");
        const ogTitleMatch = pageHtml.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i);
        if (ogTitleMatch && ogTitleMatch[1]) {
            title = ogTitleMatch[1].trim();
        } else {
            const titleTagMatch = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (titleTagMatch && titleTagMatch[1]) title = titleTagMatch[1].trim();
        }
        const ogDescMatch = pageHtml.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) || pageHtml.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
        if (ogDescMatch && ogDescMatch[1]) description = ogDescMatch[1].trim();
    } catch (e) {
        functions.logger.warn("Falha ao buscar/parsear página para alerta manual:", String(e));
    }

    // Resolver nome da fonte e canal
    let sourceName = "";
    try {
        const u = new URL(url);
        sourceName = resolveFriendlySourceNameFromUrl(u.href, u.hostname || "Site");
    } catch {
        sourceName = resolveFriendlySourceNameFromUrl(url, "Site");
    }
    const channelValue = getChannelCategory(sourceName);

    // Obter keywords da empresa e tentar casar com título/descrição
    let companyKeywords = [];
    try {
        const ksnap = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).get();
        companyKeywords = ksnap.docs.map(d => String(d.data()?.word || "").trim()).filter(Boolean);
    } catch (e) {
        functions.logger.warn("Falha ao carregar keywords da empresa:", String(e));
    }
    const articleForMatch = { title, description };
    const matchedKeywords = findMatchingKeywords(articleForMatch, companyKeywords);

    // Gating de canal: verificar se empresa permite este canal
    let captureChannels = [];
    try {
        const settingsDoc = await db.doc(`artifacts/${appId}/public/data/settings/${companyId}`).get();
        captureChannels = settingsDoc.exists ? (settingsDoc.data()?.captureChannels || []) : [];
    } catch (e) {
        functions.logger.warn("Falha ao carregar configurações da empresa:", String(e));
    }
    const channelEnabled = captureChannels.length === 0 || captureChannels.includes(channelValue);
    if (!channelEnabled) {
        return { success: true, skipped: true, reason: 'channel_disabled', channel: channelValue };
    }

    // Enviar para fila de aprovação com o link do artigo
    const alertData = {
        title: title || url,
        description: description || "",
        url,
        source: { name: sourceName, url },
        author: null,
        channel: channelValue,
        publishedAt: admin.firestore.FieldValue.serverTimestamp(),
        keywords: matchedKeywords,
        companyId,
        companyName,
        status: "pending",
    };

    const pendingRef = await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).add(alertData);
    return { success: true, pendingId: pendingRef.id };
});

function getChannelCategory(sourceName) {
    const name = (sourceName || "").toLowerCase();
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

exports.generateSuperAdminReport = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, startDate, endDate } = data || {};
    if (!appId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação é necessário.");
    }
    functions.logger.info("Iniciando geração do relatório geral de empresas...");

    // Converter datas (se fornecidas) para Timestamp do Firestore com limites diários
    let startTs = null;
    let endTs = null;
    try {
        if (startDate) {
            const sd = new Date(startDate);
            if (!isNaN(sd)) {
                sd.setHours(0, 0, 0, 0);
                startTs = admin.firestore.Timestamp.fromDate(sd);
            }
        }
        if (endDate) {
            const ed = new Date(endDate);
            if (!isNaN(ed)) {
                ed.setHours(23, 59, 59, 999);
                endTs = admin.firestore.Timestamp.fromDate(ed);
            }
        }
    } catch (e) {
        functions.logger.warn("Datas de relatório inválidas recebidas:", { startDate, endDate, error: String(e) });
    }

    const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
    const reportData = [];
    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
        functions.logger.info(`Processando relatório para: ${companyName} (ID: ${companyId})`);

        // Construir consulta com filtros de período, se houver
        let articlesQuery = db.collection(`artifacts/${appId}/users/${companyId}/articles`);
        if (startTs) articlesQuery = articlesQuery.where('publishedAt', '>=', startTs);
        if (endTs) articlesQuery = articlesQuery.where('publishedAt', '<=', endTs);
        const articlesSnapshot = await articlesQuery.get();
        const totalAlerts = articlesSnapshot.size;

        let positiveCount = 0, neutralCount = 0, negativeCount = 0;
        const channelCounts = {}, vehicleCounts = {};

        if (articlesSnapshot.size > 0) {
            articlesSnapshot.docs.forEach(doc => {
                const article = doc.data();
                const score = article.sentiment?.score ?? 0;
                if (score > 0.2) positiveCount++;
                else if (score < -0.2) negativeCount++;
                else neutralCount++;
                const channel = (article.channel || (article.source?.name ? getChannelCategory(article.source.name) : 'Outros'));
                channelCounts[channel] = (channelCounts[channel] || 0) + 1;
                const vehicle = article.source?.name || 'Outros';
                vehicleCounts[vehicle] = (vehicleCounts[vehicle] || 0) + 1;
            });
        }

        const totalSentiments = positiveCount + neutralCount + negativeCount;
        const sentimentPercentage = {
            positive: totalSentiments > 0 ? parseFloat(((positiveCount / totalSentiments) * 100).toFixed(2)) : 0,
            neutral: totalSentiments > 0 ? parseFloat(((neutralCount / totalSentiments) * 100).toFixed(2)) : 0,
            negative: totalSentiments > 0 ? parseFloat(((negativeCount / totalSentiments) * 100).toFixed(2)) : 0,
        };

        const predominantSentiment = getPredominantSentiment(sentimentPercentage);
        const topChannel = getTopCount(channelCounts);
        const topVehicle = getTopCount(vehicleCounts);
        reportData.push({ companyId, companyName, totalAlerts, sentimentPercentage, predominantSentiment, topChannel, topVehicle });
    }
    functions.logger.info("Relatório geral gerado com sucesso.");
    return reportData;
});

exports.generateCriticalReport = regionalFunctions.https.onCall(async (data, context) => {
    const { appId, companyId, startDate, endDate } = data || {};
    if (!appId || !companyId) {
        throw new functions.https.HttpsError("invalid-argument", "O ID da aplicação e da empresa são necessários.");
    }
    functions.logger.info("Iniciando geração do relatório de análise crítica...", { appId, companyId, startDate, endDate });

    // Converter datas para limites diários
    let start = null;
    let end = null;
    try {
        if (startDate) {
            const sd = new Date(startDate);
            if (!isNaN(sd)) { sd.setHours(0,0,0,0); start = sd; }
        }
        if (endDate) {
            const ed = new Date(endDate);
            if (!isNaN(ed)) { ed.setHours(23,59,59,999); end = ed; }
        }
    } catch (e) {
        functions.logger.warn("Datas de relatório inválidas recebidas para generateCriticalReport:", { startDate, endDate, error: String(e) });
    }

    // Buscar artigos aprovados da empresa
    const articlesSnap = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).get();

    const articles = [];
    const channelCounts = {};
    const vehicleCounts = {};
    const valuation = {};
    const dateCounts = {};
    const keywordCounts = {};

    for (const doc of articlesSnap.docs) {
        const a = doc.data();
        // Resolver a data do artigo
        let d = null;
        try {
            if (a.publishedAt && typeof a.publishedAt.toDate === 'function') {
                d = a.publishedAt.toDate();
            } else if (a.approvedAt && typeof a.approvedAt.toDate === 'function') {
                d = a.approvedAt.toDate();
            }
        } catch (_) {}
        // Aplicar filtro de período (se fornecido)
        if (start && d && d < start) continue;
        if (end && d && d > end) continue;

        articles.push(a);

        const ch = (a.channel || (a.source?.name ? getChannelCategory(a.source.name) : 'Outros'));
        channelCounts[ch] = (channelCounts[ch] || 0) + 1;

        const veh = (a.source?.name || 'Desconhecido');
        vehicleCounts[veh] = (vehicleCounts[veh] || 0) + 1;

        if (d) {
            const key = d.toISOString().slice(0,10);
            dateCounts[key] = (dateCounts[key] || 0) + 1;
        }

        const val = (a?.sentiment?.label || a?.valuation || 'Neutro');
        valuation[val] = (valuation[val] || 0) + 1;

        if (Array.isArray(a.keywords)) {
            a.keywords.forEach(k => {
                if (typeof k === 'string' && k.trim()) {
                    const kk = k.trim();
                    keywordCounts[kk] = (keywordCounts[kk] || 0) + 1;
                }
            });
        }
    }

    const topChannel = Object.keys(channelCounts).length ? Object.keys(channelCounts).reduce((a, b) => channelCounts[a] > channelCounts[b] ? a : b) : null;
    const topVehicle = Object.keys(vehicleCounts).length ? Object.keys(vehicleCounts).reduce((a, b) => vehicleCounts[a] > vehicleCounts[b] ? a : b) : null;
    const totalAlerts = articles.length;

    functions.logger.info("Relatório de análise crítica gerado com sucesso.", { totalAlerts });
    // spaceCounts e spaceQualCounts podem ser adicionados futuramente se os campos existirem nos artigos
    return { articles, channelCounts, vehicleCounts, valuation, dateCounts, keywordCounts, topChannel, topVehicle, totalAlerts };
});


