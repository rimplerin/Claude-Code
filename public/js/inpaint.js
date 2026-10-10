// Tab: inpaint — paint the region to change, optionally mask areas to hide from the model.
import { h, append, clear, api, toast, prepareImage, pickFiles, makeDropzone, imageFilesFrom, naturalCompare } from './util.js';
import { store } from './state.js';
import { loadOpts, saveOpts, selectField, commonOptionFields } from './common.js';
import { openMaskEditor, drawPreview, buildMaskedSubmission, loadImg, hasPaint } from './maskeditor.js';

export const CENSOR_FILL_OPTIONS = [
  { value: 'gray', label: '회색으로 채우기' },
  { value: 'black', label: '검정으로 채우기' },
  { value: 'white', label: '흰색으로 채우기' },
  { value: 'mosaic', label: '모자이크' },
];

const opts = loadOpts('inpaint', {
  model: null, imageSize: '2K', aspectRatio: 'auto', want: 1,
  prompt: '', keepOutside: true, feather: 12, censorFill: 'gray', clearAfter: true,
});
const save = () => saveOpts('inpaint', opts);

let root;
let optsEl;
let listEl;
let actionsEl;
let refsEl;
let items = [];
let refs = [];
let seq = 0;
let submitting = false;

export function initInpaint(el) {
  root = el;
  optsEl = h('div', { class: 'panel' });
  const dz = h('div', { class: 'dropzone', onclick: async () => addFiles(await pickFiles()) },
    h('div', {}, h('b', {}, '편집할 이미지 추가'), ' — 클릭, 드래그 앤 드롭 또는 Ctrl+V (여러 장 가능)'),
    h('div', { class: 'small', style: { marginTop: '4px' } }, '이미지마다 "영역 그리기"로 바꿀 곳(빨강)과 가릴 곳(파랑 = 마스킹)을 칠하세요. 마스킹한 곳은 가린 채로 전송되고, 결과에서는 원본으로 되돌려 놓습니다.'));
  makeDropzone(dz, addFiles);
  listEl = h('div', { class: 'src-list' });
  actionsEl = h('div', { class: 'sticky-actions' });
  root.append(optsEl, dz, listEl, actionsEl);
  renderOptions();
  renderActions();
  store.on('settings', renderOptions);
}

export function inpaintPaste(files) {
  addFiles(files);
  return true;
}

function renderOptions() {
  clear(optsEl);
  const set = (k) => (v) => { opts[k] = v; save(); };
  const fields = commonOptionFields(opts, save).filter((_, i) => i !== 2); // aspect ratio follows the image
  refsEl = h('div', { class: 'chips' });
  renderRefs();
  optsEl.append(
    h('h3', {}, '인페인트 옵션'),
    h('div', { class: 'opt-grid' },
      ...fields,
      selectField('마스킹 영역 채우기', CENSOR_FILL_OPTIONS, opts.censorFill, set('censorFill'), { title: '마스킹(파랑)한 곳을 어떻게 가려서 보낼지' }),
      selectField('경계 부드럽게', [0, 4, 8, 12, 20, 32].map((n) => ({ value: n, label: n ? `${n}px` : '없음' })), opts.feather, (v) => { opts.feather = Number(v); save(); }),
      h('label', { class: 'field' }, h('span', {}, '편집 영역 밖'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.keepOutside, onchange: (e) => { opts.keepOutside = e.target.checked; save(); } }), '원본 그대로 유지')),
      h('label', { class: 'field wide' }, h('span', {}, '프롬프트 (모든 이미지 공통 — 무엇을 어떻게 바꿀지)'),
        h('textarea', { rows: 3, placeholder: '예: 빨간 영역의 컵을 노트북으로 바꿔줘 / Replace the cup with a laptop', oninput: (e) => { opts.prompt = e.target.value; save(); } }, opts.prompt)),
      h('div', { class: 'field wide' },
        h('span', { class: 'small muted', style: { fontWeight: 600 } }, '참조 이미지 (선택 — 넣을 물건이나 캐릭터 등, 모든 이미지 공통)'),
        refsEl)),
  );
}

function renderRefs() {
  if (!refsEl) return;
  clear(refsEl);
  refs.forEach((r, i) => {
    refsEl.append(h('span', { class: 'chip' }, h('img', { src: r.dataUrl }), r.name,
      h('button', { type: 'button', onclick: () => { refs.splice(i, 1); renderRefs(); } }, '✕')));
  });
  refsEl.append(h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    for (const f of imageFilesFrom(await pickFiles())) {
      try { refs.push(await prepareImage(f, 1536, { keepAlpha: true })); } catch (e) { toast(e.message, 'error'); }
    }
    renderRefs();
  } }, '+ 참조 이미지'));
}

function renderActions() {
  clear(actionsEl);
  append(actionsEl,
    h('span', {}, items.length ? `이미지 ${items.length}장` : '이미지를 추가하세요'),
    h('span', { class: 'spacer' }),
    items.length ? h('button', { class: 'btn danger', onclick: () => { if (confirm('목록을 비울까요?')) { items = []; renderList(); } } }, '목록 비우기') : null,
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: opts.clearAfter, onchange: (e) => { opts.clearAfter = e.target.checked; save(); } }), '시작 후 목록 비우기'),
    h('button', { class: 'btn primary lg', disabled: !items.length || submitting, onclick: submit },
      submitting ? '전송 중…' : `인페인트 시작 (${items.length * (opts.want || 1)}장)`),
  );
}

async function addFiles(files) {
  files = imageFilesFrom(files).sort((a, b) => naturalCompare(a.name || '', b.name || ''));
  const maxPx = store.state.settings?.uploadMaxPx || 2048;
  for (const f of files) {
    try {
      const img = await prepareImage(f, maxPx);
      items.push({ id: ++seq, ...img, masks: {}, prompt: '' });
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
  const preview = h('canvas', { class: 'mask-thumb', title: '클릭해서 영역 그리기' });
  const status = h('div', { class: 'small' });
  const refresh = async () => {
    drawPreview(preview, await loadImg(item.dataUrl), item.masks);
    clear(status);
    append(status,
      h('div', {}, h('span', { class: 'dot', style: { background: '#ff3b5c' } }), hasPaint(item.masks.edit) ? '편집 영역 지정됨' : '편집 영역 없음 → 이미지 전체에 프롬프트 적용'),
      h('div', {}, h('span', { class: 'dot', style: { background: '#3aa0ff' } }), hasPaint(item.masks.censor) ? '마스킹 영역 있음 (결과에서 원본으로 복원)' : '마스킹 없음'));
  };
  const edit = () => openMaskEditor({
    src: item.dataUrl,
    layers: ['edit', 'censor'],
    masks: item.masks,
    title: `영역 그리기 — ${item.name}`,
    onSave: (m) => { item.masks = m; refresh(); },
  });
  preview.addEventListener('click', edit);
  refresh();
  return h('div', { class: 'card src-card' },
    h('div', { class: 'stage', style: { cursor: 'pointer' } }, preview),
    h('div', { class: 'src-side' },
      h('div', { class: 'src-head' },
        h('span', { class: 'name', title: item.name }, `#${idx + 1} ${item.name}`),
        h('span', { class: 'muted small' }, `${item.width}×${item.height}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm danger', onclick: () => { items = items.filter((x) => x !== item); renderList(); } }, '삭제')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: edit }, '🖌 영역 그리기'), status),
      h('label', { class: 'field' }, h('span', {}, '이 이미지에만 추가할 프롬프트 (선택)'),
        h('textarea', { rows: 2, oninput: (e) => { item.prompt = e.target.value; } }, item.prompt))));
}

async function submit() {
  if (submitting) return;
  if (!store.state.credentials.configured) {
    toast('먼저 설정 탭에서 서비스 계정 JSON을 등록하세요.', 'error');
    return;
  }
  const missing = items.findIndex((it) => !opts.prompt.trim() && !it.prompt.trim());
  if (missing >= 0) {
    toast(`#${missing + 1}: 프롬프트를 입력하세요 (공통 또는 이미지별).`, 'error');
    return;
  }
  submitting = true;
  renderActions();
  try {
    const payload = [];
    for (const it of items) {
      const sub = await buildMaskedSubmission({ src: it.dataUrl, masks: it.masks, censorFill: opts.censorFill, keepOutside: opts.keepOutside, feather: opts.feather });
      payload.push({ image: it.dataUrl, width: it.width, height: it.height, title: it.name, prompt: it.prompt, ...(sub || {}) });
    }
    const options = { model: opts.model, imageSize: opts.imageSize, aspectRatio: 'auto', prompt: opts.prompt };
    let batchId;
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const r = await api('POST', '/api/jobs/inpaint', { items: chunk, options, want: opts.want, batchId, refs: refs.map((r) => r.dataUrl) });
      batchId = r.batchId;
      chunk = [];
      size = 0;
    };
    for (const p of payload) {
      const len = [p.image, p.send, p.guide, p.restore].reduce((a, d) => a + (d?.length || 0), 0);
      if (size + len > 40e6) await flush();
      chunk.push(p);
      size += len;
    }
    await flush();
    toast(`${payload.length}장 인페인트 작업을 큐에 추가했습니다.`, 'ok');
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
