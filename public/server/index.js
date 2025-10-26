import express from 'express';
import cors from 'cors';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { sync as mkdirpSync } from 'mkdirp';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url'

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

// Capture endpoint
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
// Serve segments files as static (avoid route collision by ordering)
app.use('/segments', express.static(segmentsDir));
// Serve UI from public
app.use('/', express.static(publicRoot));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Capture endpoint
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

    res.json({ ok: true, file: path.basename(outFile), url: `/segments/${path.basename(outFile)}` });
  } catch (e) {
    console.error('Capture error', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Transcription stub endpoint
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

const PORT = process.env.PORT || 6060;
app.listen(PORT, () => {
  console.log(`Radio capture server running at http://127.0.0.1:${PORT}/`);
});