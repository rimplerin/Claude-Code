// DOM / network / image helpers shared by all tabs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = Boolean(v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Element.append() would print null/false as text, so filter them out.
export function append(el, ...children) {
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요. (${err.message})`);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function toast(msg, type = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export const fileUrl = (rel) => (rel ? `/files/${rel}` : '');

export function fmtTime(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ---------- images ----------
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    img.src = src;
  });
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function hasAlpha(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * 17) if (data[i] < 250) return true;
  return false;
}

/**
 * Reads an image file and downsizes it so the long edge is <= maxPx.
 * Small JPEG/PNG files are passed through untouched.
 * keepAlpha: re-encode as PNG if the image has transparency (character sheets).
 */
export async function prepareImage(file, maxPx = 2048, { keepAlpha = false, quality = 0.93 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    const scale = Math.min(1, maxPx / Math.max(w0, h0));
    const passthrough = scale === 1 && ['image/jpeg', 'image/png'].includes(file.type) && file.size < 7 * 1024 * 1024;
    if (passthrough) {
      return { dataUrl: await readAsDataUrl(file), width: w0, height: h0, name: file.name || 'image' };
    }
    const w = Math.round(w0 * scale);
    const hgt = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, hgt);
    const png = keepAlpha && hasAlpha(ctx, w, hgt);
    if (!png) {
      // flatten transparency on white for JPEG
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, hgt);
    }
    const dataUrl = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', quality);
    return { dataUrl, width: w, height: hgt, name: file.name || 'image' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageFilesFrom(list) {
  return [...(list || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
}

export function pickFiles({ accept = 'image/*', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

// Makes an element a drop target for image files.
export function makeDropzone(el, onFiles, { accept = (f) => f.type.startsWith('image/') } = {}) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drag');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag');
    const files = [...(e.dataTransfer?.files || [])].filter(accept);
    if (files.length) onFiles(files);
  });
}

export function download(url, filename) {
  const a = h('a', { href: url, download: filename || '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- modal ----------
export function openModal(content, { onClose, wide } = {}) {
  const root = document.getElementById('modal-root');
  const modal = h('div', { class: 'modal', style: wide ? { width: 'min(1100px, 100%)' } : undefined }, content);
  const back = h('div', { class: 'modal-back' }, modal);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  root.append(back);
  return { close, modal };
}

// ---------- simple store ----------
export function createStore(initial) {
  const state = { ...initial };
  const subs = new Map();
  return {
    state,
    set(key, value) {
      state[key] = value;
      for (const fn of subs.get(key) || []) fn(value);
    },
    emit(key) {
      for (const fn of subs.get(key) || []) fn(state[key]);
    },
    on(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => subs.get(key).delete(fn);
    },
  };
}
