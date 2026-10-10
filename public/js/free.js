// Tab: free mode — plain Nano Banana with your own prompt and optional images.
import { h, append, clear, api, toast, prepareImage, pickFiles, makeDropzone, imageFilesFrom, fileUrl } from './util.js';
import { store } from './state.js';
import { loadOpts, saveOpts, selectField, commonOptionFields, pickCharacter } from './common.js';

const opts = loadOpts('free', {
  model: null, imageSize: '2K', aspectRatio: 'auto', want: 1, mode: 'together', prompt: '', history: [],
});
const save = () => saveOpts('free', opts);

let root;
let optsEl;
let imagesEl;
let actionsEl;
let promptEl;
let images = [];
let seq = 0;
let submitting = false;

export function initFree(el) {
  root = el;
  optsEl = h('div', { class: 'panel' });
  promptEl = h('textarea', { rows: 7, placeholder: '프롬프트를 자유롭게 입력하세요. 첨부한 이미지는 순서대로 Image 1, Image 2 … 로 전달됩니다.\n예: Image 1의 인물을 Image 2의 화풍으로 다시 그려줘', oninput: (e) => { opts.prompt = e.target.value; save(); } }, opts.prompt);
  promptEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
  imagesEl = h('div', { class: 'page-grid', style: { marginTop: '10px' } });
  const dz = h('div', { class: 'dropzone', style: { padding: '16px' }, onclick: async () => addFiles(await pickFiles()) },
    h('b', {}, '이미지 첨부 (선택)'), ' — 클릭, 드래그 앤 드롭 또는 Ctrl+V. 이미지 없이 프롬프트만으로 생성할 수도 있습니다.');
  makeDropzone(dz, addFiles);
  actionsEl = h('div', { class: 'sticky-actions' });
  root.append(
    optsEl,
    h('div', { class: 'panel' },
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('h3', { style: { margin: 0 } }, '프롬프트'),
        h('span', { class: 'spacer' }),
        historySelect()),
      promptEl,
      h('div', { class: 'help', style: { marginTop: '4px' } }, 'Ctrl+Enter로 바로 시작합니다. 프롬프트는 아무것도 덧붙이지 않고 그대로 전송됩니다 (안전 필터 OFF는 동일하게 적용).')),
    dz, imagesEl, actionsEl);
  renderOptions();
  renderImages();
  store.on('settings', renderOptions);
}

export function freePaste(files) {
  addFiles(files);
  return true;
}

function historySelect() {
  const sel = h('select', { style: { maxWidth: '320px' }, onchange: (e) => {
    if (e.target.value === '') return;
    promptEl.value = opts.history[Number(e.target.value)];
    opts.prompt = promptEl.value;
    save();
    e.target.value = '';
  } }, h('option', { value: '' }, `최근 프롬프트 (${opts.history.length})`),
  opts.history.map((p, i) => h('option', { value: i }, p.replace(/\s+/g, ' ').slice(0, 60))));
  return sel;
}

function renderOptions() {
  clear(optsEl);
  const set = (k) => (v) => { opts[k] = v; save(); renderActions(); };
  optsEl.append(
    h('h3', {}, '자유 모드 옵션'),
    h('div', { class: 'opt-grid' },
      ...commonOptionFields(opts, () => { save(); renderActions(); }),
      selectField('여러 이미지 처리', [
        { value: 'together', label: '한 요청에 모두 함께 보내기' },
        { value: 'separate', label: '이미지마다 따로 (같은 프롬프트)' },
      ], opts.mode, set('mode'), { title: '따로: 이미지 N장 → 작업 N개 (예: 여러 사진에 같은 수정 적용)' })),
  );
}

async function addFiles(files) {
  const maxPx = store.state.settings?.uploadMaxPx || 2048;
  for (const f of imageFilesFrom(files)) {
    if (images.length >= 14 && opts.mode === 'together') {
      toast('한 요청에는 이미지를 최대 14장까지 보낼 수 있습니다.', 'error');
      break;
    }
    try {
      images.push({ id: ++seq, ...(await prepareImage(f, maxPx, { keepAlpha: true })) });
    } catch (err) {
      toast(`${f.name}: ${err.message}`, 'error');
    }
  }
  renderImages();
}

async function addCharacterImage(c) {
  try {
    const blob = await (await fetch(fileUrl(c.images[0]))).blob();
    const file = new File([blob], `${c.name}.${blob.type.split('/')[1] || 'png'}`, { type: blob.type });
    await addFiles([file]);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderImages() {
  clear(imagesEl);
  images.forEach((p, i) => {
    imagesEl.append(h('div', { class: 'card page-item' },
      h('img', { src: p.dataUrl, alt: '', style: { background: '#0b0c0f' } }),
      h('div', { class: 'nm', title: p.name }, `Image ${i + 1} · ${p.name}`),
      h('div', { class: 'row', style: { position: 'absolute', top: '10px', right: '10px', gap: '4px' } },
        i > 0 ? h('button', { class: 'btn sm', title: '앞으로', onclick: () => { [images[i - 1], images[i]] = [images[i], images[i - 1]]; renderImages(); } }, '◀') : null,
        h('button', { class: 'btn sm', onclick: () => { images = images.filter((x) => x !== p); renderImages(); } }, '✕'))));
  });
  const libBtn = h('button', { class: 'btn', onclick: () => pickCharacter(libBtn, { onPick: addCharacterImage }) }, '+ 캐릭터 라이브러리에서');
  imagesEl.append(h('div', { class: 'page-item', style: { display: 'grid', placeItems: 'center' } }, libBtn));
  renderActions();
}

function jobCount() {
  return (opts.mode === 'separate' && images.length > 1 ? images.length : 1) * (opts.want || 1);
}

function renderActions() {
  if (!actionsEl) return;
  clear(actionsEl);
  append(actionsEl,
    h('span', {}, `첨부 이미지 ${images.length}장`),
    h('span', { class: 'spacer' }),
    images.length ? h('button', { class: 'btn danger', onclick: () => { images = []; renderImages(); } }, '이미지 비우기') : null,
    h('button', { class: 'btn primary lg', disabled: submitting, onclick: submit }, submitting ? '전송 중…' : `생성 시작 (${jobCount()}장)`),
  );
}

async function submit() {
  if (submitting) return;
  if (!store.state.credentials.configured) {
    toast('먼저 설정 탭에서 서비스 계정 JSON을 등록하세요.', 'error');
    return;
  }
  const prompt = promptEl.value.trim();
  if (!prompt) {
    toast('프롬프트를 입력하세요.', 'error');
    promptEl.focus();
    return;
  }
  submitting = true;
  renderActions();
  try {
    const items = opts.mode === 'separate' && images.length > 1
      ? images.map((p) => ({ images: [p.dataUrl], width: p.width, height: p.height, title: p.name }))
      : [{ images: images.map((p) => p.dataUrl), width: images[0]?.width, height: images[0]?.height, title: prompt.replace(/\s+/g, ' ').slice(0, 40) }];
    const options = { model: opts.model, imageSize: opts.imageSize, aspectRatio: opts.aspectRatio };
    let batchId;
    let chunk = [];
    let size = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const r = await api('POST', '/api/jobs/free', { items: chunk, prompt, options, want: opts.want, batchId });
      batchId = r.batchId;
      chunk = [];
      size = 0;
    };
    for (const it of items) {
      const len = it.images.reduce((a, d) => a + d.length, 0);
      if (size + len > 40e6) await flush();
      chunk.push(it);
      size += len;
    }
    await flush();
    opts.history = [prompt, ...opts.history.filter((p) => p !== prompt)].slice(0, 20);
    save();
    toast(`${items.length}건 작업을 큐에 추가했습니다.`, 'ok');
    document.querySelector('[data-tab="jobs"]').click();
    // keep prompt & images so the user can tweak and run again; refresh the history list
    const panelRow = promptEl.parentElement.querySelector('.row');
    panelRow.replaceChild(historySelect(), panelRow.lastChild);
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    submitting = false;
    renderActions();
  }
}
