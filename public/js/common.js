// Shared option controls and the character picker popover.
import { h, clear, fileUrl } from './util.js';
import { store, modelOptions } from './state.js';

export function loadOpts(key, defaults) {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(`opts:${key}`) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export function saveOpts(key, opts) {
  try { localStorage.setItem(`opts:${key}`, JSON.stringify(opts)); } catch { /* storage unavailable */ }
}

export function selectField(label, options, value, onChange, { title, cls } = {}) {
  const sel = h('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  return h('label', { class: `field ${cls || ''}`, title }, h('span', {}, label), sel);
}

export function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  const render = (v) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(h('button', {
        type: 'button',
        class: o.value === v ? 'on' : '',
        title: o.title,
        onclick: (e) => {
          e.stopPropagation();
          onChange(o.value);
          render(o.value);
        },
      }, o.label));
    }
  };
  render(value);
  return wrap;
}

// model / size / aspect ratio / variants
export function commonOptionFields(opts, save) {
  const set = (k) => (v) => { opts[k] = v; save(); };
  const models = modelOptions();
  if (!models.some((m) => m.value === opts.model)) opts.model = store.state.settings?.defaultModel || models[0]?.value;
  const ratios = [
    { value: 'auto', label: '원본 비율에 맞춤' },
    { value: 'model', label: '모델에 맡김' },
    ...store.state.aspectRatios.map((r) => ({ value: r, label: r })),
  ];
  return [
    selectField('모델', models, opts.model, set('model')),
    selectField('출력 해상도', [
      { value: '1K', label: '1K' },
      { value: '2K', label: '2K (권장)' },
      { value: '4K', label: '4K' },
    ], opts.imageSize, set('imageSize')),
    selectField('비율', ratios, opts.aspectRatio, set('aspectRatio'), { title: '원본 비율에 맞춤: 원본 이미지와 가장 가까운 지원 비율을 자동 선택' }),
    selectField('이미지당 생성 장수', [1, 2, 3, 4].map((n) => ({ value: n, label: `${n}장` })), opts.want, (v) => { opts.want = Number(v); save(); }),
  ];
}

export function charThumb(c) {
  return c?.images?.[0] ? h('img', { src: fileUrl(c.images[0]), alt: '', loading: 'lazy' }) : h('div', { class: 'ph' });
}

let openPopover = null;

export function closePicker() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
  }
}

document.addEventListener('mousedown', (e) => {
  if (openPopover && !openPopover.contains(e.target)) closePicker();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

/**
 * Character picker popover anchored to an element.
 * onPick(character) is called on click; with multi=true the popover stays open.
 */
export function pickCharacter(anchor, { selected = [], multi = false, onPick }) {
  closePicker();
  const search = h('input', { type: 'search', placeholder: '이름 / 작품 검색' });
  const list = h('div', { class: 'pop-list' });
  const pop = h('div', { class: 'popover' },
    h('div', { class: 'pop-head' }, search,
      h('button', { class: 'btn sm', type: 'button', onclick: () => { closePicker(); window.dispatchEvent(new CustomEvent('new-character', { detail: { onCreated: multi ? null : onPick } })); } }, '+ 새 캐릭터')),
    list);
  const sel = new Set(selected);
  const render = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const chars = store.state.characters
      .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.series || '').toLowerCase().includes(q))
      .sort((a, b) => (a.series || '').localeCompare(b.series || '') || a.name.localeCompare(b.name));
    if (!chars.length) {
      list.append(h('div', { class: 'pop-empty' }, store.state.characters.length ? '검색 결과 없음' : '저장된 캐릭터가 없습니다. 캐릭터 라이브러리에서 먼저 추가하세요.'));
      return;
    }
    for (const c of chars) {
      list.append(h('div', {
        class: `pop-item ${sel.has(c.id) ? 'sel' : ''}`,
        title: `${c.name}${c.series ? ` · ${c.series}` : ''}`,
        onclick: () => {
          onPick(c);
          if (multi) {
            if (sel.has(c.id)) sel.delete(c.id); else sel.add(c.id);
            render();
          } else {
            closePicker();
          }
        },
      }, charThumb(c), h('div', { class: 'nm' }, c.name)));
    }
  };
  search.addEventListener('input', render);
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + 420 > window.innerHeight ? Math.max(8, r.top - 426) : r.bottom + 6;
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 350, r.left))}px`;
  openPopover = pop;
  setTimeout(() => search.focus(), 0);
}
