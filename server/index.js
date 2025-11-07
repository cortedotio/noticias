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

// Capture endpoint (single definition)
app.post('/capture', async (req, res) => {
  try {
    const { url, name = 'radio', duration = 30 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const safeName = (name || 'radio').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = Date.now();
    const outFile = path.join(segmentsDir, `${safeName}_${ts}.mp3`);
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    await new Promise((resolve, reject) => {
      ffmpeg(url)
        .format('mp3')
        .audioCodec('libmp3lame')
        .duration(duration)
        .on('error', err => reject(err))
        .on('end', () => resolve())
        .save(outFile);
    });
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

// Helper to parse radio sources "Name | URL | HH:MM - HH:MM"
function parseRadioSources(str = '') {
  const lines = String(str).split(/\n+/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parts = line.split('|').map(s => s.trim());
    const name = parts[0] || '';
    const url = parts[1] || '';
    const timePart = parts[2] || '';
    let start = null, end = null;
    const m = timePart.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    if (m) { start = m[1]; end = m[2]; }
    if (name || url) { entries.push({ name, url, start, end }); }
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
  return await new Promise((resolve, reject) => {
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg(url)
      .format('mp3')
      .audioCodec('libmp3lame')
      .duration(durationSec)
      .on('error', err => reject(err))
      .on('end', () => resolve(outFile))
      .save(outFile);
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
    companies.push({ companyId, companyName, keywords });
  }
  return companies;
}

function findMatches(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.filter(kw => lower.includes(String(kw).toLowerCase()));
}

async function enqueuePendingAlert(appId, company, entry, segmentUrl, transcription) {
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
    channel: 'radio'
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
setInterval(checkAndCaptureRadios, 60 * 1000);

const PORT = Number(process.env.PORT) || 6068;
app.listen(PORT, () => {
  console.log(`Radio capture server running at http://127.0.0.1:${PORT}/`);
});