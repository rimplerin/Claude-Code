import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import JSZip from 'jszip';
import {
  FILES_DIR, getSettings, updateSettings, getCredentials, saveCredentials, deleteCredentials, resolveModel,
  listCharacters, getCharacter, createCharacter, updateCharacter, addCharacterImage, deleteCharacter,
  listJobs, getJob, parseDataUrl, saveImage, readImage,
} from './store.js';
import { validateCredentials, testConnection, getAccessToken, generateText, VertexError } from './vertex.js';
import { ASPECT_RATIOS, buildDescribeParts } from './prompts.js';
import {
  subscribe, queueState, setPaused, clearCooldown, createJobs, cancelJob, retryJob, regenerateJob,
  deleteJobs, deleteResult, ACTIVE,
} from './queue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '400mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch((err) => {
      res.status(err.statusCode || 400).json({ error: String(err?.message || err) });
    });
};

function httpError(code, message) {
  const err = new Error(message);
  err.statusCode = code;
  return err;
}

// ---------- state / settings / credentials ----------
function credentialsInfo() {
  const c = getCredentials();
  if (!c) return { configured: false };
  return { configured: true, project_id: c.project_id, client_email: c.client_email };
}

app.get('/api/state', (req, res) => {
  res.json({
    credentials: credentialsInfo(),
    settings: getSettings(),
    queue: queueState(),
    aspectRatios: ASPECT_RATIOS,
  });
});

app.put('/api/settings', wrap((req, res) => {
  res.json({ settings: updateSettings(req.body || {}) });
}));

app.post('/api/credentials', wrap(async (req, res) => {
  let raw = req.body?.json;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new Error('JSON 형식이 올바르지 않습니다.'); }
  }
  const creds = validateCredentials(raw);
  await getAccessToken(creds); // fails fast if the key is unusable
  saveCredentials(creds);
  res.json({ credentials: credentialsInfo() });
}));

app.delete('/api/credentials', wrap((req, res) => {
  deleteCredentials();
  res.json({ credentials: credentialsInfo() });
}));

app.post('/api/test', wrap(async (req, res) => {
  const creds = getCredentials();
  if (!creds) throw new Error('서비스 계정 JSON을 먼저 등록하세요.');
  const s = getSettings();
  const results = [];
  const models = req.body?.model ? [resolveModel(req.body.model)] : s.models;
  for (const m of models) {
    try {
      await testConnection({ creds, location: s.location, model: m.id });
      results.push({ key: m.key, label: m.label, id: m.id, ok: true });
    } catch (err) {
      results.push({ key: m.key, label: m.label, id: m.id, ok: false, error: err.message });
    }
  }
  res.json({ results });
}));

// ---------- characters ----------
app.get('/api/characters', (req, res) => res.json({ characters: listCharacters() }));

app.post('/api/characters', wrap((req, res) => {
  const images = (req.body.images || []).map(parseDataUrl);
  let c = createCharacter(req.body || {});
  for (const img of images) c = addCharacterImage(c.id, img);
  res.json({ character: c });
}));

app.put('/api/characters/:id', wrap((req, res) => {
  const c = updateCharacter(req.params.id, req.body || {});
  if (!c) throw httpError(404, '캐릭터가 없습니다.');
  res.json({ character: c });
}));

app.post('/api/characters/:id/images', wrap((req, res) => {
  if (!getCharacter(req.params.id)) throw httpError(404, '캐릭터가 없습니다.');
  let c;
  for (const d of req.body.images || []) c = addCharacterImage(req.params.id, parseDataUrl(d));
  res.json({ character: c || getCharacter(req.params.id) });
}));

// AI-written appearance sheet (hair, eyes, outfit...) that is added to every prompt using this character
const TEXT_MODEL_FALLBACKS = ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];

app.post('/api/characters/:id/describe', wrap(async (req, res) => {
  const c = getCharacter(req.params.id);
  if (!c) throw httpError(404, '캐릭터가 없습니다.');
  if (!c.images.length) throw new Error('참조 이미지가 없습니다.');
  const creds = getCredentials();
  if (!creds) throw new Error('서비스 계정 JSON을 먼저 등록하세요.');
  const s = getSettings();
  const parts = buildDescribeParts(c, { loadImage: readImage });
  const candidates = [...new Set([s.textModel, ...TEXT_MODEL_FALLBACKS].filter(Boolean))];
  let text;
  let lastErr;
  for (const model of candidates) {
    try {
      text = await generateText({ creds, location: s.location, model, parts });
      break;
    } catch (err) {
      lastErr = err;
      // only an unknown model ID is worth trying the next candidate for
      if (!(err instanceof VertexError) || err.kind !== 'not_found') break;
    }
  }
  if (!text) throw new Error(`외형 분석 실패: ${lastErr?.message || '알 수 없는 오류'}`);
  const appearance = text.replace(/```[a-z]*\n?|```/g, '').trim();
  res.json({ character: updateCharacter(c.id, { appearance }) });
}));

app.delete('/api/characters/:id', wrap((req, res) => {
  if (!deleteCharacter(req.params.id)) throw httpError(404, '캐릭터가 없습니다.');
  res.json({ ok: true });
}));

// ---------- jobs ----------
app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs(), queue: queueState() }));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  send('state', queueState());
  const unsubscribe = subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

const POSITIONS = ['auto', 'left', 'center', 'right', 'front', 'back'];
const SIZES = ['1K', '2K', '4K'];
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

function commonOptions(o = {}) {
  return {
    model: resolveModel(o.model || getSettings().defaultModel).key,
    imageSize: SIZES.includes(o.imageSize) ? o.imageSize : '2K',
    aspectRatio: o.aspectRatio === 'model' || ASPECT_RATIOS.includes(o.aspectRatio) ? o.aspectRatio : 'auto',
    extra: String(o.extra || '').slice(0, 4000),
  };
}

function sanitizeBox(b) {
  if (!b) return null;
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  const w = Math.min(1 - x, clamp01(b.w));
  const h = Math.min(1 - y, clamp01(b.h));
  return w > 0.005 && h > 0.005 ? { x, y, w, h } : null;
}

app.post('/api/jobs/transform', wrap((req, res) => {
  const { items = [], want = 1, batchId } = req.body || {};
  const base = req.body.options || {};
  const options = {
    ...commonOptions(base),
    style: ['character', 'anime', 'webtoon', 'manga'].includes(base.style) ? base.style : 'character',
    others: base.others === 'remove' ? 'remove' : 'keep',
    maxRefs: Math.min(6, Math.max(1, Number(base.maxRefs) || 3)),
  };
  if (!items.length) throw new Error('이미지가 없습니다.');
  const specs = items.map((item, i) => {
    const subjects = (item.subjects || []).map((s) => {
      const c = getCharacter(s.characterId);
      if (!c) throw new Error(`${i + 1}번째 이미지: 캐릭터가 선택되지 않은 인물이 있습니다.`);
      if (!c.images.length) throw new Error(`캐릭터 "${c.name}"에 이미지가 없습니다.`);
      return {
        characterId: c.id,
        characterName: c.name,
        outfit: s.outfit === 'source' ? 'source' : 'character',
        position: POSITIONS.includes(s.position) ? s.position : 'auto',
        desc: String(s.desc || '').slice(0, 300),
        box: sanitizeBox(s.box),
      };
    });
    if (!subjects.length) throw new Error(`${i + 1}번째 이미지에 변환할 인물이 지정되지 않았습니다.`);
    const sourceFile = saveImage('uploads', parseDataUrl(item.image));
    const guideFile = item.guide && subjects.some((s) => s.box) ? saveImage('uploads', parseDataUrl(item.guide)) : null;
    const extras = (Array.isArray(item.extras) ? item.extras : [])
      .filter((e) => e && String(e.prompt || '').trim())
      .slice(0, 40)
      .map((e) => ({ label: String(e.label || '').slice(0, 60), prompt: String(e.prompt).slice(0, 1000) }));
    return {
      type: 'transform',
      extras,
      title: String(item.title || '').slice(0, 200),
      sourceFile,
      guideFile,
      sourceW: Number(item.width) || 0,
      sourceH: Number(item.height) || 0,
      subjects,
      options,
      want,
    };
  });
  const out = createJobs(specs, batchId);
  res.json({ batchId: out.batchId, count: out.jobs.length });
}));

app.post('/api/jobs/colorize', wrap((req, res) => {
  const { items = [], want = 1, batchId } = req.body || {};
  const base = req.body.options || {};
  const options = {
    ...commonOptions(base),
    style: ['official', 'anime', 'painterly'].includes(base.style) ? base.style : 'official',
    keepText: base.keepText !== false,
    refs: (base.refs || []).filter((id) => getCharacter(id)).slice(0, 6),
  };
  if (!items.length) throw new Error('이미지가 없습니다.');
  const specs = items.map((item) => {
    const masked = maskedFields(item);
    return {
      type: 'colorize',
      title: String(item.title || '').slice(0, 200),
      sourceFile: saveImage('uploads', parseDataUrl(item.image)),
      sourceW: Number(item.width) || 0,
      sourceH: Number(item.height) || 0,
      ...masked,
      options: masked.pad ? { ...options, aspectRatio: masked.pad.ratio } : options,
      want,
    };
  });
  const out = createJobs(specs, batchId);
  res.json({ batchId: out.batchId, count: out.jobs.length });
}));

const CENSOR_FILLS = ['gray', 'black', 'white', 'mosaic'];

// Masked jobs: the client sends the image to submit (masked + padded to a supported ratio),
// a restore mask and the content rectangle so the server can paste the original back.
function maskedFields(item) {
  const out = {};
  if (item.send) out.sendFile = saveImage('uploads', parseDataUrl(item.send));
  if (item.restore) out.restoreFile = saveImage('uploads', parseDataUrl(item.restore));
  if (item.pad && ASPECT_RATIOS.includes(item.pad.ratio)) {
    const x = clamp01(item.pad.x);
    const y = clamp01(item.pad.y);
    out.pad = { x, y, w: Math.min(1 - x, clamp01(item.pad.w)) || 1, h: Math.min(1 - y, clamp01(item.pad.h)) || 1, ratio: item.pad.ratio };
  }
  if (CENSOR_FILLS.includes(item.censorFill)) out.censorFill = item.censorFill;
  return out;
}

app.post('/api/jobs/free', wrap((req, res) => {
  const { items = [], want = 1, batchId } = req.body || {};
  const base = req.body.options || {};
  const options = commonOptions(base);
  const prompt = String(req.body.prompt || '').trim().slice(0, 20000);
  if (!prompt) throw new Error('프롬프트를 입력하세요.');
  if (!items.length) throw new Error('작업이 없습니다.');
  const specs = items.map((item) => {
    const inputFiles = (item.images || []).slice(0, 14).map((d) => saveImage('uploads', parseDataUrl(d)));
    return {
      type: 'free',
      title: String(item.title || prompt.slice(0, 40)).slice(0, 200),
      sourceFile: inputFiles[0] || null,
      sourceW: Number(item.width) || 0,
      sourceH: Number(item.height) || 0,
      inputFiles,
      prompt,
      options,
      want,
    };
  });
  const out = createJobs(specs, batchId);
  res.json({ batchId: out.batchId, count: out.jobs.length });
}));

app.post('/api/jobs/inpaint', wrap((req, res) => {
  const { items = [], want = 1, batchId } = req.body || {};
  const base = req.body.options || {};
  const options = { ...commonOptions(base), prompt: String(base.prompt || '').slice(0, 8000) };
  const refFiles = (req.body.refs || []).slice(0, 10).map((d) => saveImage('uploads', parseDataUrl(d)));
  if (!items.length) throw new Error('이미지가 없습니다.');
  const specs = items.map((item, i) => {
    const prompt = String(item.prompt || '').slice(0, 8000);
    if (!options.prompt.trim() && !prompt.trim()) throw new Error(`${i + 1}번째 이미지: 프롬프트를 입력하세요.`);
    const masked = maskedFields(item);
    return {
      type: 'inpaint',
      title: String(item.title || '').slice(0, 200),
      sourceFile: saveImage('uploads', parseDataUrl(item.image)),
      guideFile: item.guide ? saveImage('uploads', parseDataUrl(item.guide)) : null,
      sourceW: Number(item.width) || 0,
      sourceH: Number(item.height) || 0,
      ...masked,
      refFiles,
      prompt,
      options: masked.pad ? { ...options, aspectRatio: masked.pad.ratio } : options,
      want,
    };
  });
  const out = createJobs(specs, batchId);
  res.json({ batchId: out.batchId, count: out.jobs.length });
}));

app.post('/api/jobs/:id/cancel', wrap((req, res) => res.json({ job: cancelJob(req.params.id) })));
app.post('/api/jobs/:id/retry', wrap((req, res) => res.json({ job: retryJob(req.params.id) })));
app.post('/api/jobs/:id/regenerate', wrap((req, res) => res.json({ job: regenerateJob(req.params.id, req.body?.count) })));
app.post('/api/jobs/:id/delete-result', wrap((req, res) => res.json({ job: deleteResult(req.params.id, req.body?.file) })));

app.post('/api/jobs/bulk', wrap((req, res) => {
  const { action, ids = [] } = req.body || {};
  const jobs = ids.map(getJob).filter(Boolean);
  if (action === 'delete') return res.json({ count: deleteJobs(jobs.map((j) => j.id)) });
  if (action === 'retry') {
    const targets = jobs.filter((j) => j.status === 'failed' || j.status === 'canceled');
    targets.forEach((j) => retryJob(j.id));
    return res.json({ count: targets.length });
  }
  if (action === 'cancel') {
    const targets = jobs.filter((j) => ACTIVE.has(j.status));
    targets.forEach((j) => cancelJob(j.id));
    return res.json({ count: targets.length });
  }
  throw new Error('알 수 없는 작업');
}));

app.post('/api/queue', wrap((req, res) => {
  if (req.body?.clearCooldown) clearCooldown();
  if (typeof req.body?.paused === 'boolean') setPaused(req.body.paused);
  res.json({ queue: queueState() });
}));

const SUFFIX = { transform: '2d', colorize: 'color', inpaint: 'inpaint', free: 'gen' };

// zip download of results: ?ids=a,b,c  or ?batch=xyz
app.get('/api/download.zip', wrap(async (req, res) => {
  let jobs = [];
  if (req.query.batch) jobs = listJobs().filter((j) => j.batchId === req.query.batch);
  else if (req.query.ids) jobs = String(req.query.ids).split(',').map(getJob).filter(Boolean);
  const withSource = req.query.source === '1';
  const zip = new JSZip();
  let n = 0;
  const used = new Set();
  const uniqueName = (name) => {
    let candidate = name;
    let k = 2;
    while (used.has(candidate)) candidate = name.replace(/(\.[a-z0-9]+)$/i, `_${k++}$1`);
    used.add(candidate);
    return candidate;
  };
  jobs.sort((a, b) => a.createdAt - b.createdAt).forEach((job, idx) => {
    const stem = (job.title || `${String(idx + 1).padStart(3, '0')}`).slice(0, 80).replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
    job.results.forEach((r, k) => {
      const ext = path.extname(r.file);
      const abs = path.join(FILES_DIR, r.file);
      if (!fs.existsSync(abs)) return;
      zip.file(uniqueName(`${stem}${job.results.length > 1 ? `_v${k + 1}` : ''}_${SUFFIX[job.type] || 'out'}${ext}`), fs.readFileSync(abs));
      n++;
    });
    if (withSource && job.sourceFile) {
      const abs = path.join(FILES_DIR, job.sourceFile);
      if (fs.existsSync(abs)) zip.file(uniqueName(`source/${stem}${path.extname(job.sourceFile)}`), fs.readFileSync(abs));
    }
  });
  if (!n) throw httpError(404, '다운로드할 결과가 없습니다.');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="banana_${stamp}.zip"` });
  res.send(buf);
}));

// ---------- static ----------
app.use('/files', express.static(FILES_DIR, { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: '업로드 용량이 너무 큽니다. 이미지를 나눠서 올려주세요.' });
  if (err) return res.status(400).json({ error: String(err.message || err) });
  return next();
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Banana i2i 실행 중 → ${url}\n  (종료: Ctrl+C)\n`);
  if (process.env.OPEN_BROWSER) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser */ }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  포트 ${PORT}이(가) 이미 사용 중입니다. Banana i2i가 이미 실행 중이면 브라우저에서 http://localhost:${PORT} 을 여세요.`);
    console.error('  다른 포트로 실행하려면: set PORT=3001 후 다시 실행\n');
  } else {
    console.error(err);
  }
  process.exit(1);
});
