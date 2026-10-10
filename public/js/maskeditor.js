// Mask painting editor + helpers that turn masks into what the server needs.
//
// Two kinds of layers:
//   edit   – (inpaint) where the model should change things
//   censor – areas hidden from the model (filled before sending) and pasted back
//            from the original after generation, to avoid needless safety blocks
import { h, append, clear, openModal } from './util.js';
import { seg } from './common.js';

export const LAYERS = {
  edit: { key: 'edit', label: '편집 영역', color: '#ff3b5c', hint: '이 영역만 바뀝니다' },
  censor: { key: 'censor', label: '마스킹', color: '#3aa0ff', hint: '가린 채로 전송 → 결과에서 원본으로 복원' },
};

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    img.src = src;
  });
}

function canvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  return c;
}

function copyCanvas(src) {
  const c = canvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function hasPaint(c) {
  if (!c) return false;
  // check a downscaled copy: fast and good enough to detect any stroke
  const s = Math.min(1, 256 / Math.max(c.width, c.height));
  const t = canvas(Math.max(1, Math.round(c.width * s)), Math.max(1, Math.round(c.height * s)));
  const ctx = t.getContext('2d');
  ctx.drawImage(c, 0, 0, t.width, t.height);
  const d = ctx.getImageData(0, 0, t.width, t.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
  return false;
}

// mask (alpha) -> solid color shape
function tint(mask, color) {
  const t = canvas(mask.width, mask.height);
  const ctx = t.getContext('2d');
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, t.width, t.height);
  return t;
}

// grows a mask by r pixels (cheap approximation: stamp it in a ring of offsets)
function dilate(mask, r) {
  if (r < 1) return mask;
  const out = canvas(mask.width, mask.height);
  const ctx = out.getContext('2d');
  const steps = 12;
  ctx.drawImage(mask, 0, 0);
  for (const rr of [r / 2, r]) {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ctx.drawImage(mask, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  return out;
}

/** Draws image + tinted masks into a preview canvas element (used for thumbnails). */
export function drawPreview(target, img, masks = {}, maxPx = 520) {
  const s = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  target.width = Math.round(img.naturalWidth * s);
  target.height = Math.round(img.naturalHeight * s);
  const ctx = target.getContext('2d');
  ctx.drawImage(img, 0, 0, target.width, target.height);
  for (const key of ['censor', 'edit']) {
    const m = masks[key];
    if (!m) continue;
    ctx.globalAlpha = key === 'censor' ? 0.75 : 0.45;
    ctx.drawImage(tint(m, LAYERS[key].color), 0, 0, target.width, target.height);
    ctx.globalAlpha = 1;
  }
}

/**
 * Opens the painting editor.
 * layers: ['edit','censor'] or ['censor']; masks: {edit?: canvas, censor?: canvas}
 * onSave(masks) receives canvases (null when a layer is empty).
 */
export async function openMaskEditor({ src, layers = ['censor'], masks = {}, title = '영역 지정', onSave }) {
  const img = await loadImg(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const work = {};
  for (const k of layers) work[k] = masks[k] ? copyCanvas(masks[k]) : canvas(W, H);

  let layer = layers[0];
  let tool = 'brush';
  let size = Math.max(6, Math.round(Math.max(W, H) * 0.03));
  const undo = [];

  const overlay = canvas(W, H);
  overlay.className = 'mask-overlay';
  const octx = overlay.getContext('2d');
  const stage = h('div', { class: 'mask-stage' }, h('img', { src, draggable: 'false' }), overlay);

  let cursor = null;
  let rectPreview = null;
  let frame = 0;
  function render() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      octx.clearRect(0, 0, W, H);
      for (const k of layers) {
        octx.globalAlpha = k === 'censor' ? 0.7 : 0.45;
        octx.drawImage(tint(work[k], LAYERS[k].color), 0, 0);
      }
      octx.globalAlpha = 1;
      const lw = Math.max(1, Math.max(W, H) / 500);
      if (rectPreview) {
        octx.strokeStyle = LAYERS[layer].color;
        octx.lineWidth = lw * 2;
        octx.setLineDash([lw * 6, lw * 4]);
        octx.strokeRect(rectPreview.x, rectPreview.y, rectPreview.w, rectPreview.h);
        octx.setLineDash([]);
      }
      if (cursor && tool !== 'rect') {
        octx.beginPath();
        octx.arc(cursor.x, cursor.y, size / 2, 0, Math.PI * 2);
        octx.lineWidth = lw * 1.5;
        octx.strokeStyle = '#fff';
        octx.stroke();
        octx.lineWidth = lw * 0.75;
        octx.strokeStyle = '#000';
        octx.stroke();
      }
    });
  }

  const pos = (e) => {
    const r = overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const pushUndo = () => {
    undo.push({ layer, canvas: copyCanvas(work[layer]) });
    if (undo.length > 15) undo.shift();
  };
  const strokeCtx = () => {
    const ctx = work[layer].getContext('2d');
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    return ctx;
  };

  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    overlay.setPointerCapture(e.pointerId);
    pushUndo();
    const p = pos(e);
    drag = { start: p, last: p };
    if (tool !== 'rect') {
      const ctx = strokeCtx();
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    render();
  });
  overlay.addEventListener('pointermove', (e) => {
    const p = pos(e);
    cursor = p;
    if (drag) {
      if (tool === 'rect') {
        rectPreview = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
      } else {
        const ctx = strokeCtx();
        ctx.beginPath();
        ctx.moveTo(drag.last.x, drag.last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        drag.last = p;
      }
    }
    render();
  });
  const end = () => {
    if (drag && tool === 'rect' && rectPreview && rectPreview.w > 2 && rectPreview.h > 2) {
      const ctx = strokeCtx();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillRect(rectPreview.x, rectPreview.y, rectPreview.w, rectPreview.h);
    }
    drag = null;
    rectPreview = null;
    render();
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', end);
  overlay.addEventListener('pointerleave', () => { cursor = null; render(); });
  overlay.addEventListener('wheel', (e) => {
    if (!e.altKey && !e.ctrlKey) return;
    e.preventDefault();
    setSize(size * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

  const sizeInput = h('input', { type: 'range', min: 2, max: Math.round(Math.max(W, H) / 4), value: size, oninput: (e) => setSize(Number(e.target.value), false) });
  const sizeLabel = h('span', { class: 'small muted', style: { minWidth: '56px' } });
  function setSize(v, syncSlider = true) {
    size = Math.max(2, Math.min(Math.max(W, H) / 2, Math.round(v)));
    sizeLabel.textContent = `${size}px`;
    if (syncSlider) sizeInput.value = size;
    render();
  }
  setSize(size);

  const legend = h('div', { class: 'small muted' });
  const setLayer = (k) => {
    layer = k;
    clear(legend).append(`${LAYERS[k].label}: ${LAYERS[k].hint}`);
  };
  setLayer(layer);

  const toolSeg = seg([
    { value: 'brush', label: '브러시 (B)' },
    { value: 'rect', label: '사각형 (R)' },
    { value: 'eraser', label: '지우개 (E)' },
  ], tool, (v) => { tool = v; render(); });

  const doUndo = () => {
    const u = undo.pop();
    if (!u) return;
    work[u.layer] = u.canvas;
    render();
  };

  const toolbar = h('div', { class: 'row', style: { marginBottom: '10px' } });
  append(toolbar,
    layers.length > 1 ? seg(layers.map((k) => ({ value: k, label: LAYERS[k].label })), layer, setLayer) : h('b', {}, LAYERS[layer].label),
    toolSeg,
    h('span', { class: 'small' }, '크기'), sizeInput, sizeLabel,
    h('button', { class: 'btn sm', onclick: doUndo }, '실행취소 (Ctrl+Z)'),
    h('button', { class: 'btn sm', onclick: () => { pushUndo(); work[layer].getContext('2d').clearRect(0, 0, W, H); render(); } }, '현재 레이어 지우기'),
  );

  const onKey = (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    else if (e.key === 'b' || e.key === 'B') toolSeg.querySelectorAll('button')[0].click();
    else if (e.key === 'r' || e.key === 'R') toolSeg.querySelectorAll('button')[1].click();
    else if (e.key === 'e' || e.key === 'E') toolSeg.querySelectorAll('button')[2].click();
    else if (e.key === '[') setSize(size / 1.2);
    else if (e.key === ']') setSize(size * 1.2);
  };
  document.addEventListener('keydown', onKey);

  const m = openModal(h('div', {},
    h('h2', {}, title),
    toolbar,
    legend,
    h('div', { class: 'help', style: { margin: '4px 0 8px' } }, '드래그해서 칠하세요. [ ] 키 또는 Alt+휠로 브러시 크기를 바꿉니다.'),
    stage,
    h('div', { class: 'foot' },
      h('button', { class: 'btn', onclick: () => m.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: () => {
        const out = {};
        for (const k of layers) out[k] = hasPaint(work[k]) ? work[k] : null;
        onSave?.(out);
        m.close();
      } }, '적용')),
  ), { wide: true, onClose: () => document.removeEventListener('keydown', onKey) });
  render();
}

function closestRatio(w, hgt) {
  const t = Math.log(w / hgt);
  let best = RATIOS[0];
  let diff = Infinity;
  for (const r of RATIOS) {
    const [a, b] = r.split(':').map(Number);
    const d = Math.abs(Math.log(a / b) - t);
    if (d < diff) { diff = d; best = r; }
  }
  return best;
}

function fillCensor(img, mask, fill) {
  const W = mask.width;
  const H = mask.height;
  const t = canvas(W, H);
  const ctx = t.getContext('2d');
  if (fill === 'mosaic') {
    const block = Math.max(8, Math.round(Math.max(W, H) / 48));
    const small = canvas(Math.max(1, Math.round(W / block)), Math.max(1, Math.round(H / block)));
    small.getContext('2d').drawImage(img, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, W, H);
  } else {
    ctx.fillStyle = { black: '#000', white: '#fff' }[fill] || '#808080';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(dilate(mask, 2), 0, 0);
  return t;
}

/**
 * Turns masks into the files the server needs. Returns null when nothing is painted.
 *  send    – image to submit: censored areas filled, padded to a supported aspect ratio
 *  guide   – (edit layer) the send image with the edit region highlighted in red
 *  restore – grayscale mask at source resolution, white = paste the original back
 *  pad     – content rectangle inside the padded image + the ratio to request
 */
export async function buildMaskedSubmission({ src, masks = {}, censorFill = 'gray', keepOutside = true, feather = 12 }) {
  const censor = masks.censor && hasPaint(masks.censor) ? masks.censor : null;
  const edit = masks.edit && hasPaint(masks.edit) ? masks.edit : null;
  if (!censor && !edit) return null;
  const img = await loadImg(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;

  // pad to the closest supported ratio so the result can be aligned back pixel-accurately
  const ratio = closestRatio(W, H);
  const [ra, rb] = ratio.split(':').map(Number);
  const r = ra / rb;
  let PW = W;
  let PH = H;
  if (W / H > r) PH = Math.round(W / r); else PW = Math.round(H * r);
  const ox = Math.round((PW - W) / 2);
  const oy = Math.round((PH - H) / 2);

  const send = canvas(PW, PH);
  const sctx = send.getContext('2d');
  if (PW !== W || PH !== H) {
    // blurred stretched copy behind the image so the padding looks like natural continuation
    sctx.filter = 'blur(24px)';
    sctx.drawImage(img, 0, 0, PW, PH);
    sctx.filter = 'none';
  }
  sctx.drawImage(img, ox, oy);
  if (censor) sctx.drawImage(fillCensor(img, censor, censorFill), ox, oy);

  let guide = null;
  if (edit) {
    const s = Math.min(1, 1536 / Math.max(PW, PH));
    const g = canvas(Math.round(PW * s), Math.round(PH * s));
    const gctx = g.getContext('2d');
    gctx.drawImage(send, 0, 0, g.width, g.height);
    gctx.globalAlpha = 0.5;
    gctx.drawImage(tint(edit, '#ff0000'), ox * s, oy * s, W * s, H * s);
    guide = g.toDataURL('image/jpeg', 0.9);
  }

  let restore = null;
  if (censor || (edit && keepOutside)) {
    const keep = canvas(W, H); // white (alpha) = keep the original pixel
    const kctx = keep.getContext('2d');
    if (edit && keepOutside) {
      kctx.fillStyle = '#fff';
      kctx.fillRect(0, 0, W, H);
      kctx.globalCompositeOperation = 'destination-out';
      if (feather > 0) kctx.filter = `blur(${feather / 2}px)`;
      kctx.drawImage(dilate(edit, feather / 2), 0, 0);
      kctx.filter = 'none';
      kctx.globalCompositeOperation = 'source-over';
    }
    if (censor) {
      const solid = tint(dilate(censor, 3), '#fff');
      kctx.filter = 'blur(1.5px)';
      kctx.drawImage(solid, 0, 0);
      kctx.filter = 'none';
      kctx.drawImage(tint(censor, '#fff'), 0, 0);
    }
    const out = canvas(W, H);
    const octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(keep, 0, 0);
    restore = out.toDataURL('image/png');
  }

  return {
    send: send.toDataURL('image/jpeg', 0.94),
    guide,
    restore,
    censorFill: censor ? censorFill : null,
    pad: { x: ox / PW, y: oy / PH, w: W / PW, h: H / PH, ratio },
  };
}
