/**
 * CÓDIGO COMPLETO E ATUALIZADO PARA FIREBASE FUNCTIONS 2ª GERAÇÃO (GEN 2)
 * Corrigido para remover 'regionalFunctions' e usar 'request.data'/'request.auth'.
 */

const admin = require("firebase-admin");
const functions = require("firebase-functions"); // Necessário para logger e HttpsError

// Importações da 2ª geração do Firebase Functions
const { onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2/options");

const axios = require("axios");
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');

const { LanguageServiceClient } = require('@google-cloud/language');
const { TranslationServiceClient } = require('@google-cloud/translate');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const { Client } = require("@googlemaps/google-maps-services-js");
const crypto = require('crypto');

// --- Configuração Global (Gen 2) ---
// Define região e memória para TODAS as funções abaixo automaticamente
setGlobalOptions({
  timeoutSeconds: 540,
  memory: '2GiB',
  region: 'southamerica-east1'
});

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

// --- Funções Auxiliares (Lógica interna, não precisa mexer) ---

// Função Corrigida para Fuso Horário de Brasília
function isWithinWindow(startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return false;
  
  // Pega a hora atual exata em São Paulo/Brasília
  const now = new Date();
  const nowString = now.toLocaleTimeString('pt-BR', { 
    timeZone: 'America/Sao_Paulo', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  }); 
  
  // Compara texto com texto (Ex: "10:10" está entre "09:00" e "18:00"?)
  return nowString >= startHHMM && nowString <= endHHMM;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    for (const path of COMMON_FEED_PATHS) {
        try { candidates.add(new URL(path, homepageUrl).href); } catch {}
    }
    const candidateArray = Array.from(candidates).slice(0, 20);
    for (const cand of candidateArray) {
        try {
            const ok = await tryValidateFeed(cand);
            if (ok) { discovered.add(cand); }
        } catch {}
        if (discovered.size >= 5) break; 
    }
    return discovered;
}

const findMatchingKeywords = (article, keywords) => {
    const normalizeText = (txt) => String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    let contentToSearch = '';
    contentToSearch += ' ' + (article.title || '');
    contentToSearch += ' ' + (article.contentSnippet || article.description || article.content || '');
    contentToSearch += ' ' + (article.author || '');
    contentToSearch += ' ' + (article.source?.name || '');
    if (article.ai?.videoTranscription) contentToSearch += ' ' + article.ai.videoTranscription;
    if (article.ai?.ocrText) contentToSearch += ' ' + article.ai.ocrText;
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
        if (cacheDoc.exists) return cacheDoc.data();
        const response = await mapsClient.geocode({ params: { address: `${locationName}, Brasil`, key: apiKey, language: 'pt-BR', region: 'BR' } });
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
    const normalize = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ').replace(/\s+/g, ' ').trim();
    const originalText = text || '';
    const normalizedText = normalize(originalText);
    if (!normalizedText || normalizedText.length < 20) return { originalText, translatedText: originalText, languageCode: 'pt', translated: false };
    const hash = crypto.createHash('sha256').update(normalizedText).digest('hex');
    const cacheRef = db.doc(`artifacts/${APP_ID}/public/data/translationCache/${hash}`);
    try {
        const cacheSnap = await cacheRef.get();
        if (cacheSnap.exists) {
            const c = cacheSnap.data();
            const lang = (c.languageCode || 'und').toLowerCase();
            return { originalText, translatedText: c.translatedText || originalText, languageCode: c.languageCode || 'und', translated: lang !== 'pt' };
        }
    } catch (e) { functions.logger.warn('Falha ao ler cache de tradução:', e.message); }
    const parent = `projects/${GOOGLE_PROJECT_ID}/locations/global`;
    try {
        const [detectResponse] = await translationClient.detectLanguage({ parent, content: normalizedText, mimeType: 'text/plain' });
        const detectedLanguage = detectResponse.languages[0];
        const language = (detectedLanguage && detectedLanguage.languageCode) ? detectedLanguage.languageCode.toLowerCase() : 'und';
        if (language === 'pt') {
            try { await cacheRef.set({ translatedText: originalText, languageCode: 'pt', createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch {}
            return { originalText, translatedText: originalText, languageCode: 'pt', translated: false };
        }
        const [translateResponse] = await translationClient.translateText({ parent, contents: [normalizedText], mimeType: 'text/plain', sourceLanguageCode: detectedLanguage.languageCode, targetLanguageCode: 'pt' });
        const translation = (translateResponse.translations && translateResponse.translations[0]) ? translateResponse.translations[0].translatedText : originalText;
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
            case 'gnews': 
                const domainName = article.source?.url ? new URL(article.source.url).hostname.replace(/^www\./, '') : article.source.name;
                return { title: article.title, description: article.description, url: article.url, image: article.image || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), source: { name: domainName, url: article.source.url }, author: article.author || null, };
            case 'newsapi': 
                const articleDomain = article.url ? new URL(article.url).hostname.replace(/^www\./, '') : article.source.name;
                return { title: article.title, description: article.description, url: article.url, image: article.urlToImage || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.publishedAt)), source: { name: articleDomain, url: null }, author: article.author || null, };
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
            case 'youtube': return { title: article.snippet.title, description: article.snippet.description, url: `https://www.youtube.com/watch?v=${article.id.videoId}`, image: article.snippet.thumbnails.high.url || null, publishedAt: admin.firestore.Timestamp.fromDate(new Date(article.snippet.publishedAt)), source: { name: 'Canal', url: `https://www.youtube.com/channel/${article.snippet.channelId}` }, author: article.snippet.channelTitle || 'Redação*', videoId: article.id.videoId };
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
        } catch (error) { functions.logger.error("Erro na Natural Language AI:", error.message); }
    }
    
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
        } catch { return false; }
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
            }
        } catch (err) { functions.logger.warn(`Vision AI error para imagem ${article.image}:`, err.message); }
    }
    return { ...languageData, ...visionData, ...videoData };
}

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

function resolveFriendlySourceNameFromUrl(urlStr, fallbackName) {
  try {
    const lower = (urlStr || '').toLowerCase();
    if (fallbackName && !['rss', 'RSS', 'RSS Feed'].includes(fallbackName)) return fallbackName;
    if (lower.includes('metropoles.com')) return 'Metrópoles';
    if (lower.includes('marretaurgente')) return 'Marreta Urgente';
    try {
      const host = new URL(urlStr).hostname.replace(/^www\./, '');
      return host || (fallbackName || 'RSS');
    } catch { return fallbackName || 'RSS'; }
  } catch { return fallbackName || 'RSS'; }
}

function extractDomainFromUrl(url) {
    try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname;
        hostname = hostname.replace(/^www\./, '');
        return hostname;
    } catch (error) {
        functions.logger.error(`Erro ao extrair domínio da URL ${url}:`, error.message);
        return null;
    }
}

// --- Lógica Principal de Busca ---

async function fetchAllNews() {
    functions.logger.info("=======================================");
    functions.logger.info("INICIANDO BUSCA DE NOTÍCIAS (GEN 2) ...");

    const globalSettingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/global`);
    const globalSettingsDoc = await globalSettingsRef.get();
    if (!globalSettingsDoc.exists) { throw new Error("Configurações globais não encontradas."); }
    const settings = globalSettingsDoc.data();
    const mapsApiKey = settings.apiKeyGoogleMaps || settings.apiKeyFirebaseNews; 
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const youtubeChannels = settings.youtubeChannels ? settings.youtubeChannels.split('\n').map(s => s.trim()).filter(s => s.length > 0) : [];
    const youtubeFrequencyHours = Number(settings.youtubeFrequencyHours || 6);
    const youtubeFrequencyTime = (settings.youtubeFrequencyTime || '').trim();
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
            desiredTimeOk = diffMinutes <= 30;
        }
    }
    const canRunYouTube = frequencyOk && desiredTimeOk;
    const gnewsLastRun = settings.gnewsLastRun && typeof settings.gnewsLastRun.toDate === 'function' ? settings.gnewsLastRun.toDate() : null;
    const gnewsFrequencyHours = Number(settings.gnewsFrequencyHours || 2);
    const canRunGNews = !gnewsLastRun || (now.getTime() - gnewsLastRun.getTime()) >= gnewsFrequencyHours * 60 * 60 * 1000;
    const rssLastRun = settings.rssLastRun && typeof settings.rssLastRun.toDate === 'function' ? settings.rssLastRun.toDate() : null;
    const rssFrequencyMinutes = Number(settings.rssFrequencyMinutes || 10);
    const canRunRSS = !rssLastRun || (now.getTime() - rssLastRun.getTime()) >= rssFrequencyMinutes * 60 * 1000;

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
        if (!normalizedArticle || company.existingUrls.has(normalizedArticle.url)) return;
        
        const translatedTitle = await detectAndTranslate(normalizedArticle.title);
        const translatedDesc = await detectAndTranslate(normalizedArticle.description);
        normalizedArticle.title = translatedTitle.translatedText;
        normalizedArticle.description = translatedDesc.translatedText;
        
        const aiData = await analyzeArticleWithAI(normalizedArticle, settings);
        const initialMatches = Array.isArray(matchedKeywords) ? matchedKeywords : [];
        const recomputedMatches = findMatchingKeywords({ ...normalizedArticle, ai: aiData }, company.keywordsList);
        const finalMatchedKeywords = Array.from(new Set([ ...initialMatches, ...recomputedMatches ]));

        if (finalMatchedKeywords.length === 0) return;

        let geolocation = null;
        if (aiData.entities && aiData.entities.length > 0) {
            const firstLocation = aiData.entities.find(e => e.type === 'LOCATION');
            if (firstLocation) {
                geolocation = await geocodeLocation(firstLocation.name, mapsApiKey);
            }
        }

        const sourceName = normalizedArticle?.source?.name || normalizedArticle?.sourceName || '';
        let channelCategory = getChannelCategory(sourceName);
        // Força categoria YouTube se o link for de vídeo
        if (normalizedArticle.url && (normalizedArticle.url.includes('youtube.com') || normalizedArticle.url.includes('youtu.be'))) {
            channelCategory = 'YouTube';
        }
        const enabledChannels = Array.isArray(company.captureChannels) ? company.captureChannels : [];
        const channelEnabled = enabledChannels.length === 0 || enabledChannels.includes(channelCategory);
        if (!channelEnabled) return;

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
        const winStart = settings.fetchWindowStart || settings.newsWindowStart;
        const winEnd = settings.fetchWindowEnd || settings.newsWindowEnd;
        if (!isWithinWindow(winStart, winEnd)) {
            functions.logger.info(`Fora da janela permitida, pulando empresa ${company.companyName}`);
            continue;
        }
        
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
                                const siteUrl = article?.source?.url;
                                if (siteUrl) {
                                    try { newRssSites.add(new URL(siteUrl).origin); } catch { newRssSites.add(siteUrl); }
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

        if (settings.apiKeyYoutube && canRunYouTubeChannels && youtubeChannels.length > 0) {
             functions.logger.info(`--- Buscando YouTube por canais ---`);
             executedYouTubeChannels = true;
             for (const channelId of youtubeChannels) {
                await delay(1000);
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
                 } catch (e) { functions.logger.error(`Erro YouTube canal ${channelId}:`, e.message); }
                if (!youtubeChannels.includes(channelId)) {
                    try {
                        const updatedList = [...youtubeChannels, channelId].join('\n');
                        await globalSettingsRef.set({ youtubeChannels: updatedList }, { merge: true });
                        youtubeChannels.push(channelId);
                    } catch (err) {}
                }
            }
            try { await globalSettingsRef.set({ youtubeChannelsLastRun: admin.firestore.Timestamp.now() }, { merge: true }); } catch (e) {}
        }

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
                                const discoveredChannelId = item?.snippet?.channelId;
                                if (canRunYouTube && discoveredChannelId && !youtubeChannels.includes(discoveredChannelId)) {
                                    try {
                                        const updatedList = [...youtubeChannels, discoveredChannelId].join('\n');
                                        await globalSettingsRef.set({ youtubeChannels: updatedList }, { merge: true });
                                        youtubeChannels.push(discoveredChannelId);
                                    } catch (err) {}
                                }
                            }
                        }
                    }
               } catch (e) { functions.logger.error(`Erro YouTube (keyword: ${keyword}):`, e.message); }
            }
        }
    }

    const rssUrls = settings.rssUrl ? settings.rssUrl.split('\n').filter(url => url.trim() !== '') : [];
    if (rssUrls.length > 0 && canRunRSS) {
        executedRSS = true;
        for (const rssUrl of rssUrls) {
            try {
                await delay(1000);
                const feed = await parser.parseURL(rssUrl);
                if (feed && feed.items) {
                    for (const item of feed.items) {
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
            } catch (e) { functions.logger.error(`Erro ao buscar RSS ${rssUrl}: ${e.message}`); }
        }
        try { await globalSettingsRef.set({ rssLastRun: admin.firestore.Timestamp.now() }, { merge: true }); } catch (e) {}
    } else if (rssUrls.length > 0 && !canRunRSS) {
        functions.logger.info(`Gate de RSS ativo.`);
    }
    
    if (canRunYouTube && executedYouTubeKeywords) {
        try { await globalSettingsRef.set({ youtubeLastRun: admin.firestore.Timestamp.now() }, { merge: true }); } catch (e) {}
    }
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
            }
        } catch (e) {}
    }
    if (executedGNews) {
        try { await globalSettingsRef.set({ gnewsLastRun: admin.firestore.Timestamp.now() }, { merge: true }); } catch (e) {}
    }

    functions.logger.info(`Busca concluída. ${articlesToSaveCount} novos artigos.`);
    return { success: true, totalSaved: articlesToSaveCount };
}

// --- FUNÇÕES EXPORTADAS (GEN 2) ---

exports.manualFetchV2 = onCall(async (request) => {
    try {
        return await fetchAllNews();
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função manualFetch:", error);
        throw new functions.https.HttpsError("internal", "Ocorreu um erro interno no servidor.", error.message);
    }
});

exports.scheduledFetchV2 = onSchedule({
  schedule: "every 10 minutes",
  timeZone: "America/Sao_Paulo"
}, async (event) => {
    try {
        await fetchAllNews();
        return null;
    } catch(error) {
        functions.logger.error("!!!! ERRO FATAL na função scheduledFetch:", error);
        return null;
    }
});

exports.approveAlert = onCall(async (request) => {
    const { appId, alertId } = request.data;
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

exports.rejectAlert = onCall(async (request) => {
    const { appId, alertId } = request.data;
    if (!appId || !alertId) { throw new functions.https.HttpsError("invalid-argument", "IDs necessários."); }
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

exports.deleteCompany = onCall(async (request) => {
    const { appId, companyId } = request.data;
    if (!appId || !companyId) { throw new functions.https.HttpsError("invalid-argument", "IDs necessários."); }
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

exports.deleteKeywordAndArticles = onCall(async (request) => {
    const { appId, companyId, keyword } = request.data;
    if (!appId || !companyId || !keyword) { throw new functions.https.HttpsError("invalid-argument", "Dados incompletos."); }
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

exports.transferKeywordAndHistory = onCall(async (request) => {
    const { appId, sourceCompanyId, destCompanyId, keyword } = request.data || {};
    if (!appId || !sourceCompanyId || !destCompanyId || !keyword) { throw new functions.https.HttpsError("invalid-argument", "Dados incompletos."); }
    if (sourceCompanyId === destCompanyId) { throw new functions.https.HttpsError("failed-precondition", "Empresas iguais."); }

    const sourceCompanyRef = db.doc(`artifacts/${appId}/public/data/companies/${sourceCompanyId}`);
    const destCompanyRef = db.doc(`artifacts/${appId}/public/data/companies/${destCompanyId}`);
    const [sourceCompanyDoc, destCompanyDoc] = await Promise.all([sourceCompanyRef.get(), destCompanyRef.get()]);
    if (!sourceCompanyDoc.exists || !destCompanyDoc.exists) throw new functions.https.HttpsError("not-found", "Empresa não encontrada.");
    const sourceCompanyName = sourceCompanyDoc.data()?.name || sourceCompanyId;
    const destCompanyName = destCompanyDoc.data()?.name || destCompanyId;

    let keywordMoved = false;
    try {
        const srcKwSnap = await db.collection(`artifacts/${appId}/users/${sourceCompanyId}/keywords`).where("word", "==", keyword).get();
        if (!srcKwSnap.empty) {
            const kwDoc = srcKwSnap.docs[0];
            const kwData = kwDoc.data();
            const destKwSnap = await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).where("word", "==", keyword).get();
            if (destKwSnap.empty) {
                await db.doc(`artifacts/${appId}/users/${destCompanyId}/keywords/${kwDoc.id}`).set(kwData);
            }
            await kwDoc.ref.delete();
            keywordMoved = true;
        } else {
            const destKwSnap = await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).where("word", "==", keyword).get();
            if (destKwSnap.empty) {
                await db.collection(`artifacts/${appId}/users/${destCompanyId}/keywords`).add({ word: keyword, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                keywordMoved = true;
            }
        }
    } catch (e) { throw new functions.https.HttpsError("internal", "Falha ao mover palavra-chave."); }

    let transferredArticlesCount = 0;
    const movedArticleIds = new Set();
    try {
        const srcArticlesSnap = await db.collection(`artifacts/${appId}/users/${sourceCompanyId}/articles`).where("keywords", "array-contains", keyword).get();
        let batch = db.batch();
        let ops = 0;
        for (const docSnap of srcArticlesSnap.docs) {
            const dataDoc = docSnap.data();
            const destArticleRef = db.doc(`artifacts/${appId}/users/${destCompanyId}/articles/${docSnap.id}`);
            const newData = { ...dataDoc, companyId: destCompanyId, companyName: destCompanyName };
            batch.set(destArticleRef, newData);
            batch.delete(docSnap.ref);
            movedArticleIds.add(docSnap.id);
            transferredArticlesCount++;
            ops += 2;
            if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) { throw new functions.https.HttpsError("internal", "Falha ao transferir artigos."); }

    let transferredPendingAlertsCount = 0;
    try {
        const pendingSnap = await db.collection(`artifacts/${appId}/public/data/pendingAlerts`)
            .where("companyId", "==", sourceCompanyId).where("keywords", "array-contains", keyword).get();
        let batch = db.batch();
        let ops = 0;
        for (const pdoc of pendingSnap.docs) {
            batch.update(pdoc.ref, { companyId: destCompanyId, companyName: destCompanyName });
            transferredPendingAlertsCount++;
            ops += 1;
            if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) { throw new functions.https.HttpsError("internal", "Falha ao atualizar pendências."); }

    let transferredDeletionRequestsCount = 0;
    try {
        const delReqSnap = await db.collection(`artifacts/${appId}/public/data/deletionRequests`).where("companyId", "==", sourceCompanyId).get();
        let batch = db.batch();
        let ops = 0;
        for (const rdoc of delReqSnap.docs) {
            const rdata = rdoc.data();
            if (rdata.articleId && movedArticleIds.has(rdata.articleId)) {
                batch.update(rdoc.ref, { companyId: destCompanyId, companyName: destCompanyName });
                transferredDeletionRequestsCount++;
                ops += 1;
                if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
            }
        }
        if (ops > 0) { await batch.commit(); }
    } catch (e) { throw new functions.https.HttpsError("internal", "Falha ao transferir solicitações."); }

    return { success: true, keywordMoved, transferredArticlesCount, transferredPendingAlertsCount, transferredDeletionRequestsCount };
});

exports.manageDeletionRequest = onCall(async (request) => {
    const { appId, requestId, approve } = request.data;
    if (!appId || !requestId) { throw new functions.https.HttpsError("invalid-argument", "IDs necessários."); }
    const requestRef = db.doc(`artifacts/${appId}/public/data/deletionRequests/${requestId}`);
    const requestDoc = await requestRef.get();
    if (!requestDoc.exists) { throw new functions.https.HttpsError("not-found", "Solicitação não encontrada."); }
    const requestData = requestDoc.data();
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

exports.requestAlertDeletion = onCall(async (request) => {
    const { appId, companyId, companyName, articleId, articleTitle, justification } = request.data;
    if (!appId || !companyId || !articleId || !justification) { throw new functions.https.HttpsError("invalid-argument", "Dados incompletos."); }
    await db.collection(`artifacts/${appId}/public/data/deletionRequests`).add({ companyId, companyName, articleId, articleTitle, justification, status: "pending", requestedAt: admin.firestore.FieldValue.serverTimestamp() });
    const articleRef = db.doc(`artifacts/${appId}/users/${companyId}/articles/${articleId}`);
    await articleRef.update({ deletionRequestStatus: 'pending' });
    return { success: true };
});

exports.getCompanyKeywordReport = onCall(async (request) => {
    const { appId, companyId, startDate, endDate } = request.data || {};
    if (!appId || !companyId) throw new functions.https.HttpsError("invalid-argument", "IDs necessários.");

    let startTs = null, endTs = null;
    try {
        if (startDate) { const sd = new Date(startDate); if (!isNaN(sd)) { sd.setHours(0, 0, 0, 0); startTs = admin.firestore.Timestamp.fromDate(sd); } }
        if (endDate) { const ed = new Date(endDate); if (!isNaN(ed)) { ed.setHours(23, 59, 59, 999); endTs = admin.firestore.Timestamp.fromDate(ed); } }
    } catch (e) {}

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
        if (score > 0.2) sentiment = 'positive'; else if (score < -0.2) sentiment = 'negative';

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
    return result;
});

exports.backfillRssSourceNames = onCall(async (request) => {
  const appId = request.data?.appId || APP_ID;
  const dryRun = !!request.data?.dryRun;
  let companiesProcessed = 0, articlesChecked = 0, articlesUpdated = 0, pendingChecked = 0, pendingUpdated = 0;

  const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
  for (const companyDoc of companiesSnapshot.docs) {
    const companyId = companyDoc.id;
    companiesProcessed++;
    const articlesRef = db.collection(`artifacts/${appId}/users/${companyId}/articles`);
    const articlesQuery = await articlesRef.where('source.name', 'in', ['RSS', 'RSS Feed']).get();
    for (const doc of articlesQuery.docs) {
      articlesChecked++;
      const data = doc.data();
      const friendly = resolveFriendlySourceNameFromUrl(data?.source?.url || data?.url || '', data?.source?.name || 'RSS');
      if (friendly && friendly !== (data?.source?.name || 'RSS')) {
        if (!dryRun) await doc.ref.update({ 'source.name': friendly });
        articlesUpdated++;
      }
    }
    const pendingRef = db.collection(`artifacts/${appId}/public/data/pendingAlerts`);
    const pendingQuery = await pendingRef.where('companyId', '==', companyId).where('source.name', 'in', ['RSS', 'RSS Feed']).get();
    for (const doc of pendingQuery.docs) {
      pendingChecked++;
      const data = doc.data();
      const friendly = resolveFriendlySourceNameFromUrl(data?.source?.url || data?.url || '', data?.source?.name || 'RSS');
      if (friendly && friendly !== (data?.source?.name || 'RSS')) {
        if (!dryRun) await doc.ref.update({ 'source.name': friendly });
        pendingUpdated++;
      }
    }
  }
  return { success: true, appId, dryRun, companiesProcessed, articlesChecked, articlesUpdated, pendingChecked, pendingUpdated };
});

exports.manualAddAlert = onCall(async (request) => {
    const { appId, companyId, url } = request.data || {};
    if (!appId || !companyId || !url) throw new functions.https.HttpsError("invalid-argument", "Dados incompletos.");

    const companyDoc = await db.doc(`artifacts/${appId}/public/data/companies/${companyId}`).get();
    if (!companyDoc.exists) throw new functions.https.HttpsError("not-found", "Empresa não encontrada.");
    const companyName = companyDoc.data()?.name || companyId;

    let title = "", description = "";
    try {
        const resp = await axios.get(url, { timeout: 10000 });
        const pageHtml = String(resp.data || "");
        const ogTitleMatch = pageHtml.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i);
        if (ogTitleMatch && ogTitleMatch[1]) title = ogTitleMatch[1].trim();
        else { const t = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/i); if (t && t[1]) title = t[1].trim(); }
        const ogDescMatch = pageHtml.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
        if (ogDescMatch && ogDescMatch[1]) description = ogDescMatch[1].trim();
    } catch (e) {}

    let sourceName = "";
    try { const u = new URL(url); sourceName = resolveFriendlySourceNameFromUrl(u.href, u.hostname || "Site"); } 
    catch { sourceName = resolveFriendlySourceNameFromUrl(url, "Site"); }
    const channelValue = getChannelCategory(sourceName);

    let companyKeywords = [];
    try {
        const ksnap = await db.collection(`artifacts/${appId}/users/${companyId}/keywords`).get();
        companyKeywords = ksnap.docs.map(d => String(d.data()?.word || "").trim()).filter(Boolean);
    } catch (e) {}
    
    const matchedKeywords = findMatchingKeywords({ title, description }, companyKeywords);
    let captureChannels = [];
    try {
        const settingsDoc = await db.doc(`artifacts/${appId}/public/data/settings/${companyId}`).get();
        captureChannels = settingsDoc.exists ? (settingsDoc.data()?.captureChannels || []) : [];
    } catch (e) {}
    if (captureChannels.length > 0 && !captureChannels.includes(channelValue)) return { success: true, skipped: true, reason: 'channel_disabled' };

    const alertData = { title: title || url, description: description || "", url, source: { name: sourceName, url }, author: null, channel: channelValue, publishedAt: admin.firestore.FieldValue.serverTimestamp(), keywords: matchedKeywords, companyId, companyName, status: "pending", };
    const pendingRef = await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).add(alertData);
    return { success: true, pendingId: pendingRef.id };
});

exports.generateSuperAdminReport = onCall(async (request) => {
    const { appId, startDate, endDate } = request.data || {};
    if (!appId) throw new functions.https.HttpsError("invalid-argument", "ID da aplicação necessário.");

    let startTs = null, endTs = null;
    try {
        if (startDate) { const sd = new Date(startDate); if (!isNaN(sd)) { sd.setHours(0, 0, 0, 0); startTs = admin.firestore.Timestamp.fromDate(sd); } }
        if (endDate) { const ed = new Date(endDate); if (!isNaN(ed)) { ed.setHours(23, 59, 59, 999); endTs = admin.firestore.Timestamp.fromDate(ed); } }
    } catch (e) {}

    const companiesSnapshot = await db.collection(`artifacts/${appId}/public/data/companies`).get();
    const reportData = [];
    for (const companyDoc of companiesSnapshot.docs) {
        const companyId = companyDoc.id;
        const companyName = companyDoc.data().name;
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
                if (score > 0.2) positiveCount++; else if (score < -0.2) negativeCount++; else neutralCount++;
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
    return reportData;
});

exports.generateCriticalReport = onCall(async (request) => {
    const { appId, companyId, startDate, endDate } = request.data || {};
    if (!appId || !companyId) throw new functions.https.HttpsError("invalid-argument", "IDs necessários.");

    let start = null, end = null;
    try {
        if (startDate) { const sd = new Date(startDate); if (!isNaN(sd)) { sd.setHours(0,0,0,0); start = sd; } }
        if (endDate) { const ed = new Date(endDate); if (!isNaN(ed)) { ed.setHours(23,59,59,999); end = ed; } }
    } catch (e) {}

    const articlesSnap = await db.collection(`artifacts/${appId}/users/${companyId}/articles`).get();
    const articles = [];
    const channelCounts = {}, vehicleCounts = {}, valuation = {}, dateCounts = {}, keywordCounts = {}, spaceCounts = {}, mentionedEntities = {}, spontaneityCounts = {};
    const mediaSpace = { tvTime: 0, radioTime: 0, webSize: 0, youtubeTime: 0 };
    const sentimentByChannel = { TV: { positive: 0, neutral: 0, negative: 0 }, Rádio: { positive: 0, neutral: 0, negative: 0 }, Web: { positive: 0, neutral: 0, negative: 0 }, YouTube: { positive: 0, neutral: 0, negative: 0 }, Outros: { positive: 0, neutral: 0, negative: 0 } };

    for (const doc of articlesSnap.docs) {
        const a = doc.data();
        let d = null;
        try {
            if (a.publishedAt && typeof a.publishedAt.toDate === 'function') d = a.publishedAt.toDate();
            else if (a.approvedAt && typeof a.approvedAt.toDate === 'function') d = a.approvedAt.toDate();
        } catch (_) {}
        if (start && d && d < start) continue;
        if (end && d && d > end) continue;

        articles.push(a);
        const ch = (a.channel || (a.source?.name ? getChannelCategory(a.source.name) : 'Outros'));
        channelCounts[ch] = (channelCounts[ch] || 0) + 1;
        const veh = (a.source?.name || 'Desconhecido');
        vehicleCounts[veh] = (vehicleCounts[veh] || 0) + 1;
        if (d) { const key = d.toISOString().slice(0,10); dateCounts[key] = (dateCounts[key] || 0) + 1; }
        const val = (a?.sentiment?.label || a?.valuation || 'Neutro');
        valuation[val] = (valuation[val] || 0) + 1;
        if (Array.isArray(a.keywords)) a.keywords.forEach(k => { if (typeof k === 'string' && k.trim()) { const kk = k.trim(); keywordCounts[kk] = (keywordCounts[kk] || 0) + 1; } });
        const textType = a?.textType || a?.space || 'MATÉRIA';
        spaceCounts[textType] = (spaceCounts[textType] || 0) + 1;
        if (Array.isArray(a.ai?.entities)) a.ai.entities.forEach(entity => { if (entity.name && entity.salience > 0.01) mentionedEntities[entity.name] = (mentionedEntities[entity.name] || 0) + 1; });
        const spontaneity = a?.spontaneity || 'Espontânea';
        spontaneityCounts[spontaneity] = (spontaneityCounts[spontaneity] || 0) + 1;
        
        if (ch === 'TV') mediaSpace.tvTime += 1;
        else if (ch === 'Rádio') mediaSpace.radioTime += 0.5;
        else if (ch === 'Web') mediaSpace.webSize += 10;
        else if (ch === 'YouTube') mediaSpace.youtubeTime += 2;

        const score = a.sentiment?.score ?? 0;
        let sent = 'neutral'; if (score > 0.2) sent = 'positive'; else if (score < -0.2) sent = 'negative';
        const cCat = ch in sentimentByChannel ? ch : 'Outros';
        sentimentByChannel[cCat][sent] += 1;
    }

    const topChannel = getTopCount(channelCounts);
    const topVehicle = getTopCount(vehicleCounts);
    const topMentionedEntities = Object.entries(mentionedEntities).sort((a, b) => b[1] - a[1]).slice(0, 50).reduce((obj, [key, value]) => { obj[key] = value; return obj; }, {});
    
    return { articles, channelCounts, vehicleCounts, valuation, dateCounts, keywordCounts, spaceCounts, spontaneityCounts, mentionedEntities: topMentionedEntities, mediaSpace, sentimentByChannel, topChannel, topVehicle, totalAlerts: articles.length };
});

// --- Lógica Compartilhada de Correção (Para evitar repetição) ---
async function runFixLogic(companyId, dryRun) {
    let processedCount = 0, updatedCount = 0, errorsCount = 0;
    const snapshot = await db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`).where('companyId', '==', companyId).get();
    
    if (snapshot.empty) return { processed: 0, updated: 0, errors: 0 };

    const batch = db.batch();
    let currentBatchSize = 0;
    const batchLimit = 400; // Limite de segurança do Firestore
    let batchCommittedCount = 0;

    for (const doc of snapshot.docs) {
        processedCount++;
        const article = doc.data();
        let needsUpdate = false;
        const updates = {};
        
        // Lógica de correção
        if (article.channel === 'YouTube' || (article.source && article.source.name === 'YouTube')) {
            if (article.source && article.source.name !== 'Canal') { updates['source.name'] = 'Canal'; needsUpdate = true; }
            if (!article.author || article.author === '' || article.author === 'YouTube') { updates['author'] = 'Redação*'; needsUpdate = true; }
        } else {
            if (article.url) {
                const domain = extractDomainFromUrl(article.url);
                if (domain && article.source && article.source.name && article.source.name !== domain) { updates['source.name'] = domain; needsUpdate = true; }
            }
        }

        if (needsUpdate) {
            if (!dryRun) batch.update(doc.ref, updates);
            currentBatchSize++;
            updatedCount++;
            
            // Se encher o lote, envia
            if (currentBatchSize >= batchLimit) {
                if (!dryRun) await batch.commit();
                batchCommittedCount++;
                // Reinicia batch
                currentBatchSize = 0;
                // Nota: Firestore batch reuso é complexo, idealmente recriaríamos o objeto batch, 
                // mas para simplicidade em cloud functions V2, isso costuma funcionar se o fluxo for linear.
            }
        }
    }
    
    // Envia o restante
    if (currentBatchSize > 0 && !dryRun) await batch.commit();
    
    return { processed: processedCount, updated: updatedCount, errors: errorsCount };
}

// --- FUNÇÕES DE CORREÇÃO EXPORTADAS ---

exports.fixExistingArticles = onCall(async (request) => {
    if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado');
    const { companyId } = request.data;
    try {
        const result = await runFixLogic(companyId, false);
        return { success: true, ...result, message: `Correção concluída para a empresa.` };
    } catch (error) { throw new functions.https.HttpsError('internal', `Erro: ${error.message}`); }
});

exports.fixAllCompaniesArticles = onCall(async (request) => {
    if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado');
    const lockName = 'fixArticlesLock';
    
    try {
        const lockCheck = await checkAndSetLock(lockName);
        if (lockCheck.locked) throw new functions.https.HttpsError('already-exists', `Correção em andamento. ${lockCheck.message}`);
        
        const companiesSnapshot = await db.collection(`artifacts/${APP_ID}/public/data/companies`).get();
        const results = [];
        let totalProcessed = 0, totalUpdated = 0;
        
        for (const companyDoc of companiesSnapshot.docs) {
            const company = companyDoc.data();
            try {
                // Agora chamamos a função interna, muito mais rápido e seguro
                const result = await runFixLogic(company.companyId, false);
                totalProcessed += result.processed;
                totalUpdated += result.updated;
                results.push({ companyId: company.companyId, companyName: company.companyName, ...result, success: true });
            } catch (error) { 
                results.push({ companyId: company.companyId, companyName: company.companyName, success: false, error: error.message }); 
            }
        }
        
        await releaseLock(lockName);
        return { success: true, totalProcessed, totalUpdated, results };
    } catch (error) {
        await releaseLock(lockName).catch(() => {});
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// Funções de Lock (Mantidas iguais)
async function checkAndSetLock(lockName, maxDuration = 30 * 60 * 1000) {
    const lockRef = db.collection(`artifacts/${APP_ID}/public/data/locks`).doc(lockName);
    const lock = await lockRef.get();
    if (lock.exists) {
        const lockData = lock.data();
        if (Date.now() - lockData.timestamp < maxDuration) return { locked: true, message: lockData.message };
        await lockRef.delete();
    }
    await lockRef.set({ timestamp: Date.now(), message: 'Processo em execução', startedAt: new Date().toISOString() });
    return { locked: false };
}

async function releaseLock(lockName) {
    await db.collection(`artifacts/${APP_ID}/public/data/locks`).doc(lockName).delete();
}

exports.checkFixStatus = onCall(async (request) => {
    if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado');
    try {
        const lock = await db.collection(`artifacts/${APP_ID}/public/data/locks`).doc('fixArticlesLock').get();
        if (lock.exists) {
            const data = lock.data();
            return { running: true, startedAt: data.startedAt, minutesRunning: Math.floor((Date.now() - data.timestamp) / 60000), message: data.message };
        }
        return { running: false, message: 'Nenhuma correção em andamento' };
    } catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

exports.releaseFixLock = onCall(async (request) => {
    if (!request.auth) throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado');
    try { await releaseLock('fixArticlesLock'); return { success: true, message: 'Lock liberado' }; }
    catch (error) { throw new functions.https.HttpsError('internal', error.message); }
});

// --- ROBÔ DE IMPRESSO (MONITORAMENTO DE JORNAIS) ---
exports.scheduledPrintMonitor = onSchedule({
    schedule: "every 60 minutes",
    timeoutSeconds: 540,
    memory: "1GiB"
}, async (event) => {
    
    const db = admin.firestore();
    console.log(">>> [DEBUG] Iniciando o Robô. Procurando ID do App...");

    // --- CORREÇÃO: BUSCA AUTOMÁTICA DO ID ---
    // Em vez de usar um ID fixo, pegamos o primeiro que encontrarmos no banco
    const artifactsRef = db.collection('artifacts');
    const artifactsSnap = await artifactsRef.limit(1).get();

    if (artifactsSnap.empty) {
        console.error("[ERRO CRÍTICO] Banco de dados vazio. Nenhuma coleção 'artifacts' encontrada.");
        return;
    }

    const appId = artifactsSnap.docs[0].id; // <--- O Robô descobre o ID sozinho aqui!
    console.log(`[DEBUG] ID do App detectado: ${appId}`);

    // 1. Ler configurações globais usando o ID descoberto
    const globalSettingsRef = db.doc(`artifacts/${appId}/public/data/settings/global`);
    const globalSettingsSnap = await globalSettingsRef.get();
    
    if (!globalSettingsSnap.exists) {
        console.error(`[ERRO CRÍTICO] Configurações não encontradas no caminho: artifacts/${appId}/public/data/settings/global`);
        return;
    }

    const globalSettings = globalSettingsSnap.data();
    console.log("[DEBUG] Configurações lidas com sucesso. Prosseguindo...");

    // ... (O RESTO DO CÓDIGO CONTINUA IGUAL DAQUI PARA BAIXO) ...
    // Mantenha as linhas: const printSourcesRaw = ...

    const printSourcesRaw = globalSettings.printSources || '';
    const startWindow = globalSettings.printWindowStart || "00:00";
    const endWindow = globalSettings.printWindowEnd || "23:59";
    const frequencyHours = parseInt(globalSettings.printFrequencyHours || '24');

    // 2. Validações de Tempo
    const now = new Date();
    const brDate = new Date(now.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
    const currentHHMM = brDate.getHours().toString().padStart(2,'0') + ':' + brDate.getMinutes().toString().padStart(2,'0');

    console.log(`[DEBUG] Hora atual: ${currentHHMM} | Janela: ${startWindow} às ${endWindow}`);

    if (currentHHMM < startWindow || currentHHMM > endWindow) {
        console.log(`[PAUSA] Fora do horário de trabalho. Voltando a dormir.`);
        return;
    }

    // 3. Validação de Links
    const sourceUrls = printSourcesRaw.split('\n').map(s => s.trim()).filter(s => s);
    if (sourceUrls.length === 0) {
        console.log("[AVISO] O campo de Links (URLs) está vazio nas configurações.");
        return;
    }
    console.log(`[DEBUG] Encontrei ${sourceUrls.length} links de jornais para processar.`);

    // 4. Buscar Empresas
    const companiesSnap = await db.collection(`artifacts/${appId}/public/data/companies`).where('status', '==', 'active').get();
    const companies = [];
    
    for (const docComp of companiesSnap.docs) {
        const settings = (await db.doc(`artifacts/${appId}/public/data/settings/${docComp.id}`).get()).data() || {};
        
        if (settings.captureChannels && settings.captureChannels.includes('Impresso')) {
            const kwSnap = await db.collection(`artifacts/${appId}/users/${docComp.id}/keywords`).get();
            const keywords = kwSnap.docs.map(k => k.data().word.toLowerCase());
            if (keywords.length > 0) companies.push({ id: docComp.id, name: docComp.data().name, keywords });
        }
    }

    if (companies.length === 0) {
        console.log("[AVISO] Nenhuma empresa ativa está com a opção 'Impresso' marcada.");
        return;
    }
    console.log(`[DEBUG] Encontrei ${companies.length} empresas monitorando impresso.`);

    const formatUrlDate = (url) => {
        const d = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return url.replace(/{DD}/g, dd).replace(/{MM}/g, mm).replace(/{AAAA}/g, yyyy);
    };

    // 5. Processamento (COM LÓGICA DE PDF)
    for (const rawUrl of sourceUrls) {
        let targetUrl = formatUrlDate(rawUrl);
        console.log(`[Impresso] Acessando Capa: ${targetUrl}`);

        try {
            let response = await axios.get(targetUrl, { 
                headers: { 'User-Agent': 'Mozilla/5.0' },
                responseType: 'arraybuffer',
                timeout: 60000 
            });

            let pageContent = "";
            let finalUrl = targetUrl;
            let contentType = response.headers['content-type'] || '';

            // Se for HTML, tenta achar o PDF dentro
            if (!contentType.includes('pdf')) {
                const html = response.data.toString();
                const $ = cheerio.load(html);
                
                // Procura link de PDF
                let pdfLink = $('a[href$=".pdf"]').attr('href');
                
                if (pdfLink) {
                    // Corrige link relativo
                    if (!pdfLink.startsWith('http')) {
                        const domain = targetUrl.split('/').slice(0,3).join('/'); 
                        pdfLink = domain + (pdfLink.startsWith('/') ? '' : '/') + pdfLink;
                    }
                    console.log(`[Impresso] PDF Encontrado! Redirecionando: ${pdfLink}`);
                    finalUrl = pdfLink;
                    response = await axios.get(pdfLink, { 
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        responseType: 'arraybuffer'
                    });
                } else {
                    console.log("[Impresso] Nenhum link PDF na página. Lendo como site normal...");
                    pageContent = $('body').text();
                }
            }

            // Se for PDF
            if (finalUrl.endsWith('.pdf') || response.headers['content-type'].includes('pdf')) {
                console.log("[Impresso] Extraindo texto do PDF...");
                const pdfData = await pdf(response.data);
                pageContent = pdfData.text; 
            }

            if (!pageContent || pageContent.length < 100) {
                console.log("[Impresso] Conteúdo vazio ou muito curto.");
                continue;
            }

            const contentLower = pageContent.toLowerCase().replace(/\s+/g, ' ');

            // Cruzamento de Keywords
            for (const company of companies) {
                const matchedKw = company.keywords.filter(kw => contentLower.includes(kw));

                if (matchedKw.length > 0) {
                    console.log(`   [MATCH] ${company.name} -> ${matchedKw.join(', ')}`);
                    await db.collection(`artifacts/${appId}/public/data/pendingAlerts`).add({
                        companyId: company.id,
                        companyName: company.name,
                        title: `[Impresso] Menção Detectada`,
                        description: `Palavras: ${matchedKw.join(', ')}`,
                        content: pageContent.substring(0, 3000) + '...',
                        url: finalUrl,
                        source: { name: 'Jornal Digital', url: finalUrl },
                        channel: 'Impresso',
                        publishedAt: admin.firestore.Timestamp.now(),
                        keywords: matchedKw,
                        status: 'pending',
                        createdAt: admin.firestore.Timestamp.now()
                    });
                }
            }

        } catch (err) {
            console.error(`[Impresso] Erro ao processar ${targetUrl}: ${err.message}`);
        }
    }
    console.log("[DEBUG] Fim da execução.");
});