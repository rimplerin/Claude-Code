// Tab 2: black-and-white manga page -> official digital color version.
import { h, append, clear, api, toast, prepareImage, pickFiles, makeDropzone, imageFilesFrom, naturalCompare, fileUrl } from './util.js';
import { store, characterById } from './state.js';
import { loadOpts, saveOpts, selectField, commonOptionFields, pickCharacter } from './common.js';
import { openMaskEditor, drawPreview, buildMaskedSubmission, loadImg, hasPaint } from './maskeditor.js';
import { CENSOR_FILL_OPTIONS } from './inpaint.js';

const opts = loadOpts('colorize', {
  model: null, imageSize: '2K', aspectRatio: 'auto', want: 1,
  style: 'official', keepText: true, refs: [], extra: '', clearAfter: true, censorFill: 'white',
});
const save = () => saveOpts('colorize', opts);

let root;
let optsEl;
let gridEl;
let actionsEl;
let pages = [];
let seq = 0;
let submitting = false;

export function initColorize(el) {
  root = el;
  optsEl = h('div', { class: 'panel' });
  const dz = h('div', { class: 'dropzone', onclick: async () => addFiles(await pickFiles()) },
    h('div', {}, h('b', {}, '흑백 만화 페이지 추가'), ' — 클릭, 드래그 앤 드롭 또는 Ctrl+V (여러 장 가능, 파일명 순 정렬)'),
    h('div', { class: 'small', style: { marginTop: '4px' } }, '검열에 걸릴 만한 부분은 페이지의 "마스킹" 버튼으로 칠해 두세요. 가린 채로 채색을 요청하고, 결과에서는 그 부분만 원본으로 되돌립니다.'));
  makeDropzone(dz, addFiles);
  gridEl = h('div', { class: 'page-grid' });
  actionsEl = h('div', { class: 'sticky-actions' });
  root.append(optsEl, dz, gridEl, actionsEl);
  renderOptions();
  renderActions();
  store.on('settings', renderOptions);
  store.on('characters', renderOptions);
}

export function colorizePaste(files) {
  addFiles(files);
  return true;
}

function renderOptions() {
  clear(optsEl);
  const set = (k) => (v) => { opts[k] = v; save(); };
  opts.refs = (opts.refs || []).filter((id) => characterById(id) || !store.state.characters.length);
  const refChips = h('div', { class: 'chips' });
  const renderChips = () => {
    clear(refChips);
    for (const id of opts.refs) {
      const c = characterById(id);
      if (!c) continue;
      refChips.append(h('span', { class: 'chip' },
        c.images[0] ? h('img', { src: fileUrl(c.images[0]) }) : null, c.name,
        h('button', { type: 'button', title: '제거', onclick: () => { opts.refs = opts.refs.filter((x) => x !== id); save(); renderChips(); } }, '✕')));
    }
    const addBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => {
      pickCharacter(addBtn, { multi: true, selected: opts.refs, onPick: (c) => {
        opts.refs = opts.refs.includes(c.id) ? opts.refs.filter((x) => x !== c.id) : [...opts.refs, c.id].slice(0, 6);
        save();
        renderChips();
      } });
    } }, '+ 캐릭터 색상 참조');
    refChips.append(addBtn);
  };
  renderChips();

  optsEl.append(
    h('h3', {}, '채색 옵션'),
    h('div', { class: 'opt-grid' },
      ...commonOptionFields(opts, save),
      selectField('마스킹 영역 채우기', CENSOR_FILL_OPTIONS, opts.censorFill, set('censorFill'), { title: '페이지마다 "마스킹"으로 칠한 곳을 어떻게 가려서 보낼지. 결과에서는 원본(흑백)으로 복원됩니다.' }),
      selectField('채색 스타일', [
        { value: 'official', label: '공식 디지털 컬러판' },
        { value: 'anime', label: '애니메이션 셀 채색' },
        { value: 'painterly', label: '웹툰풍 부드러운 채색' },
      ], opts.style, set('style')),
      h('label', { class: 'field' }, h('span', {}, '텍스트'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.keepText, onchange: (e) => { opts.keepText = e.target.checked; save(); } }), '대사·효과음 그대로 유지')),
      h('div', { class: 'field wide' }, h('span', { class: 'small muted', style: { fontWeight: 600 } }, '캐릭터 색상 참조 (선택 — 라이브러리 캐릭터의 머리/눈/옷 색을 맞춥니다, 최대 6명)'), refChips),
      h('label', { class: 'field wide' }, h('span', {}, '추가 지시사항 (선택 — 예: 주인공 머리는 은발, 눈은 보라색 / 밤 장면)'),
        h('textarea', { rows: 2, oninput: (e) => { opts.extra = e.target.value; save(); } }, opts.extra))),
  );
}

function renderActions() {
  clear(actionsEl);
  append(actionsEl,
    h('span', {}, pages.length ? `페이지 ${pages.length}장` : '페이지를 추가하세요'),
    h('span', { class: 'spacer' }),
    pages.length ? h('button', { class: 'btn danger', onclick: () => { if (confirm('목록을 비울까요?')) { pages = []; renderGrid(); } } }, '목록 비우기') : null,
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: opts.clearAfter, onchange: (e) => { opts.clearAfter = e.target.checked; save(); } }), '시작 후 목록 비우기'),
    h('button', { class: 'btn primary lg', disabled: !pages.length || submitting, onclick: submit },
      submitting ? '전송 중…' : `채색 시작 (${pages.length * (opts.want || 1)}장)`),
  );
}

async function addFiles(files) {
  files = imageFilesFrom(files).sort((a, b) => naturalCompare(a.name || '', b.name || ''));
  const maxPx = store.state.settings?.colorizeMaxPx || 2560;
  for (const f of files) {
    try {
      pages.push({ id: ++seq, masks: {}, ...(await prepareImage(f, maxPx, { quality: 0.95 })) });
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 'error');
    }
  }
  renderGrid();
}

function renderGrid() {
  clear(gridEl);
  pages.forEach((p, i) => {
    const thumb = h('canvas', { class: 'page-thumb', title: '클릭해서 마스킹 영역 그리기' });
    loadImg(p.dataUrl).then((img) => drawPreview(thumb, img, p.masks, 360));
    const masked = hasPaint(p.masks.censor);
    const editMask = () => openMaskEditor({
      src: p.dataUrl,
      layers: ['censor'],
      masks: p.masks,
      title: `마스킹 — ${p.name}`,
      onSave: (m) => { p.masks = m; renderGrid(); },
    });
    thumb.addEventListener('click', editMask);
    gridEl.append(h('div', { class: 'card page-item' },
      thumb,
      h('div', { class: 'nm', title: p.name }, `${i + 1}. ${p.name}`),
      h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', { class: `btn sm ${masked ? 'primary' : ''}`, onclick: editMask }, masked ? '🖌 마스킹 ✓' : '🖌 마스킹'),
        masked ? h('button', { class: 'btn sm ghost', onclick: () => { p.masks = {}; renderGrid(); } }, '해제') : null),
      h('button', { class: 'btn sm x', onclick: () => { pages = pages.filter((x) => x !== p); renderGrid(); } }, '✕')));
  });
  renderActions();
}

async function submit() {
  if (submitting) return;
  if (!store.state.credentials.configured) {
    toast('먼저 설정 탭에서 서비스 계정 JSON을 등록하세요.', 'error');
    return;
  }
  submitting = true;
  renderActions();
  try {
    const options = { model: opts.model, imageSize: opts.imageSize, aspectRatio: opts.aspectRatio, style: opts.style, keepText: opts.keepText, refs: opts.refs, extra: opts.extra };
    let batchId;
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const r = await api('POST', '/api/jobs/colorize', { items: chunk, options, want: opts.want, batchId });
      batchId = r.batchId;
      chunk = [];
      size = 0;
    };
    for (const p of pages) {
      const sub = await buildMaskedSubmission({ src: p.dataUrl, masks: { censor: p.masks.censor }, censorFill: opts.censorFill });
      const item = { image: p.dataUrl, width: p.width, height: p.height, title: p.name, ...(sub || {}) };
      const len = [item.image, item.send, item.restore].reduce((a, d) => a + (d?.length || 0), 0);
      if (size + len > 40e6) await flush();
      chunk.push(item);
      size += len;
    }
    await flush();
    toast(`${pages.length}장 채색 작업을 큐에 추가했습니다.`, 'ok');
    if (opts.clearAfter) pages = [];
    renderGrid();
    document.querySelector('[data-tab="jobs"]').click();
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    submitting = false;
    renderActions();
  }
}
