// Tab: Google Cloud service account, models, queue / retry settings.
import { h, clear, api, toast, makeDropzone, pickFiles } from './util.js';
import { store, refreshState } from './state.js';

const MODEL_SUGGESTIONS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
];
const LOCATIONS = ['global', 'us-central1', 'us-east4', 'us-west1', 'europe-west1', 'europe-west4', 'asia-northeast1', 'asia-northeast3', 'asia-southeast1'];

let root;

export function initSettings(el) {
  root = el;
  store.on('settings', render);
  store.on('credentials', render);
  render();
}

async function registerJson(text) {
  try {
    await api('POST', '/api/credentials', { json: text });
    await refreshState();
    toast('서비스 계정을 등록했습니다. "연결 테스트"로 모델 접근을 확인하세요.', 'ok', 6000);
  } catch (e) {
    toast(e.message, 'error', 8000);
  }
}

function render() {
  if (!root) return;
  const s = store.state.settings;
  const cred = store.state.credentials;
  if (!s) return;
  clear(root);
  const draft = JSON.parse(JSON.stringify(s));

  // ---- credentials ----
  const testOut = h('div', { class: 'test-res' });
  const jsonDrop = h('div', { class: 'dropzone', style: { padding: '16px' }, onclick: async () => {
    const [f] = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (f) registerJson(await f.text());
  } }, h('b', {}, '서비스 계정 JSON 키 파일'), ' — 클릭하거나 끌어다 놓기');
  makeDropzone(jsonDrop, async ([f]) => registerJson(await f.text()), { accept: (f) => f.name.endsWith('.json') || f.type === 'application/json' });
  const pasteArea = h('textarea', { rows: 3, placeholder: '또는 JSON 내용을 여기에 붙여넣기 {"type": "service_account", "project_id": ... }' });

  const credPanel = h('div', { class: 'panel' },
    h('h3', {}, 'Google Cloud 서비스 계정'),
    cred.configured
      ? h('div', { class: 'kv' },
        h('div', { class: 'k' }, '상태'), h('div', { style: { color: 'var(--green)' } }, '등록됨'),
        h('div', { class: 'k' }, '프로젝트'), h('div', {}, cred.project_id),
        h('div', { class: 'k' }, '계정'), h('div', { style: { wordBreak: 'break-all' } }, cred.client_email))
      : h('div', { style: { color: 'var(--orange)' } }, '등록된 키가 없습니다.'),
    h('div', { style: { marginTop: '10px' } }, jsonDrop),
    h('div', { style: { marginTop: '8px' } }, pasteArea),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn', onclick: () => pasteArea.value.trim() && registerJson(pasteArea.value) }, '붙여넣은 JSON 등록'),
      h('span', { class: 'spacer' }),
      cred.configured ? h('button', { class: 'btn', onclick: async () => {
        clear(testOut).append('테스트 중…');
        try {
          const { results } = await api('POST', '/api/test', {});
          clear(testOut);
          for (const r of results) {
            testOut.append(h('div', {}, h('span', { class: r.ok ? 'ok' : 'bad' }, r.ok ? '✔ ' : '✖ '), `${r.label} (${r.id}) `, r.ok ? h('span', { class: 'ok' }, '사용 가능') : h('span', { class: 'bad' }, r.error)));
          }
        } catch (e) {
          clear(testOut).append(h('span', { class: 'bad' }, e.message));
        }
      } }, '연결 테스트') : null,
      cred.configured ? h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('등록된 서비스 계정 키를 삭제할까요?')) return;
        await api('DELETE', '/api/credentials');
        await refreshState();
      } }, '키 삭제') : null),
    testOut,
    h('div', { class: 'help', style: { marginTop: '12px' } },
      h('b', {}, '키 만드는 법'),
      h('ol', {},
        h('li', {}, 'Google Cloud Console에서 크레딧이 있는 프로젝트 선택 → "API 및 서비스"에서 ', h('b', {}, 'Vertex AI API'), ' 사용 설정'),
        h('li', {}, 'IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기 → 역할: ', h('b', {}, 'Vertex AI 사용자 (roles/aiplatform.user)')),
        h('li', {}, '만든 서비스 계정 → 키 → 키 추가 → 새 키 만들기 → JSON → 다운로드된 파일을 위에 등록'),
      ),
      '키는 이 PC의 data/credentials.json 에만 저장되며 브라우저로 다시 전송되지 않습니다. 연결 테스트는 토큰 계산(countTokens)만 호출하므로 비용이 들지 않습니다.'),
  );

  // ---- models ----
  const modelRows = h('div');
  const renderModels = () => {
    clear(modelRows);
    draft.models.forEach((m) => {
      modelRows.append(h('div', { class: 'model-row' },
        h('input', { type: 'text', value: m.label, oninput: (e) => { m.label = e.target.value; } }),
        h('input', { type: 'text', value: m.id, list: 'model-ids', oninput: (e) => { m.id = e.target.value.trim(); } }),
        h('label', { class: 'check small' }, h('input', { type: 'radio', name: 'defmodel', checked: draft.defaultModel === m.key, onchange: () => { draft.defaultModel = m.key; } }), '기본')));
    });
  };
  renderModels();
  const modelPanel = h('div', { class: 'panel' },
    h('h3', {}, '모델'),
    h('div', { class: 'model-row small muted' }, h('span', {}, '표시 이름'), h('span', {}, 'Vertex AI 모델 ID'), h('span')),
    modelRows,
    h('datalist', { id: 'model-ids' }, MODEL_SUGGESTIONS.map((id) => h('option', { value: id }))),
    h('label', { class: 'field', style: { marginTop: '8px', maxWidth: '260px' } }, h('span', {}, '리전 (location)'),
      h('input', { type: 'text', value: draft.location, list: 'locations', oninput: (e) => { draft.location = e.target.value.trim(); } }),
      h('datalist', { id: 'locations' }, LOCATIONS.map((l) => h('option', { value: l })))),
    h('div', { class: 'help', style: { marginTop: '8px' } },
      'Nano Banana 2 = gemini-3.1-flash-image, Nano Banana Pro = gemini-3-pro-image (정식 버전 ID). ',
      '연결 테스트에서 404가 나오면 "-preview"가 붙은 ID로 바꾸거나 리전을 global로 두세요. Google이 모델 ID를 바꿔도 여기서 수정하면 됩니다.'),
  );

  // ---- queue ----
  const num = (label, key, min, max, help) => h('label', { class: 'field', title: help },
    h('span', {}, label),
    h('input', { type: 'number', min, max, value: draft[key], oninput: (e) => { draft[key] = Number(e.target.value); } }));
  const queuePanel = h('div', { class: 'panel' },
    h('h3', {}, '안정성 / 속도'),
    h('div', { class: 'opt-grid' },
      num('동시 작업 수', 'concurrency', 1, 16, '동시에 보내는 요청 수'),
      num('분당 최대 요청', 'rpm', 1, 600, '프로젝트 할당량보다 낮게 설정하면 429 오류가 줄어듭니다'),
      num('오류 재시도 횟수', 'maxRetries', 0, 30, 'fetch failed, 429, 5xx, 시간 초과 시 자동 재시도 횟수'),
      num('차단 시 재시도 횟수', 'safetyRetries', 0, 20, '안전 필터 차단/이미지 미생성 시 같은 요청을 다시 보내는 횟수'),
      num('요청 타임아웃(초)', 'requestTimeoutSec', 30, 1800),
      h('label', { class: 'field' }, h('span', {}, '안전 필터 설정'),
        h('select', { onchange: (e) => { draft.safetyThreshold = e.target.value; } },
          h('option', { value: 'OFF', selected: draft.safetyThreshold === 'OFF' }, 'OFF (권장)'),
          h('option', { value: 'BLOCK_NONE', selected: draft.safetyThreshold === 'BLOCK_NONE' }, 'BLOCK_NONE'))),
      num('사진 업로드 최대 px', 'uploadMaxPx', 512, 8192, '실사 사진의 긴 변을 이 크기로 줄여서 전송 (전송 실패 방지)'),
      num('만화 페이지 최대 px', 'colorizeMaxPx', 512, 8192, '만화 페이지는 글자가 뭉개지지 않도록 조금 크게')),
    h('div', { class: 'help', style: { marginTop: '10px' } },
      '• 모든 요청은 안전 필터 4종(혐오/위험/성적/괴롭힘)을 OFF로 보냅니다. 단, Google 쪽 기본 차단(아동 안전, 실존 인물 관련 PROHIBITED_CONTENT, IMAGE_SAFETY 등)은 API로 끌 수 없어서, 차단되면 자동으로 다시 시도합니다(결과가 매번 달라 재시도로 통과되는 경우가 많습니다).', h('br'),
      '• 429(분당 요청 한도)가 오면 큐 전체가 잠시 쉬었다가 자동 재개되고, fetch failed / 5xx / 시간 초과는 지수 백오프로 재시도합니다.'),
  );

  const saveBtn = h('button', { class: 'btn primary lg', onclick: async () => {
    try {
      await api('PUT', '/api/settings', draft);
      await refreshState();
      toast('설정을 저장했습니다.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, '설정 저장');

  root.append(
    h('div', { class: 'settings-grid' }, credPanel, h('div', {}, modelPanel, queuePanel)),
    h('div', { class: 'sticky-actions' }, h('span', { class: 'muted small' }, '모델 / 안정성 설정은 저장 후 새 요청부터 적용됩니다.'), h('span', { class: 'spacer' }), saveBtn),
  );
}
