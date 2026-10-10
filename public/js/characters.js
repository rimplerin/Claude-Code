// Character library: saved reference images that can be picked for every job.
import { h, clear, api, toast, fileUrl, prepareImage, pickFiles, makeDropzone, openModal, imageFilesFrom } from './util.js';
import { store, refreshCharacters } from './state.js';
import { charThumb } from './common.js';

const GENDER_LABEL = { female: '여성', male: '남성', other: '기타' };
const CHAR_MAX_PX = 1536;

let root;
let query = '';
let seriesFilter = '';
let activeEditor = null; // { addFiles } while the editor modal is open

export function initCharacters(el) {
  root = el;
  store.on('characters', render);
  window.addEventListener('new-character', (e) => openEditor(null, e.detail?.onCreated));
  makeDropzone(root, (files) => (activeEditor || openEditor(null)).addFiles(files));
  render();
}

// paste handler hook (Ctrl+V)
export function charactersPaste(files) {
  if (activeEditor) {
    activeEditor.addFiles(files);
    return true;
  }
  if (store.state.tab === 'characters') {
    openEditor(null).addFiles(files);
    return true;
  }
  return false;
}

function render() {
  if (!root) return;
  clear(root);
  const chars = store.state.characters;
  const seriesList = [...new Set(chars.map((c) => c.series).filter(Boolean))].sort();
  const searchInput = h('input', { type: 'search', placeholder: '이름 검색', value: query, oninput: (e) => { query = e.target.value; renderGrid(); } });
  const seriesSel = h('select', { onchange: (e) => { seriesFilter = e.target.value; renderGrid(); } },
    h('option', { value: '' }, '모든 작품'),
    seriesList.map((s) => h('option', { value: s, selected: s === seriesFilter }, s)));

  root.append(
    h('div', { class: 'panel' },
      h('div', { class: 'row' },
        h('h3', { style: { margin: 0 } }, `캐릭터 라이브러리 (${chars.length})`),
        h('span', { class: 'spacer' }),
        searchInput, seriesSel,
        h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '+ 새 캐릭터')),
      h('div', { class: 'help', style: { marginTop: '8px' } },
        '캐릭터마다 참조 이미지를 여러 장 저장할 수 있습니다 (전신 정면 이미지를 첫 번째로 두는 것을 권장). 변환 작업 시 첫 번째 이미지부터 설정한 개수만큼 사용됩니다. ',
        '이미지를 여기로 끌어다 놓거나 Ctrl+V로 붙여 넣으면 새 캐릭터로 바로 추가됩니다.')),
  );
  const grid = h('div', { class: 'char-grid' });
  root.append(grid);

  function renderGrid() {
    clear(grid);
    const q = query.trim().toLowerCase();
    const list = chars
      .filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!seriesFilter || c.series === seriesFilter))
      .sort((a, b) => (a.series || '').localeCompare(b.series || '') || a.name.localeCompare(b.name));
    if (!list.length) {
      grid.append(h('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } },
        chars.length ? '검색 결과가 없습니다.' : '아직 저장된 캐릭터가 없습니다. "+ 새 캐릭터"로 만화 캐릭터 이미지를 등록하세요.'));
      return;
    }
    for (const c of list) {
      grid.append(h('div', { class: 'card char-card', onclick: () => openEditor(c) },
        h('div', { class: 'thumb' }, charThumb(c)),
        h('div', { class: 'meta' },
          h('div', { class: 'nm' }, c.name),
          h('div', { class: 'sub' }, [c.series, GENDER_LABEL[c.gender], `이미지 ${c.images.length}장`].filter(Boolean).join(' · ')))));
    }
  }
  renderGrid();
}

function openEditor(existing, onCreated) {
  let character = existing ? { ...existing, images: [...existing.images] } : null;
  const pending = []; // new character: images waiting for first save
  const form = {
    name: existing?.name || '',
    series: existing?.series || '',
    gender: existing?.gender || 'female',
    description: existing?.description || '',
  };
  const seriesList = [...new Set(store.state.characters.map((c) => c.series).filter(Boolean))];
  const imgGrid = h('div', { class: 'ref-grid' });
  const dz = h('div', { class: 'dropzone', style: { padding: '14px' }, onclick: async () => addFiles(await pickFiles()) },
    h('b', {}, '이미지 추가'), ' — 클릭, 드래그 앤 드롭 또는 Ctrl+V');
  makeDropzone(dz, (files) => addFiles(files));

  let busy = false;
  async function addFiles(files) {
    files = imageFilesFrom(files);
    if (!files.length) return;
    try {
      const prepared = [];
      for (const f of files) prepared.push(await prepareImage(f, CHAR_MAX_PX, { keepAlpha: true }));
      if (!form.name && !character && files[0]?.name) {
        form.name = files[0].name.replace(/\.[^.]+$/, '');
        nameInput.value = form.name;
      }
      if (character) {
        const { character: c } = await api('POST', `/api/characters/${character.id}/images`, { images: prepared.map((p) => p.dataUrl) });
        character = c;
        await refreshCharacters();
      } else {
        pending.push(...prepared.map((p) => p.dataUrl));
      }
      renderImages();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function saveOrder(images) {
    const { character: c } = await api('PUT', `/api/characters/${character.id}`, { images });
    character = c;
    await refreshCharacters();
    renderImages();
  }

  function renderImages() {
    clear(imgGrid);
    const items = character ? character.images.map((rel) => ({ src: fileUrl(rel), rel })) : pending.map((d, i) => ({ src: d, idx: i }));
    if (!items.length) imgGrid.append(h('div', { class: 'muted small', style: { gridColumn: '1 / -1' } }, '참조 이미지가 없습니다.'));
    items.forEach((it, i) => {
      imgGrid.append(h('div', { class: 'ref-item' },
        h('img', { src: it.src }),
        i === 0 ? h('div', { class: 'first' }, '대표') : null,
        h('div', { class: 'acts' },
          i > 0 ? h('button', { class: 'btn sm', type: 'button', onclick: () => {
            if (character) {
              const imgs = [...character.images];
              imgs.unshift(imgs.splice(i, 1)[0]);
              saveOrder(imgs).catch((e) => toast(e.message, 'error'));
            } else {
              pending.unshift(pending.splice(i, 1)[0]);
              renderImages();
            }
          } }, '대표로') : h('span'),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => {
            if (character) {
              if (!confirm('이 이미지를 삭제할까요?')) return;
              saveOrder(character.images.filter((r) => r !== it.rel)).catch((e) => toast(e.message, 'error'));
            } else {
              pending.splice(i, 1);
              renderImages();
            }
          } }, '삭제'))));
    });
  }

  const nameInput = h('input', { type: 'text', value: form.name, placeholder: '예: 아스나', oninput: (e) => { form.name = e.target.value; } });
  const content = h('div', {},
    h('h2', {}, existing ? '캐릭터 편집' : '새 캐릭터'),
    h('div', { class: 'opt-grid' },
      h('label', { class: 'field' }, h('span', {}, '이름'), nameInput),
      h('label', { class: 'field' }, h('span', {}, '작품 / 그룹'),
        h('input', { type: 'text', value: form.series, list: 'series-list', placeholder: '선택 사항', oninput: (e) => { form.series = e.target.value; } }),
        h('datalist', { id: 'series-list' }, seriesList.map((s) => h('option', { value: s })))),
      h('label', { class: 'field' }, h('span', {}, '성별'),
        h('select', { onchange: (e) => { form.gender = e.target.value; } },
          Object.entries(GENDER_LABEL).map(([v, l]) => h('option', { value: v, selected: v === form.gender }, l)))),
      h('label', { class: 'field wide' }, h('span', {}, '특징 메모 (선택 — 프롬프트에 함께 전달됩니다, 영어/한국어 모두 가능)'),
        h('textarea', { rows: 2, placeholder: '예: 키 160cm, 슬림한 체형, 오른쪽 눈 밑 점, 가방은 들지 않음', oninput: (e) => { form.description = e.target.value; } }, form.description))),
    h('h3', { style: { margin: '16px 0 8px', fontSize: '14px' } }, '참조 이미지'),
    imgGrid,
    h('div', { style: { marginTop: '8px' } }, dz),
    h('div', { class: 'foot' },
      existing ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
        if (!confirm(`"${existing.name}" 캐릭터를 삭제할까요? 참조 이미지도 함께 삭제됩니다.`)) return;
        try {
          await api('DELETE', `/api/characters/${existing.id}`);
          await refreshCharacters();
          m.close();
          toast('삭제했습니다.');
        } catch (e) { toast(e.message, 'error'); }
      } }, '캐릭터 삭제') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, '닫기'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (busy) return;
        busy = true;
        try {
          let created = null;
          if (character) {
            await api('PUT', `/api/characters/${character.id}`, form);
          } else {
            if (!pending.length) throw new Error('참조 이미지를 1장 이상 추가하세요.');
            created = (await api('POST', '/api/characters', { ...form, images: pending })).character;
          }
          await refreshCharacters();
          if (created) onCreated?.(created);
          toast('저장했습니다.', 'ok');
          m.close();
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          busy = false;
        }
      } }, '저장')),
  );
  const m = openModal(content, { onClose: () => { activeEditor = null; } });
  activeEditor = { addFiles };
  renderImages();
  setTimeout(() => nameInput.focus(), 0);
  return activeEditor;
}
