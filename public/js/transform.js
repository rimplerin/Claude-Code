// Tab 1: real photo -> 2D characters.
import { h, append, clear, api, toast, prepareImage, pickFiles, makeDropzone, imageFilesFrom, naturalCompare } from './util.js';
import { store, characterById } from './state.js';
import { loadOpts, saveOpts, selectField, seg, commonOptionFields, charThumb, pickCharacter } from './common.js';

export const SUBJECT_COLORS = ['#ff4d6d', '#3a86ff', '#2ec4b6', '#ffbe0b', '#8338ec', '#fb5607', '#06d6a0', '#ef476f'];
const POSITIONS = [
  { value: 'auto', label: '위치: 자동/박스' },
  { value: 'left', label: '왼쪽 인물' },
  { value: 'center', label: '가운데 인물' },
  { value: 'right', label: '오른쪽 인물' },
  { value: 'front', label: '앞쪽 인물' },
  { value: 'back', label: '뒤쪽 인물' },
];
const OUTFITS = [
  { value: 'character', label: '캐릭터 옷', title: '캐릭터 참조 이미지의 의상을 그대로 입힙니다' },
  { value: 'source', label: '실사 옷', title: '사진 속 인물이 입은 옷을 2D로 다시 그립니다' },
];

const opts = loadOpts('transform', {
  model: null, imageSize: '2K', aspectRatio: 'auto', want: 1,
  style: 'character', others: 'keep', noProps: true, maxRefs: 3, extra: '', clearAfter: true,
});
const save = () => saveOpts('transform', opts);

let root;
let optsEl;
let listEl;
let actionsEl;
let items = [];
let seq = 0;
let submitting = false;

const newSubject = (base = {}) => ({
  id: ++seq,
  characterId: base.characterId || null,
  outfit: base.outfit || 'character',
  position: base.position || 'auto',
  desc: base.desc || '',
  box: null,
});

export function initTransform(el) {
  root = el;
  optsEl = h('div', { class: 'panel' });
  const dz = h('div', { class: 'dropzone', onclick: async () => addFiles(await pickFiles()) },
    h('div', {}, h('b', {}, '실사 이미지 추가'), ' — 클릭, 드래그 앤 드롭 또는 Ctrl+V (여러 장 가능)'),
    h('div', { class: 'small', style: { marginTop: '4px' } }, '사진마다 "어떤 인물 → 어떤 캐릭터"를 지정합니다. 여러 명이면 인물을 추가하고 사진 위를 드래그해서 위치를 박스로 표시하세요.'));
  makeDropzone(dz, addFiles);
  listEl = h('div', { class: 'src-list' });
  actionsEl = h('div', { class: 'sticky-actions' });
  root.append(optsEl, dz, listEl, actionsEl);
  renderOptions();
  renderActions();
  store.on('settings', renderOptions);
  store.on('characters', () => items.forEach((it) => it.refresh?.()));
}

export function transformPaste(files) {
  addFiles(files);
  return true;
}

function renderOptions() {
  clear(optsEl);
  const set = (k) => (v) => { opts[k] = v; save(); };
  optsEl.append(
    h('h3', {}, '변환 옵션'),
    h('div', { class: 'opt-grid' },
      ...commonOptionFields(opts, save),
      selectField('그림체', [
        { value: 'character', label: '캐릭터 그림체 따르기' },
        { value: 'anime', label: '고퀄 TV 애니메이션' },
        { value: 'webtoon', label: '웹툰 (컬러)' },
        { value: 'manga', label: '만화 일러스트' },
      ], opts.style, set('style')),
      selectField('지정하지 않은 다른 인물', [
        { value: 'keep', label: '2D 엑스트라로 그리기' },
        { value: 'remove', label: '지우기' },
      ], opts.others, set('others')),
      selectField('캐릭터당 참조 이미지', [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: `최대 ${n}장` })), opts.maxRefs, (v) => { opts.maxRefs = Number(v); save(); }),
      h('label', { class: 'field' }, h('span', {}, '기타'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.noProps, onchange: (e) => { opts.noProps = e.target.checked; save(); } }), '캐릭터 소지품(가방 등) 빼기')),
      h('label', { class: 'field wide' }, h('span', {}, '추가 지시사항 (선택 — 모든 이미지에 적용)'),
        h('textarea', { rows: 2, placeholder: '예: 배경은 밤하늘로, 표정은 더 밝게 / Make the lighting warm sunset', oninput: (e) => { opts.extra = e.target.value; save(); } }, opts.extra))),
  );
}

function renderActions() {
  clear(actionsEl);
  const nSubj = items.reduce((a, it) => a + it.subjects.length, 0);
  append(actionsEl,
    h('span', {}, items.length ? `사진 ${items.length}장 · 인물 ${nSubj}명` : '사진을 추가하세요'),
    h('span', { class: 'spacer' }),
    items.length ? h('button', { class: 'btn', title: '모든 사진의 1번 인물을 한 캐릭터로 지정', onclick: (e) => {
      pickCharacter(e.currentTarget, { onPick: (c) => {
        for (const it of items) {
          if (!it.subjects.length) it.subjects.push(newSubject());
          it.subjects[0].characterId = c.id;
          it.refresh();
        }
        renderActions();
      } });
    } }, '1번 인물 일괄 지정') : null,
    items.length ? h('span', { class: 'row small muted' }, '옷 일괄:',
      ...OUTFITS.map((o) => h('button', { class: 'btn sm', onclick: () => {
        for (const it of items) { it.subjects.forEach((s) => { s.outfit = o.value; }); it.refresh(); }
      } }, o.label))) : null,
    items.length ? h('button', { class: 'btn danger', onclick: () => { if (confirm('목록을 모두 비울까요?')) { items = []; renderList(); } } }, '목록 비우기') : null,
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: opts.clearAfter, onchange: (e) => { opts.clearAfter = e.target.checked; save(); } }), '시작 후 목록 비우기'),
    h('button', { class: 'btn primary lg', disabled: !items.length || submitting, onclick: submit },
      submitting ? '전송 중…' : `변환 시작 (${items.length * (opts.want || 1)}장)`),
  );
}

async function addFiles(files) {
  files = imageFilesFrom(files).sort((a, b) => naturalCompare(a.name || '', b.name || ''));
  if (!files.length) return;
  const maxPx = store.state.settings?.uploadMaxPx || 2048;
  const template = items.length ? items[items.length - 1].subjects : [];
  for (const f of files) {
    try {
      const img = await prepareImage(f, maxPx);
      items.push({
        id: ++seq,
        ...img,
        active: 0,
        subjects: template.length ? template.map((s) => newSubject(s)) : [newSubject()],
      });
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 'error');
    }
  }
  renderList();
}

function renderList() {
  clear(listEl);
  items.forEach((item, idx) => listEl.append(buildCard(item, idx)));
  renderActions();
}

function buildCard(item, idx) {
  const img = h('img', { src: item.dataUrl, alt: '', draggable: 'false' });
  const boxesEl = h('div', { style: { position: 'absolute', inset: '0' } });
  const hint = h('div', { class: 'hint' });
  const stage = h('div', { class: 'stage' }, img, boxesEl, hint);
  const side = h('div', { class: 'src-side' });
  const card = h('div', { class: 'card src-card' }, stage, side);

  // ---- box drawing ----
  let drag = null;
  const rel = (e) => {
    const r = img.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.tag')) return;
    const subj = item.subjects[item.active];
    if (!subj) return;
    stage.setPointerCapture(e.pointerId);
    drag = { start: rel(e), subj, prev: subj.box };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = rel(e);
    drag.subj.box = {
      x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y),
      w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y),
    };
    renderBoxes();
  });
  const endDrag = () => {
    if (!drag) return;
    const b = drag.subj.box;
    if (!b || b.w < 0.02 || b.h < 0.02) drag.subj.box = drag.prev; // too small: treat as a click
    drag = null;
    refresh();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  function renderBoxes() {
    clear(boxesEl);
    item.subjects.forEach((s, i) => {
      if (!s.box) return;
      const color = SUBJECT_COLORS[i % SUBJECT_COLORS.length];
      boxesEl.append(h('div', {
        class: `box ${i === item.active ? 'active' : ''}`,
        style: { left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.w * 100}%`, height: `${s.box.h * 100}%`, borderColor: color },
      }, h('div', { class: 'tag', style: { background: color }, onpointerdown: (e) => { e.stopPropagation(); setActive(i); } }, i + 1)));
    });
    const subj = item.subjects[item.active];
    hint.textContent = subj
      ? `인물 ${item.active + 1} 선택됨 — 사진 위를 드래그하면 위치 박스 지정${item.subjects.length === 1 ? ' (1명이면 생략 가능)' : ''}`
      : '인물을 추가하세요';
  }

  function subjectRow(s, i) {
    const color = SUBJECT_COLORS[i % SUBJECT_COLORS.length];
    const c = characterById(s.characterId);
    const charBtn = h('button', { type: 'button', class: `char-btn ${c ? '' : 'empty'}`, onclick: (e) => {
      e.stopPropagation();
      pickCharacter(charBtn, { selected: s.characterId ? [s.characterId] : [], onPick: (picked) => { s.characterId = picked.id; refresh(); } });
    } }, charThumb(c), h('span', { class: 'lbl' }, c ? c.name : '캐릭터 선택'));
    const row = h('div', { class: `subj ${i === item.active ? 'active' : ''}` },
      h('div', { class: 'num', style: { background: color } }, i + 1),
      charBtn,
      seg(OUTFITS, s.outfit, (v) => { s.outfit = v; }),
      h('select', { class: 'pos', onclick: (e) => e.stopPropagation(), onchange: (e) => { s.position = e.target.value; } },
        POSITIONS.map((p) => h('option', { value: p.value, selected: p.value === s.position }, p.label))),
      h('input', { class: 'desc', type: 'text', value: s.desc, placeholder: '인물 설명 (예: 빨간 원피스 입은 여자)', onclick: (e) => e.stopPropagation(), oninput: (e) => { s.desc = e.target.value; } }),
      h('div', { class: 'boxinfo' }, s.box
        ? h('span', {}, '박스 ✓ ', h('button', { class: 'btn sm ghost', type: 'button', onclick: (e) => { e.stopPropagation(); s.box = null; refresh(); } }, '지우기'))
        : '박스 없음'),
      h('button', { class: 'btn sm ghost danger', type: 'button', title: '인물 삭제', onclick: (e) => {
        e.stopPropagation();
        item.subjects.splice(i, 1);
        item.active = Math.max(0, Math.min(item.active, item.subjects.length - 1));
        refresh();
        renderActions();
      } }, '✕'));
    // any interaction inside the row (including its controls) selects this person for box drawing
    row.addEventListener('pointerdown', () => setActive(i), true);
    return row;
  }

  function setActive(i) {
    if (item.active === i) return;
    item.active = i;
    side.querySelectorAll('.subj').forEach((el, k) => el.classList.toggle('active', k === i));
    renderBoxes();
  }

  function refresh() {
    clear(side);
    append(side,
      h('div', { class: 'src-head' },
        h('span', { class: 'name', title: item.name }, `#${idx + 1} ${item.name}`),
        h('span', { class: 'muted small' }, `${item.width}×${item.height}`),
        h('span', { class: 'spacer' }),
        items.length > 1 ? h('button', { class: 'btn sm', title: '이 사진의 인물 설정(캐릭터/옷/위치/설명)을 다른 모든 사진에 복사합니다. 박스는 복사되지 않습니다.', onclick: () => {
          for (const other of items) {
            if (other === item) continue;
            other.subjects = item.subjects.map((s) => newSubject(s));
            other.active = 0;
            other.refresh();
          }
          renderActions();
          toast('다른 사진들에 인물 설정을 복사했습니다.');
        } }, '이 설정을 전체에 적용') : null,
        h('button', { class: 'btn sm danger', onclick: () => { items = items.filter((x) => x !== item); renderList(); } }, '사진 삭제')),
      ...item.subjects.map(subjectRow),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => {
          item.subjects.push(newSubject({ outfit: item.subjects[item.subjects.length - 1]?.outfit }));
          item.active = item.subjects.length - 1;
          refresh();
          renderActions();
        } }, '+ 인물 추가'),
        item.subjects.length > 1 && item.subjects.some((s) => !s.box && s.position === 'auto' && !s.desc)
          ? h('span', { class: 'small', style: { color: 'var(--orange)' } }, '여러 명일 때는 각 인물의 박스·위치·설명 중 하나 이상을 지정하세요.')
          : null),
    );
    renderBoxes();
  }

  item.refresh = refresh;
  refresh();
  return card;
}

// Draws numbered boxes on a copy of the photo so the model can tell people apart.
async function buildGuide(item) {
  const boxed = item.subjects.some((s) => s.box);
  if (!boxed) return null;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = item.dataUrl;
  });
  const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * scale);
  const H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const lw = Math.max(4, Math.round(Math.max(W, H) * 0.006));
  const fs = Math.max(22, Math.round(Math.max(W, H) * 0.045));
  item.subjects.forEach((s, i) => {
    if (!s.box) return;
    const color = SUBJECT_COLORS[i % SUBJECT_COLORS.length];
    const x = s.box.x * W;
    const y = s.box.y * H;
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, s.box.w * W, s.box.h * H);
    ctx.font = `bold ${fs}px sans-serif`;
    const label = String(i + 1);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, tw + fs * 0.6, fs * 1.25);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x + fs * 0.3, y + fs * 0.12);
  });
  return canvas.toDataURL('image/jpeg', 0.88);
}

async function submit() {
  if (submitting) return;
  if (!store.state.credentials.configured) {
    toast('먼저 설정 탭에서 서비스 계정 JSON을 등록하세요.', 'error');
    return;
  }
  for (const [i, it] of items.entries()) {
    const bad = !it.subjects.length || it.subjects.some((s) => !characterById(s.characterId));
    if (bad) {
      toast(`#${i + 1} ${it.name}: 모든 인물에 캐릭터를 선택하세요.`, 'error');
      listEl.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
  submitting = true;
  renderActions();
  try {
    const payloadItems = [];
    for (const it of items) {
      payloadItems.push({
        image: it.dataUrl,
        guide: await buildGuide(it),
        width: it.width,
        height: it.height,
        title: it.name,
        subjects: it.subjects.map(({ characterId, outfit, position, desc, box }) => ({ characterId, outfit, position, desc, box })),
      });
    }
    const options = { model: opts.model, imageSize: opts.imageSize, aspectRatio: opts.aspectRatio, style: opts.style, others: opts.others, noProps: opts.noProps, maxRefs: opts.maxRefs, extra: opts.extra };
    // send in chunks so a large batch doesn't hit request size limits
    let batchId;
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const r = await api('POST', '/api/jobs/transform', { items: chunk, options, want: opts.want, batchId });
      batchId = r.batchId;
      chunk = [];
      size = 0;
    };
    for (const p of payloadItems) {
      const len = p.image.length + (p.guide?.length || 0);
      if (size + len > 40e6) await flush();
      chunk.push(p);
      size += len;
    }
    await flush();
    toast(`${payloadItems.length}장 작업을 큐에 추가했습니다.`, 'ok');
    if (opts.clearAfter) items = [];
    renderList();
    document.querySelector('[data-tab="jobs"]').click();
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    submitting = false;
    renderActions();
  }
}
