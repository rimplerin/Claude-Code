// Simple JSON-file persistence for settings, credentials, characters and jobs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const UPLOADS_DIR = path.join(FILES_DIR, 'uploads');
export const OUTPUTS_DIR = path.join(FILES_DIR, 'outputs');
export const CHARACTERS_DIR = path.join(FILES_DIR, 'characters');

for (const dir of [DATA_DIR, FILES_DIR, UPLOADS_DIR, OUTPUTS_DIR, CHARACTERS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const DEFAULT_SETTINGS = {
  location: 'global',
  models: [
    { key: 'nb2', label: 'Nano Banana 2', id: 'gemini-3.1-flash-image' },
    { key: 'nbpro', label: 'Nano Banana Pro', id: 'gemini-3-pro-image' },
  ],
  defaultModel: 'nb2',
  concurrency: 2,          // simultaneous requests
  rpm: 10,                 // max requests started per minute
  maxRetries: 6,           // network / 429 / 5xx retries per job
  safetyRetries: 3,        // retries when the response is blocked or has no image
  requestTimeoutSec: 300,  // per-request timeout
  safetyThreshold: 'OFF',  // OFF or BLOCK_NONE
  uploadMaxPx: 2048,       // client-side downscale of source photos
  colorizeMaxPx: 2560,     // client-side downscale of manga pages
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };

export function getSettings() {
  return settings;
}

const clampInt = (v, min, max, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function updateSettings(patch) {
  const next = { ...settings };
  if (typeof patch.location === 'string' && patch.location.trim()) next.location = patch.location.trim();
  if (Array.isArray(patch.models)) {
    const models = patch.models
      .filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m, i) => ({
        key: String(m.key || `m${i}`).trim(),
        label: String(m.label || m.id).trim(),
        id: m.id.trim(),
      }));
    if (models.length) next.models = models;
  }
  if (typeof patch.defaultModel === 'string') next.defaultModel = patch.defaultModel;
  if (!next.models.some((m) => m.key === next.defaultModel)) next.defaultModel = next.models[0].key;
  next.concurrency = clampInt(patch.concurrency ?? next.concurrency, 1, 16, DEFAULT_SETTINGS.concurrency);
  next.rpm = clampInt(patch.rpm ?? next.rpm, 1, 600, DEFAULT_SETTINGS.rpm);
  next.maxRetries = clampInt(patch.maxRetries ?? next.maxRetries, 0, 30, DEFAULT_SETTINGS.maxRetries);
  next.safetyRetries = clampInt(patch.safetyRetries ?? next.safetyRetries, 0, 20, DEFAULT_SETTINGS.safetyRetries);
  next.requestTimeoutSec = clampInt(patch.requestTimeoutSec ?? next.requestTimeoutSec, 30, 1800, DEFAULT_SETTINGS.requestTimeoutSec);
  next.uploadMaxPx = clampInt(patch.uploadMaxPx ?? next.uploadMaxPx, 512, 8192, DEFAULT_SETTINGS.uploadMaxPx);
  next.colorizeMaxPx = clampInt(patch.colorizeMaxPx ?? next.colorizeMaxPx, 512, 8192, DEFAULT_SETTINGS.colorizeMaxPx);
  if (patch.safetyThreshold === 'OFF' || patch.safetyThreshold === 'BLOCK_NONE') next.safetyThreshold = patch.safetyThreshold;
  settings = next;
  writeJsonAtomic(SETTINGS_FILE, settings);
  return settings;
}

export function resolveModel(key) {
  return settings.models.find((m) => m.key === key || m.id === key) || settings.models[0];
}

// ---------- credentials (service account JSON) ----------
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

export function getCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !fs.existsSync(CREDENTIALS_FILE)) {
    return readJson(process.env.GOOGLE_APPLICATION_CREDENTIALS, null);
  }
  return readJson(CREDENTIALS_FILE, null);
}

export function saveCredentials(creds) {
  writeJsonAtomic(CREDENTIALS_FILE, creds);
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* windows */ }
}

export function deleteCredentials() {
  fs.rmSync(CREDENTIALS_FILE, { force: true });
}

// ---------- files ----------
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export function parseDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl || '');
  if (!m) throw new Error('잘못된 이미지 데이터입니다.');
  const mime = m[1].toLowerCase();
  if (!EXT_BY_MIME[mime]) throw new Error(`지원하지 않는 이미지 형식: ${mime}`);
  return { mime, buffer: Buffer.from(m[2], 'base64') };
}

// Saves an image into a sub directory of FILES_DIR, deduplicated by content hash.
// Returns a path relative to FILES_DIR (forward slashes) usable as /files/<rel>.
export function saveImage(subdir, { mime, buffer }, name) {
  const ext = EXT_BY_MIME[mime] || 'png';
  const base = name || crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 20);
  const rel = `${subdir}/${base}.${ext}`;
  const abs = path.join(FILES_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer);
  return rel;
}

export function readImage(rel) {
  const abs = path.join(FILES_DIR, rel);
  if (!abs.startsWith(FILES_DIR)) throw new Error('invalid path');
  const ext = path.extname(abs).slice(1).toLowerCase();
  return { mime: MIME_BY_EXT[ext] || 'image/png', buffer: fs.readFileSync(abs) };
}

export function removeFile(rel) {
  if (!rel) return;
  const abs = path.join(FILES_DIR, rel);
  if (abs.startsWith(FILES_DIR)) fs.rmSync(abs, { force: true });
}

// ---------- characters ----------
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
let characters = readJson(CHARACTERS_FILE, []);

export function listCharacters() {
  return characters;
}

export function getCharacter(id) {
  return characters.find((c) => c.id === id) || null;
}

function saveCharacters() {
  writeJsonAtomic(CHARACTERS_FILE, characters);
}

const GENDERS = ['female', 'male', 'other'];

function sanitizeCharacter(input, base = {}) {
  return {
    ...base,
    name: String(input.name ?? base.name ?? '').trim().slice(0, 100) || '이름 없음',
    series: String(input.series ?? base.series ?? '').trim().slice(0, 100),
    gender: GENDERS.includes(input.gender) ? input.gender : base.gender || 'female',
    description: String(input.description ?? base.description ?? '').trim().slice(0, 2000),
  };
}

export function createCharacter(input) {
  const c = { id: newId('c'), ...sanitizeCharacter(input), images: [], createdAt: Date.now(), updatedAt: Date.now() };
  characters.push(c);
  saveCharacters();
  return c;
}

export function updateCharacter(id, input) {
  const idx = characters.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const cur = characters[idx];
  const next = { ...sanitizeCharacter(input, cur), updatedAt: Date.now() };
  if (Array.isArray(input.images)) {
    // reorder / subset of existing images only
    const set = new Set(cur.images);
    next.images = input.images.filter((f) => set.has(f));
    for (const f of cur.images) if (!next.images.includes(f)) removeFile(f);
  }
  characters[idx] = next;
  saveCharacters();
  return next;
}

export function addCharacterImage(id, image) {
  const c = getCharacter(id);
  if (!c) return null;
  const rel = saveImage(`characters/${id}`, image);
  if (!c.images.includes(rel)) c.images.push(rel);
  c.updatedAt = Date.now();
  saveCharacters();
  return c;
}

export function deleteCharacter(id) {
  const c = getCharacter(id);
  if (!c) return false;
  characters = characters.filter((x) => x.id !== id);
  fs.rmSync(path.join(CHARACTERS_DIR, id), { recursive: true, force: true });
  saveCharacters();
  return true;
}

// ---------- jobs ----------
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
let jobs = readJson(JOBS_FILE, []);
let saveTimer = null;

export function listJobs() {
  return jobs;
}

export function getJob(id) {
  return jobs.find((j) => j.id === id) || null;
}

export function addJobs(list) {
  jobs.push(...list);
  scheduleJobsSave();
}

export function removeJobs(ids) {
  const set = new Set(ids);
  const removed = jobs.filter((j) => set.has(j.id));
  jobs = jobs.filter((j) => !set.has(j.id));
  const stillUsed = new Set();
  for (const j of jobs) {
    if (j.sourceFile) stillUsed.add(j.sourceFile);
    if (j.guideFile) stillUsed.add(j.guideFile);
  }
  for (const j of removed) {
    for (const r of j.results || []) removeFile(r.file);
    if (j.sourceFile && !stillUsed.has(j.sourceFile)) removeFile(j.sourceFile);
    if (j.guideFile && !stillUsed.has(j.guideFile)) removeFile(j.guideFile);
  }
  scheduleJobsSave();
  return removed;
}

export function scheduleJobsSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJsonAtomic(JOBS_FILE, jobs);
  }, 300);
}

export function flushJobs() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeJsonAtomic(JOBS_FILE, jobs);
}
