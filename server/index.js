import express from 'express';
import cors from 'cors';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { sync as mkdirpSync } from 'mkdirp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import { SpeechClient } from '@google-cloud/speech';
import { spawnSync } from 'child_process';
import https from 'https'
import http from 'http'

// Choose ffmpeg path with env override and preflight validation
const ffmpegCustomPath = process.env.FFMPEG_PATH;
function getEffectiveFfmpegPath() {
  const candidate = (ffmpegCustomPath && ffmpegCustomPath.trim()) ? ffmpegCustomPath : ffmpegPath;
  try {
    if (!candidate) return null;
    const res = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
    if (typeof res.status === 'number' && res.status === 0) return candidate;
    console.warn('ffmpeg path not valid for this OS/arch, skipping:', candidate);
    return null;
  } catch (e) {
    console.warn('ffmpeg path preflight failed, skipping:', candidate, e?.message || e);
    return null;
  }
}
const effectiveFfmpegPath = getEffectiveFfmpegPath();
const hasFfmpeg = Boolean(effectiveFfmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

// Root paths
const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = path.dirname(__filename);
const publicRoot = path.resolve(__dirnameLocal, '..');
const segmentsDir = path.join(publicRoot, 'segments');
mkdirpSync(segmentsDir);

// Serve segments as static
app.use('/segments', express.static(segmentsDir));
app.use('/', express.static(publicRoot));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Endpoint para executar backfill de nomes de fontes RSS
app.post('/backfill-rss-source', async (req, res) => {
  try {
    const { appId = 'noticias-6e952', dryRun = false } = req.body || {};
    const result = await backfillRssSourceNames(appId, Boolean(dryRun));
    res.json({ ok: true, result });
  } catch (e) {
    console.error('backfill-rss-source error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Capture endpoint (single definition)
app.post('/capture', async (req, res) => {
  try {
    const { url, name = 'radio', duration = 30 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const safeName = (name || 'radio').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = Date.now();
    const outFile = path.join(segmentsDir, `${safeName}_${ts}.mp3`);
    if (hasFfmpeg) {
      ffmpeg.setFfmpegPath(effectiveFfmpegPath);
      await new Promise((resolve, reject) => {
        ffmpeg(url)
          .format('mp3')
          .audioCodec('libmp3lame')
          .duration(duration)
          .on('error', err => reject(err))
          .on('end', () => resolve())
          .save(outFile);
      });
    } else {
      await directStreamCopy(url, outFile, duration);
    }
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    res.json({ ok: true, file: path.basename(outFile), url: `${baseUrl}/segments/${path.basename(outFile)}` });
  } catch (e) {
    console.error('Capture error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// List segments (JSON)
app.get('/segments', async (req, res) => {
  try {
    const files = await fs.promises.readdir(segmentsDir);
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const stats = await Promise.all(files.map(async f => {
      const st = await fs.promises.stat(path.join(segmentsDir, f));
      return { file: f, mtime: st.mtimeMs, url: `${baseUrl}/segments/${encodeURIComponent(f)}` };
    }));
    stats.sort((a,b) => b.mtime - a.mtime);
    res.json({ ok: true, segments: stats });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Transcription stub endpoint (kept intact)
app.post('/transcribe', async (req, res) => {
  try {
    const { file, keywords = [] } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Missing file' });
    const filePath = path.join(segmentsDir, file);
    try { await fs.promises.access(filePath, fs.constants.R_OK); } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    const text = `Transcrição (stub) do arquivo ${file}`;
    const matches = keywords.filter(k => text.toLowerCase().includes(String(k).toLowerCase()));
    const score = matches.length > 0 ? -0.4 : 0.1;
    res.json({ ok: true, file, text, language: 'pt-BR', matches, sentiment: { score } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Extract full article content from a URL
app.post('/extract-article', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });

    // Fetch HTML (prefer global fetch; fallback to https/http modules)
    const getHtml = async (u) => {
      if (typeof fetch === 'function') {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (AuroraClipping)' } });
        return await r.text();
      }
      const https = await import('https');
      const http = await import('http');
      const mod = u.startsWith('https') ? https : http;
      return await new Promise((resolve, reject) => {
        mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (AuroraClipping)' } }, (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => resolve(data));
        }).on('error', reject);
      });
    };

    const html = await getHtml(url);
    if (!html || html.length < 50) return res.json({ ok: false, error: 'Empty html' });

    // Try Readability first (robust extraction)
    try {
      const { JSDOM } = await import('jsdom');
      const { Readability } = await import('@mozilla/readability');
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      const textContent = (article && article.textContent) ? article.textContent.trim() : '';
      if (textContent && textContent.length > 200) {
        return res.json({ ok: true, title: article.title || null, content: textContent });
      }
    } catch (e) {
      console.warn('Readability fallback:', e.message || e);
    }

    // Fallback: simple tag‑based extraction
    const decodeEntities = (s = '') => s
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    const stripTags = (s = '') => decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    // Remove scripts/styles to reduce noise
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

    const sectionMatch = cleaned.match(/<article[\s\S]*?<\/article>/i) || cleaned.match(/<main[\s\S]*?<\/main>/i) || cleaned.match(/<body[\s\S]*?<\/body>/i);
    const section = sectionMatch ? sectionMatch[0] : cleaned;

    const paragraphs = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRe.exec(section)) && paragraphs.length < 200) {
      const text = stripTags(m[1]);
      if (text && text.length > 0) paragraphs.push(text);
    }
    if (paragraphs.length === 0) {
      const altRe = /<(h[1-6]|li|div)[^>]*>([\s\S]*?)<\/\1>/gi;
      while ((m = altRe.exec(section)) && paragraphs.length < 200) {
        const text = stripTags(m[2]);
        if (text && text.length > 50) paragraphs.push(text);
      }
    }
    const content = paragraphs.join('\n\n');
    return res.json({ ok: true, content });
  } catch (e) {
    console.error('extract-article error', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =========================
// Radio scheduler + Speech
// =========================
// Initialize Firebase Admin (requires GOOGLE_APPLICATION_CREDENTIALS or default credentials)
try { admin.app(); } catch { admin.initializeApp(); }
const firestore = admin.firestore();

// Backfill helper functions: adjust RSS source.name to friendly names based on URL
function getFriendlySourceName(existingName = '', url = '', sourceUrl = '') {
  const current = String(existingName || '').trim();
  const norm = current.toLowerCase();
  if (norm && norm !== 'rss' && norm !== 'rss feed' && !isInvalidSourceName(current)) return current;
  const ref = String(url || sourceUrl || '').trim();
  if (!ref) return current || 'RSS';
  const lower = ref.toLowerCase();
  if (lower.includes('metropoles.com')) return 'Metrópoles';
  if (lower.includes('marretaurgente')) return 'Marreta Urgente';
  try {
    const candidate = lower.startsWith('http') ? lower : `https://${lower}`;
    const urlObj = new URL(candidate);
    let host = urlObj.hostname.replace(/^www\./, '');
    // Tratamento especial: se for uma busca do Google, extrair domínio do parâmetro 'q'
    if (host === 'google.com' && urlObj.pathname.includes('/search')) {
      const q = urlObj.searchParams.get('q');
      if (q) {
        const decoded = decodeURIComponent(q);
        const domainMatch = decoded.match(/([a-z0-9.-]+\.[a-z]{2,})/i);
        if (domainMatch) host = domainMatch[1].replace(/^www\./, '');
      }
    }
    return host || (current || 'RSS');
  } catch {
    const m = lower.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/);
    if (m && m[1]) return m[1];
    return current || 'RSS';
  }
}

// Lista de nomes inválidos/indevidos que devem ser inferidos pelo domínio
const INVALID_SOURCE_NAMES = new Set([
  'amodireito.com.br',
  'atual mt',
  'canal rural',
  'chico oliveira',
  'correio braziliense',
  'dayelle ribeiro',
  'expresso.pt',
  'globo',
  'istoé independente',
  'jb news',
  'kelvin ramirez',
  'marcos azevedo',
  'metrópoles',
  'observador.pt',
  'redação',
  'redaçãobem',
  'renan',
  'viomundo.com.br',
  'youtube',
  'folhadoestado.com.br',
  // incluir explicitamente o nome de fonte problemático
  'paginapress.com.br',
  'https://www.google.com/search?q=paginapress.com.br',
  'unicanews',
  'unica news - notícias e fatos com credibilidade',
  'fonte: metrópoles',
  'fonte: marreta urgente'
].map(s => s.toLowerCase().trim().replace(/^`|`$/g, '')));

function isInvalidSourceName(name = '') {
  const n = String(name || '').toLowerCase().trim().replace(/^`|`$/g, '');
  if (!n) return true;
  if (isRssName(n)) return true;
  return INVALID_SOURCE_NAMES.has(n);
}
async function backfillRssSourceNames(appId, dryRun = false) {
  const companiesSnap = await firestore.collection(`artifacts/${appId}/public/data/companies`).get();
  let updatedArticles = 0, updatedPending = 0;
  for (const doc of companiesSnap.docs) {
    const companyId = doc.id;
    const articlesSnap = await firestore.collection(`artifacts/${appId}/users/${companyId}/articles`).get();
    for (const aDoc of articlesSnap.docs) {
      const a = aDoc.data() || {};
      const sourceField = a.source;
      const currentName = typeof sourceField === 'string' ? sourceField : (a.source?.name ?? a.sourceName ?? '');
      if (!isInvalidSourceName(currentName)) continue;
      const refUrl = a.url || a.link || a.source?.url || a.source?.link || a.sourceUrl || a.sourceLink || a.guid || '';
      const friendly = getFriendlySourceName(currentName, refUrl, refUrl);
      if (friendly && friendly !== currentName) {
        const updates = {};
        if (typeof sourceField === 'string') {
          updates['source'] = { name: friendly, url: a.sourceUrl || a.sourceLink || a.source?.url || a.source?.link || a.url || a.link || '' };
        } else if (a.source?.name !== undefined) {
          updates['source.name'] = friendly;
        }
        if (a.sourceName !== undefined) {
          updates['sourceName'] = friendly;
        }
        if (Object.keys(updates).length === 0) {
          updates['source'] = { name: friendly, url: refUrl };
        }
        if (!dryRun) { await aDoc.ref.update(updates); }
        updatedArticles++;
      }
    }
  }
  const pendingSnap = await firestore.collection(`artifacts/${appId}/public/data/pendingAlerts`).get();
  for (const pDoc of pendingSnap.docs) {
    const p = pDoc.data() || {};
    const sourceField = p.source;
    const currentName = typeof sourceField === 'string' ? sourceField : (p.source?.name ?? p.sourceName ?? '');
    if (!isInvalidSourceName(currentName)) continue;
    const refUrl = p.url || p.link || p.source?.url || p.source?.link || p.sourceUrl || p.sourceLink || p.guid || '';
    const friendly = getFriendlySourceName(currentName, refUrl, refUrl);
    if (friendly && friendly !== currentName) {
      const updates = {};
      if (typeof sourceField === 'string') {
        updates['source'] = { name: friendly, url: p.sourceUrl || p.sourceLink || p.source?.url || p.source?.link || p.url || p.link || '' };
      } else if (p.source?.name !== undefined) {
        updates['source.name'] = friendly;
      }
      if (p.sourceName !== undefined) {
        updates['sourceName'] = friendly;
      }
      if (Object.keys(updates).length === 0) {
        updates['source'] = { name: friendly, url: refUrl };
      }
      if (!dryRun) { await pDoc.ref.update(updates); }
      updatedPending++;
    }
  }
  return { companies: companiesSnap.size, updatedArticles, updatedPending, dryRun };
}

// Backfill one-off execution via environment flag
const BACKFILL_RUN = process.env.BACKFILL_RUN === '1';
const BACKFILL_DRYRUN = process.env.BACKFILL_DRYRUN === '1';
const DIAGNOSE_RUN = process.env.DIAGNOSE_RUN === '1';
if (BACKFILL_RUN) {
  const appIdEnv = process.env.APP_ID || 'noticias-6e952';
  backfillRssSourceNames(appIdEnv, BACKFILL_DRYRUN)
    .then((result) => {
      console.log('[Backfill] concluído:', result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Backfill] erro:', err);
      process.exit(1);
    });
}
// Função dedicada de diagnóstico
async function diagnoseSourceNames(appId) {
  const companiesSnap = await firestore.collection(`artifacts/${appId}/public/data/companies`).get();
  let articlesTotal = 0, articlesInvalid = 0, pendingTotal = 0, pendingInvalid = 0;
  const sampleArticles = [];
  const samplePending = [];
  for (const doc of companiesSnap.docs) {
    const companyId = doc.id;
    const articlesSnap = await firestore.collection(`artifacts/${appId}/users/${companyId}/articles`).get();
    articlesTotal += articlesSnap.size;
    for (const aDoc of articlesSnap.docs) {
      const a = aDoc.data() || {};
      const name = typeof a.source === 'string' ? a.source : (a.source?.name ?? a.sourceName ?? '');
      if (isInvalidSourceName(name)) {
        articlesInvalid++;
        if (sampleArticles.length < 5) sampleArticles.push({ id: aDoc.id, companyId, name, url: a.url || a.link || a.source?.url || a.source?.link || a.sourceUrl || a.sourceLink || a.guid || '' });
      }
    }
  }
  const pendingSnap = await firestore.collection(`artifacts/${appId}/public/data/pendingAlerts`).get();
  pendingTotal += pendingSnap.size;
  for (const pDoc of pendingSnap.docs) {
    const p = pDoc.data() || {};
    const name = typeof p.source === 'string' ? p.source : (p.source?.name ?? p.sourceName ?? '');
    if (isInvalidSourceName(name)) {
      pendingInvalid++;
      if (samplePending.length < 5) samplePending.push({ id: pDoc.id, name, url: p.url || p.link || p.source?.url || p.source?.link || p.sourceUrl || p.sourceLink || p.guid || '' });
    }
  }
  console.log('[Diagnose] companies:', companiesSnap.size);
  console.log('[Diagnose] articlesTotal:', articlesTotal, 'articlesInvalid:', articlesInvalid);
  console.log('[Diagnose] pendingTotal:', pendingTotal, 'pendingInvalid:', pendingInvalid);
  console.log('[Diagnose] sampleArticles:', sampleArticles);
  console.log('[Diagnose] samplePending:', samplePending);
  return { companies: companiesSnap.size, articlesTotal, articlesInvalid, pendingTotal, pendingInvalid, sampleArticles, samplePending };
}

// Helper to parse radio sources "name | program | site | url | HH:MM - HH:MM | seg ter ..."
function parseRadioSources(str = '') {
  const lines = String(str).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const entries = [];

  const isTime = (s = '') => /^(\d{2}:\d{2})(?:\s*-\s*(\d{2}:\d{2}))?$/.test(String(s).trim());
  const isLikelyStreamUrl = (s = '') => {
    const u = String(s || '');
    if (!/^https?:\/\//i.test(u)) return false;
    return /\.m3u8(\b|$)|\.mp3(\b|$)|\.aac(\b|$)|\.ogg(\b|$)|icecast|shoutcast|\/stream|\/live/i.test(u);
  };
  const isWebsite = (s = '') => {
    const u = String(s || '');
    return /^https?:\/\//i.test(u) && !isLikelyStreamUrl(u);
  };

  for (const line of lines) {
    const parts = line.split('|').map(s => s.trim());
    const name = parts[0] || '';
    let program = '';
    let site = '';
    let url = '';
    let timeRaw = '';
    let daysTokens = '';

    // Prefer fixed positions if present
    if (parts.length >= 5 && isTime(parts[4])) {
      program = parts[1] || '';
      site = parts[2] || '';
      url = parts[3] || '';
      timeRaw = parts[4] || '';
      daysTokens = (parts[5] || '').toLowerCase();
    } else {
      // Backward compatibility: try to infer positions
      const p1 = parts[1] || '';
      const p2 = parts[2] || '';
      const p3 = parts[3] || '';
      const p4 = parts[4] || '';
      if (isTime(p2)) {
        // name | url | time | days?
        url = p1 || '';
        timeRaw = p2 || '';
        daysTokens = (parts.slice(3).join(' ') || '').toLowerCase();
      } else if (isTime(p3)) {
        // name | program | url | time | days?
        program = p1 || '';
        url = p2 || '';
        timeRaw = p3 || '';
        daysTokens = (parts.slice(4).join(' ') || '').toLowerCase();
      } else if (isWebsite(p2) || isLikelyStreamUrl(p2)) {
        // name | program | site/url | ...
        program = p1 || '';
        if (isWebsite(p2)) site = p2; else url = p2;
        if (isTime(p3)) {
          timeRaw = p3;
          daysTokens = (parts.slice(4).join(' ') || '').toLowerCase();
        }
      } else {
        // name | program
        program = p1 || '';
      }
    }

    let start = null, end = null;
    const m = String(timeRaw || '').match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    if (m) { start = m[1]; end = m[2]; }

    const weekdayAbbr = ['seg','ter','qua','qui','sex','sab','dom'];
    const selectedDays = new Set(String(daysTokens || '').split(/\s+/).filter(t => weekdayAbbr.includes(t)));
    const days = Array.from(selectedDays);

    if (name || url || site) {
      entries.push({ name, program, site, url, start, end, days });
    }
  }
  return entries;
}

function isWithinWindow(startHHMM, endHHMM, date = new Date()) {
  if (!startHHMM || !endHHMM) return false;
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const start = new Date(date); start.setHours(sh, sm, 0, 0);
  const end = new Date(date); end.setHours(eh, em, 0, 0);
  if (end < start) { // overnight window
    if (date >= start) return true; // same day late night
    const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 1);
    return date <= end && date >= prevStart;
  }
  return date >= start && date <= end;
}

const lastCaptureByRadio = new Map();
const speechClient = new SpeechClient();

async function runCapture(url, name, durationSec, outFile) {
  return await new Promise(async (resolve, reject) => {
    try {
      if (hasFfmpeg) {
        ffmpeg.setFfmpegPath(effectiveFfmpegPath);
        ffmpeg(url)
          .format('mp3')
          .audioCodec('libmp3lame')
          .duration(durationSec)
          .on('error', err => reject(err))
          .on('end', () => resolve(outFile))
          .save(outFile);
      } else {
        await directStreamCopy(url, outFile, durationSec);
        resolve(outFile);
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function directStreamCopy(url, outFile, durationSec = 30) {
  return await new Promise((resolve, reject) => {
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { headers: { 'Icy-MetaData': '1' } }, (res) => {
        if ((res.statusCode || 0) >= 300 && (res.statusCode || 0) < 400 && res.headers.location) {
          // handle simple redirect
          req.destroy();
          return directStreamCopy(res.headers.location, outFile, durationSec).then(resolve).catch(reject);
        }
        if ((res.statusCode || 0) >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const ws = fs.createWriteStream(outFile);
        res.on('error', (e) => { try { ws.close(); } catch {} reject(e); });
        ws.on('error', (e) => { try { res.destroy(); } catch {} reject(e); });
        ws.on('finish', () => resolve(outFile));
        res.pipe(ws);
        const t = setTimeout(() => {
          try { res.destroy(); } catch {}
          try { ws.end(); } catch {}
        }, Number(durationSec) * 1000);
        req.on('close', () => clearTimeout(t));
      });
      req.on('error', (e) => reject(e));
    } catch (e) {
      reject(e);
    }
  });
}

async function transcribeMp3(filePath) {
  const content = await fs.promises.readFile(filePath);
  const audioBytes = content.toString('base64');
  const request = {
    audio: { content: audioBytes },
    config: {
      encoding: 'MP3',
      languageCode: 'pt-BR',
      enableAutomaticPunctuation: true,
      model: 'latest_long',
    },
  };
  const [response] = await speechClient.recognize(request);
  const transcription = (response.results || []).map(r => r.alternatives?.[0]?.transcript || '').join(' ').trim();
  return transcription;
}

async function loadCompaniesKeywords(appId) {
  const companiesSnap = await firestore.collection(`artifacts/${appId}/public/data/companies`).where('status', '==', 'active').get();
  const companies = [];
  for (const doc of companiesSnap.docs) {
    const companyId = doc.id;
    const companyName = doc.data()?.name || '';
    const kwsSnap = await firestore.collection(`artifacts/${appId}/users/${companyId}/keywords`).get();
    const keywords = kwsSnap.docs.map(d => (d.data().word || '').toLowerCase()).filter(Boolean);
    // Load captureChannels from company settings (defaults to empty -> treated as all enabled)
    const settingsDoc = await firestore.doc(`artifacts/${appId}/public/data/settings/${companyId}`).get();
    const captureChannels = settingsDoc.exists ? (settingsDoc.data()?.captureChannels || []) : [];
    companies.push({ companyId, companyName, keywords, captureChannels });
  }
  return companies;
}

function findMatches(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.filter(kw => lower.includes(String(kw).toLowerCase()));
}

async function enqueuePendingAlert(appId, company, entry, segmentUrl, transcription) {
  // Channel gating: only enqueue if 'Rádios' is enabled for this company.
  const enabledChannels = Array.isArray(company.captureChannels) ? company.captureChannels : [];
  const radioEnabled = enabledChannels.length === 0 || enabledChannels.includes('Rádios');
  if (!radioEnabled) {
    return; // Skip creating pending alert when radio is disabled in company settings
  }
  const alertData = {
    title: `${entry.name || 'Rádio'} — Captura de Rádio`,
    description: transcription || '',
    url: segmentUrl,
    source: { name: entry.name || 'Rádio', url: entry.url || '' },
    publishedAt: admin.firestore.FieldValue.serverTimestamp(),
    keywords: company.matchedKeywords,
    companyId: company.companyId,
    companyName: company.companyName,
    status: 'pending',
    channel: 'Rádios'
  };
  await firestore.collection(`artifacts/${appId}/public/data/pendingAlerts`).add(alertData);
}

async function checkAndCaptureRadios() {
  try {
    const APP_ID = 'noticias-6e952';
    const settingsRef = firestore.doc(`artifacts/${APP_ID}/public/data/settings/global`);
    const settingsDoc = await settingsRef.get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    const radioEntries = parseRadioSources(settings.radioSources || '');
    if (radioEntries.length === 0) return;
    const companies = await loadCompaniesKeywords(APP_ID);
    const port = Number(process.env.PORT) || 6068;
    const baseUrl = `http://127.0.0.1:${port}`;

    for (const entry of radioEntries) {
      if (!entry.url) continue;
      const within = entry.start && entry.end ? isWithinWindow(entry.start, entry.end) : true;
      if (!within) continue;
      const key = `${entry.name}|${entry.url}`;
      const last = lastCaptureByRadio.get(key) || 0;
      // Avoid duplicate captures within 10 minutes
      if (Date.now() - last < 10 * 60 * 1000) continue;

      const ts = Date.now();
      const safeName = (entry.name || 'radio').replace(/[^a-zA-Z0-9_-]/g, '_');
      const outFile = path.join(segmentsDir, `${safeName}_${ts}.mp3`);
      try {
        await runCapture(entry.url, entry.name, Number(settings.radioCaptureDuration || 60), outFile);
        const transcription = await transcribeMp3(outFile);
        const segmentUrl = `${baseUrl}/segments/${encodeURIComponent(path.basename(outFile))}`;
        for (const company of companies) {
          const matchedKeywords = findMatches(transcription, company.keywords);
          if (matchedKeywords.length > 0) {
            await enqueuePendingAlert(APP_ID, { ...company, matchedKeywords }, entry, segmentUrl, transcription);
          }
        }
        lastCaptureByRadio.set(key, Date.now());
        console.log(`[Radio] Capturado e transcrito: ${entry.name} -> ${path.basename(outFile)}`);
      } catch (err) {
        console.error(`[Radio] Falha ao capturar/transcrever ${entry.name}:`, err.message || err);
      }
    }
  } catch (e) {
    console.error('[Radio] Erro no agendador de rádios:', e.message || e);
  }
}

// Iniciar agendador (checa a cada 1 minuto)
if (!BACKFILL_RUN && !DIAGNOSE_RUN) {
  setInterval(checkAndCaptureRadios, 60 * 1000);
}

const PORT = Number(process.env.PORT) || 6068;
if (!BACKFILL_RUN && !DIAGNOSE_RUN) {
  app.listen(PORT, () => {
    console.log(`Radio capture server running at http://127.0.0.1:${PORT}/`);
  });
}

// Substituir o corpo do endpoint para usar a função dedicada
app.post('/diagnose-source-names', async (req, res) => {
  try {
    const { appId = 'noticias-6e952' } = req.body || {};
    const result = await diagnoseSourceNames(appId);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('diagnose-source-names error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function isRssName(name = '') {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  const withoutFeed = n.replace(/feed/g, '');
  if (withoutFeed === 'rss') return true;
  if (n === 'rss' || n === 'rssfeed' || n === 'feedrss') return true;
  if (n.startsWith('rss') || n.endsWith('rss')) return true;
  return false;
}

// Atualizar execução direta para usar a função
if (DIAGNOSE_RUN) {
  const appIdEnv = process.env.APP_ID || 'noticias-6e952';
  diagnoseSourceNames(appIdEnv)
    .then((result) => { console.log('[Diagnose] concluído:', result); process.exit(0); })
    .catch(err => { console.error('[Diagnose] erro:', err); process.exit(1); });
}

// RSS feed discovery helpers
const COMMON_FEED_PATHS = ['/feed', '/rss', '/index.xml', '/atom.xml', '/rss.xml', '/feed.xml', '/feeds/posts/default', '/feeds/rss', '/index.atom', '/rss/atom.xml', '/rss/index.xml', '/?feed=rss2', '/?feed=atom', '/posts/feed', '/news/feed', '/categoria/feed', '/noticias/feed', '/rss2.xml', '/feed.rss', '/rss.php', '/wp-feed.php'];

async function tryValidateFeed(url) {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (RSS Discovery Bot)' } });
    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    const looksXml = /xml|rss|atom/i.test(ct) || /<rss|<feed/i.test(text);
    return resp.ok && looksXml;
  } catch {
    return false;
  }
}

async function discoverRssFeeds(baseSiteUrl) {
  const discovered = new Set();
  let base;
  try { base = new URL(baseSiteUrl); } catch { return Array.from(discovered); }
  const homepageUrl = base.origin;

  const candidates = new Set();
  // Se a URL fornecida já for um feed válido, aceite diretamente
  try {
    if (await tryValidateFeed(base.href)) {
      candidates.add(base.href);
    }
  } catch {}

  // Check HTML <link rel="alternate" type="application/rss+xml|atom"> e <a> com texto/URL contendo rss/feed
  for (const url of [base.href, homepageUrl]) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (RSS Discovery Bot)' } });
      const html = await resp.text();
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
      // Procurar âncoras que mencionem RSS/Feed ou URLs contendo rss/feed
      const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
      let a;
      while ((a = anchorRegex.exec(html)) !== null) {
        const href = a[1];
        const text = (a[2] || '').replace(/<[^>]+>/g, '').trim();
        if (/rss|feed/i.test(href) || /rss|feed|assine/i.test(text)) {
          try { const resolved = new URL(href, url).href; candidates.add(resolved); } catch {}
        }
      }
    } catch {}
  }

  // Try common feed paths (inclui parâmetros típicos do WordPress)
  for (const p of COMMON_FEED_PATHS) {
    try { candidates.add(new URL(p, homepageUrl).href); } catch {}
  }

  // Validação final
  for (const c of candidates) {
    if (discovered.size >= 10) break;
    if (await tryValidateFeed(c)) discovered.add(c);
  }
  return Array.from(discovered);
}
app.post('/update-global-rss-sites', async (req, res) => {
  try {
    const { sites = [], appId = 'noticias-6e952', dryRun = false } = req.body || {};
    const siteList = Array.isArray(sites) ? sites : [];
    if (siteList.length === 0) return res.status(400).json({ ok: false, error: 'Lista de sites vazia' });

    const discoveredBySite = {};
    const allNewFeeds = new Set();
    for (const site of siteList) {
      const feeds = await discoverRssFeeds(site);
      discoveredBySite[site] = feeds;
      for (const f of feeds) allNewFeeds.add(f);
    }

    const settingsRef = firestore.doc(`artifacts/${appId}/public/data/settings/global`);
    const doc = await settingsRef.get();
    const current = doc.exists ? (doc.data().rssUrl || '') : '';
    const existingSet = new Set(String(current).split(/\n+/).map(s => s.trim()).filter(Boolean));
    let added = 0;
    for (const f of allNewFeeds) {
      if (!existingSet.has(f)) { existingSet.add(f); added++; }
    }
    const newValue = Array.from(existingSet).join('\n');
    if (!dryRun) {
      await settingsRef.set({ rssUrl: newValue }, { merge: true });
    }
    res.json({ ok: true, added, total: existingSet.size, dryRun: Boolean(dryRun), discoveredBySite });
  } catch (e) {
    console.error('update-global-rss-sites error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =========================
// TV sources monitor (Model B)
// =========================
const WEEKDAY_ABBR = ['dom','seg','ter','qua','qui','sex','sab'];
const lastCheckByTvId = new Map();

function getWeekdayAbbr(date = new Date()) {
  // 0=Sunday -> 'dom'
  const map = ['dom','seg','ter','qua','qui','sex','sab'];
  return map[date.getDay()];
}

function isTvIntervalActive(interval = {}, date = new Date()) {
  const days = Array.isArray(interval.days) ? interval.days : [];
  const today = getWeekdayAbbr(date);
  if (!days.includes(today)) return false;
  return isWithinWindow(interval.start, interval.end, date);
}

async function testTvSource(url, protocol = 'HLS') {
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (AuroraTVMonitor)' };
    if (protocol === 'HLS') {
      const resp = await fetch(url, { method: 'GET', headers });
      const ct = resp.headers.get('content-type') || '';
      const text = await resp.text();
      const ok = resp.ok && (/m3u8|mpegurl/i.test(ct) || /#EXTM3U/i.test(text));
      return { online: ok, error: ok ? null : `HLS inválido (content-type=${ct})` };
    }
    if (protocol === 'DASH') {
      const resp = await fetch(url, { method: 'GET', headers });
      const ct = resp.headers.get('content-type') || '';
      const text = await resp.text();
      const ok = resp.ok && (/dash|xml/i.test(ct) || /<MPD/i.test(text));
      return { online: ok, error: ok ? null : `DASH inválido (content-type=${ct})` };
    }
    // HTTP genérico: usar HEAD quando possível
    const resp = await fetch(url, { method: 'HEAD', headers });
    const ok = resp.ok;
    return { online: ok, error: ok ? null : `HTTP status ${resp.status}` };
  } catch (e) {
    return { online: false, error: String(e.message || e) };
  }
}

// Utilitários para descobrir links .m3u8 em páginas dinâmicas
function resolveUrlMaybeRelative(candidate = '', base = '') {
  try {
    return new URL(candidate, base).href;
  } catch {
    return null;
  }
}

async function collectM3u8CandidatesFromHtml(html, baseUrl) {
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const set = new Set();
    const push = (u) => {
      if (!u) return;
      const resolved = resolveUrlMaybeRelative(u, baseUrl);
      if (resolved) set.add(resolved);
    };
    // Tags comuns que podem conter .m3u8
    doc.querySelectorAll('a[href*=".m3u8"], link[href*=".m3u8"], source[src*=".m3u8"], video[src*=".m3u8"], script[src*=".m3u8"]').forEach(el => {
      push(el.getAttribute('href'));
      push(el.getAttribute('src'));
    });
    // Dentro de scripts (players como JWPlayer/Video.js)
    doc.querySelectorAll('script').forEach(s => {
      const text = s.textContent || '';
      (text.match(/https?:\/\/[^\s'"<>]+\.m3u8/gi) || []).forEach(u => set.add(u));
      (text.match(/['"]([^'"]+\.m3u8)['"]/gi) || []).forEach(m => {
        const inner = m.replace(/^['"]|['"]$/g, '').replace(/^['"]|['"]$/g, '');
        push(inner);
      });
    });
    // No HTML bruto
    const htmlText = doc.documentElement?.outerHTML || html || '';
    (htmlText.match(/https?:\/\/[^\s'"<>]+\.m3u8/gi) || []).forEach(u => set.add(u));
    (htmlText.match(/['"]([^'"]+\.m3u8)['"]/gi) || []).forEach(m => {
      const inner = m.replace(/^['"]|['"]$/g, '').replace(/^['"]|['"]$/g, '');
      push(inner);
    });
    // Data attributes
    doc.querySelectorAll('[data-src],[data-url]').forEach(el => {
      push(el.getAttribute('data-src'));
      push(el.getAttribute('data-url'));
    });
    return Array.from(set);
  } catch {
    return [];
  }
}

async function discoverM3U8(pageUrl, maxDepth = 2) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (AuroraTVMonitor)' };
  const visited = new Set();
  const candidates = new Set();
  const queue = [{ url: pageUrl, depth: 0 }];
  while (queue.length) {
    const { url, depth } = queue.shift();
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch {
      continue;
    }
    if (!resp.ok) continue;
    const ct = resp.headers.get('content-type') || '';
    let text = '';
    try { text = await resp.text(); } catch {}
    if (/m3u8|mpegurl/i.test(ct) || /#EXTM3U/i.test(text)) {
      candidates.add(url);
      continue;
    }
    if (/html/i.test(ct)) {
      const found = await collectM3u8CandidatesFromHtml(text, url);
      found.forEach(u => candidates.add(u));
      // Capturar iframes e rastrear em largura
      try {
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM(text, { url });
        const doc = dom.window.document;
        doc.querySelectorAll('iframe[src]').forEach(ifr => {
          const src = ifr.getAttribute('src');
          const resolved = resolveUrlMaybeRelative(src, url);
          if (resolved) queue.push({ url: resolved, depth: depth + 1 });
        });
      } catch {}
    }
  }
  // Validar com a verificação HLS já existente
  const unique = Array.from(candidates);
  const validated = [];
  for (const u of unique) {
    try {
      const { online } = await testTvSource(u, 'HLS');
      if (online) validated.push(u);
    } catch {}
  }
  return { candidates: unique, validated, best: validated[0] || null };
}

async function checkTvSources() {
  try {
    const APP_ID = process.env.APP_ID || 'noticias-6e952';
    const colRef = firestore.collection(`artifacts/${APP_ID}/public/data/tvSources`);
    const snap = await colRef.get();
    if (snap.empty) return;
    const now = new Date();
    for (const d of snap.docs) {
      const c = d.data() || {};
      if (!c.enabled) continue;
      const intervals = Array.isArray(c.intervals) ? c.intervals : [];
      const active = intervals.some(iv => isTvIntervalActive(iv, now));
      if (!active) continue;
      const freqMin = Number(c.frequencyMinutes || 3);
      const lastTs = lastCheckByTvId.get(d.id) || 0;
      if (Date.now() - lastTs < freqMin * 60 * 1000) continue;
      const { online, error } = await testTvSource(c.url, c.protocol || 'HLS');
      const updates = {
        status: online ? 'online' : 'offline',
        lastChecked: admin.firestore.FieldValue.serverTimestamp(),
        lastError: online ? null : (error || null),
        failCount: online ? 0 : Number((c.failCount || 0) + 1)
      };
      try {
        await d.ref.set(updates, { merge: true });
      } catch (e) {
        console.error('[TV] Falha ao atualizar status:', e.message || e);
      }
      lastCheckByTvId.set(d.id, Date.now());
    }
  } catch (e) {
    console.error('[TV] Erro no agendador de TV:', e.message || e);
  }
}

// Agendar verificação de TV a cada 1 minuto
if (!BACKFILL_RUN && !DIAGNOSE_RUN) {
  setInterval(checkTvSources, 60 * 1000);
}

// Endpoint: Testar Agora uma fonte de TV
app.post('/tv/test-now', async (req, res) => {
  try {
    const { appId = process.env.APP_ID || 'noticias-6e952', sourceId, url, protocol = 'HLS' } = req.body || {};
    let sourceData = null;
    let docRef = null;
    if (sourceId) {
      docRef = firestore.doc(`artifacts/${appId}/public/data/tvSources/${sourceId}`);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'Fonte de TV não encontrada' });
      sourceData = doc.data() || {};
    } else {
      if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
      sourceData = { url, protocol };
    }
    const { online, error } = await testTvSource(sourceData.url, sourceData.protocol || protocol);
    const result = { online, error: error || null };
    if (docRef) {
      const updates = {
        status: online ? 'online' : 'offline',
        lastChecked: admin.firestore.FieldValue.serverTimestamp(),
        lastError: online ? null : (error || null),
        failCount: online ? 0 : Number((sourceData.failCount || 0) + 1)
      };
      await docRef.set(updates, { merge: true });
      lastCheckByTvId.set(sourceId, Date.now());
    }
    res.json({ ok: true, result });
  } catch (e) {
    console.error('/tv/test-now error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Endpoint: Descobrir .m3u8 a partir de uma página
app.post('/tv/discover', async (req, res) => {
  try {
    const { url, maxDepth = 2 } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
    const result = await discoverM3U8(url, Number(maxDepth));
    res.json({ ok: true, result });
  } catch (e) {
    console.error('/tv/discover error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});