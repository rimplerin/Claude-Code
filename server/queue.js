// Job queue: concurrency limit, requests-per-minute limit, global cooldown after 429,
// exponential backoff for transient errors and automatic re-tries for safety blocks.
import {
  getSettings, getCredentials, resolveModel, listJobs, getJob, addJobs, removeJobs,
  scheduleJobsSave, flushJobs, readImage, saveImage, removeFile, getCharacter, newId,
} from './store.js';
import { generateImage, VertexError } from './vertex.js';
import { buildTransformParts, buildColorizeParts, resolveAspectRatio } from './prompts.js';

const running = new Map(); // jobId -> AbortController
const startTimes = [];     // request start timestamps (RPM window)
const listeners = new Set();
let cooldownUntil = 0;
let cooldownReason = '';
let paused = false;
let lastStart = 0;
const MIN_START_GAP_MS = 800;

export const ACTIVE = new Set(['queued', 'running', 'retrying']);

// ---------- events ----------
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, payload) {
  for (const fn of listeners) {
    try { fn(type, payload); } catch { /* ignore broken listener */ }
  }
}

function touch(job) {
  if (getJob(job.id) !== job) return; // deleted while running
  job.updatedAt = Date.now();
  scheduleJobsSave();
  emit('job', job);
}

function log(job, msg, level = 'info') {
  job.log = job.log || [];
  job.log.push({ t: Date.now(), level, msg });
  if (job.log.length > 40) job.log.splice(0, job.log.length - 40);
}

export function queueState() {
  const now = Date.now();
  return {
    paused,
    running: running.size,
    cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
    cooldownReason: cooldownUntil > now ? cooldownReason : '',
    recentRequests: startTimes.filter((t) => t > now - 60_000).length,
  };
}

function emitState() {
  emit('state', queueState());
}

export function setPaused(value) {
  paused = Boolean(value);
  emitState();
  tick();
}

export function clearCooldown() {
  cooldownUntil = 0;
  emitState();
  tick();
}

// ---------- creation ----------
export function createJobs(specs, existingBatchId) {
  const batchId = existingBatchId && listJobs().some((j) => j.batchId === existingBatchId) ? existingBatchId : newId('b');
  const now = Date.now();
  const jobs = specs.map((spec, i) => ({
    id: newId('j'),
    batchId,
    type: spec.type,
    title: spec.title || '',
    status: 'queued',
    createdAt: now + i, // stable order inside a batch
    updatedAt: now,
    sourceFile: spec.sourceFile,
    sourceW: spec.sourceW,
    sourceH: spec.sourceH,
    guideFile: spec.guideFile || null,
    subjects: spec.subjects || [],
    options: spec.options || {},
    want: Math.max(1, Math.min(8, Number(spec.want) || 1)),
    results: [],
    attempts: 0,
    transientRetries: 0,
    safetyRetriesUsed: 0,
    nextAttemptAt: 0,
    error: null,
    errorKind: null,
    log: [],
  }));
  addJobs(jobs);
  for (const j of jobs) emit('job', j);
  tick();
  return { batchId, jobs };
}

// ---------- user actions ----------
export function cancelJob(id) {
  const job = getJob(id);
  if (!job) return null;
  if (running.has(id)) {
    running.get(id).abort();
  } else if (job.status === 'queued' || job.status === 'retrying') {
    job.status = job.results.length ? 'done' : 'canceled';
    if (job.results.length) job.want = job.results.length;
    log(job, '사용자가 취소함');
    touch(job);
  }
  return job;
}

export function retryJob(id) {
  const job = getJob(id);
  if (!job || ACTIVE.has(job.status)) return job;
  job.status = 'queued';
  job.transientRetries = 0;
  job.safetyRetriesUsed = 0;
  job.nextAttemptAt = 0;
  job.error = null;
  job.errorKind = null;
  if (job.results.length >= job.want) job.want = job.results.length + 1;
  log(job, '다시 시도 요청');
  touch(job);
  tick();
  return job;
}

// generate one more variant for a finished job
export function regenerateJob(id, count = 1) {
  const job = getJob(id);
  if (!job) return null;
  const extra = Math.max(1, Math.min(8, Number(count) || 1));
  job.want = Math.max(job.want, job.results.length) + extra;
  if (!ACTIVE.has(job.status)) {
    job.status = 'queued';
    job.transientRetries = 0;
    job.safetyRetriesUsed = 0;
    job.nextAttemptAt = 0;
    job.error = null;
    job.errorKind = null;
  }
  log(job, `추가 생성 ${extra}장 요청`);
  touch(job);
  tick();
  return job;
}

export function deleteJobs(ids) {
  for (const id of ids) running.get(id)?.abort();
  const removed = removeJobs(ids);
  for (const j of removed) emit('remove', { id: j.id });
  return removed.length;
}

export function deleteResult(jobId, file) {
  const job = getJob(jobId);
  if (!job) return null;
  const idx = job.results.findIndex((r) => r.file === file);
  if (idx >= 0) {
    job.results.splice(idx, 1);
    job.want = Math.max(1, job.want - 1);
    removeFile(file);
    touch(job);
  }
  return job;
}

// ---------- scheduler ----------
function backoffMs(n, base, cap) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, n - 1));
  return Math.round(raw * (0.75 + Math.random() * 0.5));
}

function nextReadyJob(now) {
  let best = null;
  for (const j of listJobs()) {
    if (running.has(j.id)) continue;
    if (j.status !== 'queued' && j.status !== 'retrying') continue;
    if ((j.nextAttemptAt || 0) > now) continue;
    if (!best || j.createdAt < best.createdAt) best = j;
  }
  return best;
}

export function tick() {
  if (paused) return;
  const s = getSettings();
  const now = Date.now();
  while (startTimes.length && startTimes[0] < now - 60_000) startTimes.shift();
  if (now < cooldownUntil) return;
  if (running.size >= s.concurrency) return;
  if (startTimes.length >= s.rpm) return;
  if (now - lastStart < MIN_START_GAP_MS) return;
  const job = nextReadyJob(now);
  if (!job) return;
  lastStart = now;
  startTimes.push(now);
  runJob(job);
  emitState();
}

setInterval(tick, 400).unref?.();
setInterval(emitState, 2000).unref?.();

async function runJob(job) {
  const s = getSettings();
  const ctrl = new AbortController();
  running.set(job.id, ctrl);
  job.status = 'running';
  job.attempts += 1;
  job.startedAt = Date.now();
  const model = resolveModel(job.options.model);
  log(job, `요청 시작 (${model.label}, 시도 ${job.attempts})`);
  touch(job);

  try {
    const creds = getCredentials();
    if (!creds) throw new VertexError('config', '서비스 계정 JSON이 등록되지 않았습니다. 설정 탭에서 등록하세요.');
    const ctx = { loadImage: readImage, getCharacter };
    let parts;
    try {
      parts = job.type === 'colorize' ? buildColorizeParts(job, ctx) : buildTransformParts(job, ctx);
    } catch (err) {
      throw new VertexError('config', err.message);
    }
    const aspectRatio = resolveAspectRatio(job.options.aspectRatio, job.sourceW, job.sourceH);
    const out = await generateImage({
      creds,
      location: s.location,
      model: model.id,
      parts,
      aspectRatio,
      imageSize: job.options.imageSize || undefined,
      safetyThreshold: s.safetyThreshold,
      timeoutMs: s.requestTimeoutSec * 1000,
      signal: ctrl.signal,
    });
    if (getJob(job.id) !== job) return; // deleted while the request was in flight
    const file = saveImage('outputs', { mime: out.mime, buffer: out.buffer }, `${job.id}_${Date.now().toString(36)}`);
    job.results.push({ file, createdAt: Date.now(), model: model.label, aspectRatio: aspectRatio || 'auto', text: out.text?.slice(0, 500) || '' });
    job.error = null;
    job.errorKind = null;
    job.transientRetries = 0;
    job.safetyRetriesUsed = 0;
    log(job, `완료 (${((Date.now() - job.startedAt) / 1000).toFixed(1)}초)`);
    if (job.results.length < job.want) {
      job.status = 'queued';
      job.nextAttemptAt = 0;
    } else {
      job.status = 'done';
      job.finishedAt = Date.now();
    }
  } catch (err) {
    handleFailure(job, err, s);
  } finally {
    running.delete(job.id);
    touch(job);
    emitState();
    setImmediate(tick);
  }
}

function handleFailure(job, err, s) {
  const e = err instanceof VertexError ? err : new VertexError('unknown', String(err?.message || err));
  job.error = e.message;
  job.errorKind = e.kind;
  const now = Date.now();

  if (e.kind === 'canceled') {
    job.status = job.results.length ? 'done' : 'canceled';
    if (job.results.length) job.want = job.results.length;
    log(job, '취소됨');
    return;
  }

  if (e.transient) {
    job.transientRetries += 1;
    if (job.transientRetries <= s.maxRetries) {
      let delay;
      if (e.kind === 'rate_limit') {
        delay = Math.max(e.retryAfterMs || 0, backoffMs(job.transientRetries, 10_000, 120_000));
        const pause = Math.min(delay, 60_000);
        if (now + pause > cooldownUntil) {
          cooldownUntil = now + pause;
          cooldownReason = '분당 요청 한도(429) — 잠시 대기 후 자동 재개';
        }
      } else {
        delay = Math.max(e.retryAfterMs || 0, backoffMs(job.transientRetries, 3_000, 60_000));
      }
      job.status = 'retrying';
      job.nextAttemptAt = now + delay;
      log(job, `${e.message} → ${Math.round(delay / 1000)}초 후 재시도 (${job.transientRetries}/${s.maxRetries})`, 'warn');
      return;
    }
  } else if (e.blockedLike) {
    job.safetyRetriesUsed += 1;
    if (job.safetyRetriesUsed <= s.safetyRetries) {
      job.status = 'retrying';
      job.nextAttemptAt = now + 1500;
      log(job, `${e.message} → 다시 시도 (${job.safetyRetriesUsed}/${s.safetyRetries})`, 'warn');
      return;
    }
  }

  job.status = 'failed';
  job.finishedAt = now;
  log(job, e.message, 'error');
}

// ---------- startup recovery ----------
for (const j of listJobs()) {
  if (j.status === 'running') {
    j.status = 'queued';
    j.nextAttemptAt = 0;
  }
}
flushJobs();

process.on('SIGINT', () => { flushJobs(); process.exit(0); });
process.on('SIGTERM', () => { flushJobs(); process.exit(0); });
