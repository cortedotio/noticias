import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

try { admin.app(); } catch { admin.initializeApp(); }
const db = admin.firestore();

const tsToDate = (t) => {
  try { return (t && typeof t.toDate === 'function') ? t.toDate() : (t ? new Date(t) : null); } catch { return null; }
};
const gate = (lastRun, freqMs) => { if (!lastRun) return true; return (Date.now() - lastRun.getTime()) >= freqMs; };

(async () => {
  const APP_ID = process.env.APP_ID || process.env.GOOGLE_CLOUD_PROJECT || 'noticias-6e952';
  const out = {};

  // Read Global Settings
  const settingsRef = db.doc(`artifacts/${APP_ID}/public/data/settings/global`);
  const settingsDoc = await settingsRef.get();
  if (!settingsDoc.exists) {
    out.global = { error: 'GLOBAL_SETTINGS_NOT_FOUND' };
  } else {
    const s = settingsDoc.data();
    const youtubeLastRun = tsToDate(s.youtubeLastRun);
    const gnewsLastRun = tsToDate(s.gnewsLastRun);
    const rssLastRun = tsToDate(s.rssLastRun);
    const youtubeChannelsLastRun = tsToDate(s.youtubeChannelsLastRun);

    const youtubeHours = Number(s.youtubeFrequencyHours || 6);
    const gnewsHours = Number(s.gnewsFrequencyHours || 2);
    const rssMin = Number(s.rssFrequencyMinutes || 10);
    const ytChannelsMin = Number(s.youtubeChannelsFrequencyMinutes || rssMin);

    // Desired specific time gate for YouTube
    const youtubeTime = String(s.youtubeFrequencyTime || '').trim();
    let desiredTimeOk = true;
    if (youtubeTime) {
      const parts = youtubeTime.split(':');
      const hh = Number(parts[0]);
      const mm = Number(parts[1]);
      if (!Number.isNaN(hh) && !Number.isNaN(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
        const now = new Date();
        const desired = new Date(now);
        desired.setHours(hh, mm, 0, 0);
        const diffMin = Math.abs((now.getTime() - desired.getTime()) / 60000);
        desiredTimeOk = diffMin <= 30; // within 30 minutes window
      }
    }

    const canRunYouTube = gate(youtubeLastRun, youtubeHours * 3600000) && desiredTimeOk;
    const canRunGNews = gate(gnewsLastRun, gnewsHours * 3600000);
    const canRunRSS = gate(rssLastRun, rssMin * 60000);
    const canRunYouTubeChannels = gate(youtubeChannelsLastRun, ytChannelsMin * 60000);

    const keysPresence = {
      apiKeyGNews1: !!s.apiKeyGNews1,
      apiKeyGNews2: !!s.apiKeyGNews2,
      apiKeyGNews3: !!s.apiKeyGNews3,
      apiKeyGNews4: !!s.apiKeyGNews4,
      apiKeyNewsApi: !!s.apiKeyNewsApi,
      apiKeyYoutube: !!s.apiKeyYoutube,
    };
    const missingKeys = Object.entries(keysPresence).filter(([,v]) => !v).map(([k]) => k);

    out.global = {
      apiKeys: keysPresence,
      missingKeys,
      lists: {
        rssCount: String(s.rssUrl || '').split('\n').filter(u => u.trim()).length,
        youtubeChannelsCount: String(s.youtubeChannels || '').split('\n').filter(u => u.trim()).length,
      },
      gates: { canRunRSS, canRunGNews, canRunYouTube, canRunYouTubeChannels, desiredTimeOk },
      lastRuns: {
        youtubeLastRun: youtubeLastRun ? youtubeLastRun.toISOString() : null,
        gnewsLastRun: gnewsLastRun ? gnewsLastRun.toISOString() : null,
        rssLastRun: rssLastRun ? rssLastRun.toISOString() : null,
        youtubeChannelsLastRun: youtubeChannelsLastRun ? youtubeChannelsLastRun.toISOString() : null,
      },
      settings: {
        rssFrequencyMinutes: rssMin,
        gnewsFrequencyHours: gnewsHours,
        youtubeFrequencyHours: youtubeHours,
        youtubeFrequencyTime: youtubeTime,
        youtubeChannelsFrequencyMinutes: ytChannelsMin,
      },
    };
  }

  // Company ALMT and keyword audit
  const companiesSnap = await db.collection(`artifacts/${APP_ID}/public/data/companies`).where('name', '==', 'ALMT').get();
  if (companiesSnap.empty) {
    out.almt = { error: 'COMPANY_NOT_FOUND' };
  } else {
    const company = companiesSnap.docs[0];
    const companyId = company.id;
    const companyName = company.data()?.name || 'ALMT';

    // Registered keywords in Firestore
    const kwsSnap = await db.collection(`artifacts/${APP_ID}/users/${companyId}/keywords`).get();
    const registeredKeywords = kwsSnap.docs.map(d => String(d.data().word || '').trim()).filter(Boolean);

    // Provided keywords by user for compatibility check
    const providedKeywords = [
      'chico guarnieri', 'Juca do Guaraná', 'Max Russi', 'Margareth Buzetti', 'julio campos',
      'Diego Guimarães', 'Jose Medeiros', 'Wellington Fagundes', 'Janaina Riva',
      'Jayme Campos', 'Gilberto Cattani', 'Faissal Calil'
    ];
    const providedLower = providedKeywords.map(k => k.toLowerCase());

    // Compare sets
    const setReg = new Set(registeredKeywords.map(k => k.toLowerCase()));
    const inBoth = providedLower.filter(k => setReg.has(k));
    const missingInRegistered = providedLower.filter(k => !setReg.has(k));

    // Pending alerts for this company in last 7 days
    const sevenDaysAgo = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    // Substituir consulta composta que exigia índice por consulta simples com filtragem no cliente
    const pendingSnapAll = await db.collection(`artifacts/${APP_ID}/public/data/pendingAlerts`)
      .where('companyId', '==', companyId)
      .limit(500)
      .get();
    const sevenDaysAgoDate = sevenDaysAgo.toDate();
    const pendingAll = pendingSnapAll.docs.map(d => ({
      id: d.id,
      title: d.data().title,
      url: d.data().url,
      publishedAt: (d.data().publishedAt && d.data().publishedAt.toDate()) ? d.data().publishedAt.toDate() : null,
      keywords: d.data().keywords || (d.data().keyword ? [d.data().keyword] : []),
      channel: d.data().channel || null,
    }));
    const pendingFiltered = pendingAll.filter(x => x.publishedAt && x.publishedAt >= sevenDaysAgoDate)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    const pending = pendingFiltered.map(x => ({
      id: x.id,
      title: x.title,
      url: x.url,
      publishedAt: x.publishedAt ? x.publishedAt.toISOString() : null,
      keywords: x.keywords,
      channel: x.channel,
    }));

    // Articles audit: last 7 days from public/data/articles
    const articlesSnap = await db.collection(`artifacts/${APP_ID}/public/data/articles`)
      .orderBy('publishedAt', 'desc')
      .limit(800)
      .get();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const articles = articlesSnap.docs
      .map(d => ({
        title: d.data().title || '',
        description: d.data().description || '',
        sourceName: (d.data().source && d.data().source.name) || '',
        url: d.data().url || '',
        publishedAt: (d.data().publishedAt && d.data().publishedAt.toDate()) ? d.data().publishedAt.toDate() : null,
      }))
      .filter(a => a.publishedAt && a.publishedAt >= cutoff);

    const lower = s => String(s || '').toLowerCase();
    const matchesByKeyword = {};
    providedLower.forEach(k => { matchesByKeyword[k] = 0; });
    const matchedSamples = [];
    for (const art of articles) {
      const text = (lower(art.title) + ' ' + lower(art.description)).trim();
      const matched = providedLower.filter(kw => kw && text.includes(kw));
      if (matched.length > 0) {
        matchedSamples.push({ title: art.title, source: art.sourceName, url: art.url, publishedAt: art.publishedAt.toISOString(), matchedKeywords: matched });
        matched.forEach(k => { matchesByKeyword[k] = (matchesByKeyword[k] || 0) + 1; });
      }
    }

    out.almt = {
      companyId,
      companyName,
      registeredKeywordCount: registeredKeywords.length,
      registeredKeywords,
      providedKeywordCount: providedKeywords.length,
      providedKeywords,
      overlapWithRegistered: inBoth,
      missingInRegistered,
      pendingLast7d: { count: pendingFiltered.length, sample: pending.slice(0, 30) },
      articleAudit: { recentCount: articles.length, totalMatches: matchedSamples.length, matchesByKeyword, samples: matchedSamples.slice(0, 30) },
    };
  }

  fs.writeFileSync(path.join(process.cwd(), 'diagnostics.json'), JSON.stringify(out, null, 2));
  console.log('Diagnostics written to diagnostics.json');

  // Attempt Cloud Logging fetch (optional, only if package is present)
  let logsResult = { error: 'SKIPPED' };
  try {
    const loggingMod = await import('@google-cloud/logging');
    if (loggingMod && loggingMod.Logging) {
      const { Logging } = loggingMod;
      const logging = new Logging({ projectId: APP_ID });
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const filter = `resource.type=("cloud_function" OR "cloud_run_revision") AND resource.labels.project_id="${APP_ID}" AND (resource.labels.function_name="scheduledFetch" OR resource.labels.function_name="manualFetch") AND timestamp>="${start.toISOString()}"`;
      const [entries] = await logging.getEntries({
        filter,
        pageSize: 100,
        resourceNames: [`projects/${APP_ID}`],
        orderBy: 'timestamp desc',
      });
      const simplified = entries.map(e => ({
        timestamp: e.metadata && e.metadata.timestamp,
        severity: e.metadata && e.metadata.severity,
        function: (e.metadata && e.metadata.resource && e.metadata.resource.labels && (e.metadata.resource.labels.function_name || e.metadata.resource.labels.container_name)) || null,
        text: e.data && (e.data.message || e.data.textPayload || JSON.stringify(e.data)),
      }));
      logsResult = { count: simplified.length, entries: simplified.slice(0, 50) };
    }
  } catch (err) {
    logsResult = { error: String(err && err.message || err) };
  }

  fs.writeFileSync(path.join(process.cwd(), 'function-logs.json'), JSON.stringify(logsResult, null, 2));
  console.log('Function logs written to function-logs.json');
})().catch(e => { console.error('ERR', e); process.exit(1); });