// Tab: job queue / results, plus the full-screen result viewer.
import { h, append, clear, api, toast, fileUrl, fmtTime, download } from './util.js';
import { store } from './state.js';

const STATUS_LABEL = { queued: '대기', running: '생성 중', retrying: '재시도 대기', done: '완료', failed: '실패', canceled: '취소됨' };
const TYPE_LABEL = { transform: '캐릭터 변환', colorize: '만화 채색' };
const KIND_LABEL = {
  network: '네트워크', timeout: '시간 초과', rate_limit: '요청 한도', server: '서버 오류', auth: '권한/인증',
  not_found: '모델 없음', bad_request: '요청 오류', blocked: '차단', no_image: '이미지 없음', config: '설정', unknown: '오류',
};
const ACTIVE = new Set(['queued', 'running', 'retrying']);
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

let root;
let listEl;
let barEl;
let filter = 'all';
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedBatches') || '[]'));
const openLogs = new Set();
const batchEls = new Map();
const jobEls = new Map();

export function initJobs(el) {
  root = el;
  barEl = h('div', { class: 'filter-bar' });
  listEl = h('div');
  root.append(barEl, listEl);
  store.on('jobs', render);
  store.on('queue', renderBar);
  setInterval(tickCountdowns, 1000);
  render();
}

function stem(name) {
  return (name || 'image').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
}

function resultFilename(job, idx) {
  const ext = job.results[idx].file.split('.').pop();
  return `${stem(job.title)}_${job.type === 'colorize' ? 'color' : '2d'}${job.results.length > 1 ? `_v${idx + 1}` : ''}.${ext}`;
}

function counts(jobs) {
  const c = { total: jobs.length, done: 0, failed: 0, active: 0, running: 0, canceled: 0 };
  for (const j of jobs) {
    if (j.status === 'done') c.done++;
    else if (j.status === 'failed') c.failed++;
    else if (j.status === 'canceled') c.canceled++;
    if (ACTIVE.has(j.status)) c.active++;
    if (j.status === 'running') c.running++;
  }
  return c;
}

function renderBar() {
  if (!barEl) return;
  const q = store.state.queue || {};
  const all = [...store.state.jobs.values()];
  const c = counts(all);
  clear(barEl);
  const f = (key, label) => h('button', { class: `btn sm ${filter === key ? 'primary' : ''}`, onclick: () => { filter = key; renderBar(); render(); } }, label);
  append(barEl,
    f('all', `전체 ${c.total}`), f('active', `진행 중 ${c.active}`), f('done', `완료 ${c.done}`), f('failed', `실패 ${c.failed}`),
    h('span', { class: 'spacer' }),
    q.cooldownUntil ? h('span', { class: 'small', style: { color: 'var(--orange)' } }, `⏸ ${q.cooldownReason} (${Math.max(0, Math.ceil((q.cooldownUntil - Date.now()) / 1000))}초) `,
      h('button', { class: 'btn sm', onclick: () => api('POST', '/api/queue', { clearCooldown: true }) }, '지금 재개')) : null,
    h('span', { class: 'small muted' }, `최근 1분 요청 ${q.recentRequests ?? 0}회`),
    h('button', { class: 'btn sm', onclick: () => api('POST', '/api/queue', { paused: !q.paused }).catch((e) => toast(e.message, 'error')) }, q.paused ? '▶ 큐 재개' : '⏸ 큐 일시정지'),
    c.failed ? h('button', { class: 'btn sm', onclick: () => bulk('retry', all.filter((j) => j.status === 'failed')) }, `실패 ${c.failed}건 모두 재시도`) : null,
    h('button', { class: 'btn sm danger', onclick: () => {
      const targets = all.filter((j) => !ACTIVE.has(j.status));
      if (!targets.length) return toast('정리할 작업이 없습니다.');
      if (confirm(`완료/실패/취소된 작업 ${targets.length}건과 결과 이미지를 삭제할까요?\n(먼저 ZIP으로 받아두세요)`)) bulk('delete', targets);
    } }, '끝난 작업 정리'),
  );
}

async function bulk(action, jobs) {
  try {
    const r = await api('POST', '/api/jobs/bulk', { action, ids: jobs.map((j) => j.id) });
    if (action !== 'delete') toast(`${r.count}건 처리했습니다.`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function jobSig(j) {
  return [j.status, j.results.length, j.want, j.error, j.attempts, j.nextAttemptAt, (j.log || []).length, openLogs.has(j.id)].join('|');
}

function matchesFilter(j) {
  if (filter === 'active') return ACTIVE.has(j.status);
  if (filter === 'done') return j.status === 'done';
  if (filter === 'failed') return j.status === 'failed' || j.status === 'canceled';
  return true;
}

function render() {
  if (!listEl) return;
  renderBar();
  const all = [...store.state.jobs.values()];
  const badge = document.getElementById('jobs-badge');
  const failed = all.filter((j) => j.status === 'failed').length;
  badge.textContent = failed ? String(failed) : '';

  const byBatch = new Map();
  for (const j of all) {
    if (!byBatch.has(j.batchId)) byBatch.set(j.batchId, []);
    byBatch.get(j.batchId).push(j);
  }
  const batches = [...byBatch.entries()]
    .map(([id, jobs]) => ({ id, jobs: jobs.sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => b.jobs[0].createdAt - a.jobs[0].createdAt);

  const seenBatches = new Set();
  const seenJobs = new Set();
  const frag = [];
  for (const b of batches) {
    const visible = b.jobs.filter(matchesFilter);
    if (!visible.length) continue;
    seenBatches.add(b.id);
    let be = batchEls.get(b.id);
    if (!be) {
      const head = h('div', { class: 'batch-head' });
      const body = h('div', { class: 'batch-body' });
      be = { el: h('div', { class: 'card batch' }, head, body), head, body };
      batchEls.set(b.id, be);
    }
    be.el.classList.toggle('collapsed', collapsed.has(b.id));
    renderBatchHead(be.head, b);
    for (const j of visible) {
      seenJobs.add(j.id);
      let je = jobEls.get(j.id);
      const sig = jobSig(j);
      if (!je || je.sig !== sig) {
        const el = buildJob(j);
        if (je) je.el.replaceWith(el);
        je = { el, sig };
        jobEls.set(j.id, je);
      }
      be.body.append(je.el); // append keeps order (moves existing nodes)
    }
    frag.push(be.el);
  }
  for (const [id, be] of batchEls) if (!seenBatches.has(id)) { be.el.remove(); batchEls.delete(id); }
  for (const [id, je] of jobEls) if (!seenJobs.has(id)) { je.el.remove(); jobEls.delete(id); }
  for (const el of frag) listEl.append(el);
  if (!frag.length) {
    if (!listEl.querySelector('.empty-state')) listEl.append(h('div', { class: 'empty-state' }, all.length ? '해당하는 작업이 없습니다.' : '아직 작업이 없습니다. 캐릭터 변환 또는 만화 채색 탭에서 작업을 시작하세요.'));
  } else {
    listEl.querySelector('.empty-state')?.remove();
  }
}

function renderBatchHead(head, b) {
  clear(head);
  const c = counts(b.jobs);
  const first = b.jobs[0];
  const pct = c.total ? Math.round(((c.done + c.failed + c.canceled) / c.total) * 100) : 0;
  const modelKey = first.options?.model;
  const model = store.state.settings?.models.find((m) => m.key === modelKey);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  head.onclick = () => {
    if (collapsed.has(b.id)) collapsed.delete(b.id); else collapsed.add(b.id);
    try { localStorage.setItem('collapsedBatches', JSON.stringify([...collapsed].slice(-200))); } catch { /* ignore */ }
    render();
  };
  append(head,
    h('span', {}, collapsed.has(b.id) ? '▸' : '▾'),
    h('span', { class: 'ttl' }, `${TYPE_LABEL[first.type] || first.type} · ${fmtTime(first.createdAt)}`),
    h('span', { class: 'small muted' }, `${model?.label || modelKey || ''} · ${first.options?.imageSize || ''}`),
    h('span', { class: 'small' }, `완료 ${c.done}/${c.total}`, c.failed ? h('span', { style: { color: 'var(--red)' } }, ` · 실패 ${c.failed}`) : null, c.running ? ` · 생성 중 ${c.running}` : ''),
    h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })),
    h('span', { class: 'spacer' }),
    b.jobs.some((j) => j.results.length) ? h('button', { class: 'btn sm', onclick: stop(() => download(`/api/download.zip?batch=${encodeURIComponent(b.id)}`)) }, 'ZIP 다운로드') : null,
    b.jobs.some((j) => j.results.length) ? h('button', { class: 'btn sm', title: '결과를 순서대로 크게 보기', onclick: stop(() => openViewerFor(b.id, null)) }, '크게 보기') : null,
    c.failed ? h('button', { class: 'btn sm', onclick: stop(() => bulk('retry', b.jobs.filter((j) => j.status === 'failed'))) }, '실패 재시도') : null,
    c.active ? h('button', { class: 'btn sm', onclick: stop(() => bulk('cancel', b.jobs)) }, '모두 취소') : null,
    h('button', { class: 'btn sm danger', onclick: stop(() => { if (confirm(`이 묶음의 작업 ${c.total}건과 결과 이미지를 삭제할까요?`)) bulk('delete', b.jobs); }) }, '삭제'),
  );
}

function countdownText(j) {
  const s = Math.max(0, Math.ceil(((j.nextAttemptAt || 0) - Date.now()) / 1000));
  return s > 0 ? `${s}초 후 재시도` : '곧 재시도';
}

function tickCountdowns() {
  if (!root?.classList.contains('active')) return;
  for (const el of root.querySelectorAll('[data-countdown]')) {
    const j = store.state.jobs.get(el.dataset.countdown);
    if (j) el.textContent = countdownText(j);
  }
  const q = store.state.queue;
  if (q?.cooldownUntil) renderBar();
}

function buildJob(j) {
  const last = j.results.length - 1;
  const act = (label, fn, cls = '') => h('button', { class: `btn sm ${cls}`, onclick: async () => { try { await fn(); } catch (e) { toast(e.message, 'error'); } } }, label);

  let resultCell;
  if (last >= 0) {
    resultCell = h('div', { class: 'cell', onclick: () => openViewerFor(j.batchId, { jobId: j.id, idx: last }) },
      h('img', { src: fileUrl(j.results[last].file), loading: 'lazy' }),
      h('span', { class: 'cap' }, `결과 ${last + 1}/${Math.max(j.want, j.results.length)}`),
      j.results.length > 1 ? h('span', { class: 'more' }, `${j.results.length}장`) : null);
    if (ACTIVE.has(j.status)) resultCell.append(h('div', { class: 'cap', style: { top: 'auto', bottom: '4px' } }, j.status === 'running' ? '추가 생성 중…' : STATUS_LABEL[j.status]));
  } else {
    let ph;
    if (j.status === 'running') ph = [h('div', { class: 'spinner' }), '생성 중…'];
    else if (j.status === 'retrying') ph = ['⏳', h('div', { dataset: { countdown: j.id } }, countdownText(j))];
    else if (j.status === 'queued') ph = ['대기 중'];
    else if (j.status === 'failed') ph = ['⚠ 실패'];
    else ph = [STATUS_LABEL[j.status] || j.status];
    resultCell = h('div', { class: 'cell' }, h('div', { class: 'status-ph' }, ...ph));
  }

  const mapping = j.type === 'transform'
    ? h('div', { class: 'mapping' }, j.subjects.map((s, i) => `${CIRCLED[i] || i + 1} ${s.characterName} (${s.outfit === 'source' ? '실사 옷' : '캐릭터 옷'})`).join('   '))
    : null;

  const showErr = j.error && (j.status === 'failed' || j.status === 'retrying');
  return h('div', { class: `job ${j.status}` },
    h('div', { class: 'row' },
      h('span', { class: `st ${j.status}` }, STATUS_LABEL[j.status] || j.status),
      h('span', { class: 'small', style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }, title: j.title }, j.title || j.id),
      j.attempts > 1 ? h('span', { class: 'small muted', title: '총 요청 횟수' }, `시도 ${j.attempts}`) : null),
    h('div', { class: 'imgs' },
      h('div', { class: 'cell', onclick: () => openViewerFor(j.batchId, { jobId: j.id, idx: Math.max(0, last), mode: 'source' }) },
        h('img', { src: fileUrl(j.sourceFile), loading: 'lazy' }), h('span', { class: 'cap' }, '원본')),
      resultCell),
    mapping,
    showErr ? h('div', { class: 'err' }, h('b', {}, `[${KIND_LABEL[j.errorKind] || '오류'}] `), j.error) : null,
    h('div', { class: 'acts' },
      last >= 0 ? act('다운로드', () => download(fileUrl(j.results[last].file), resultFilename(j, last))) : null,
      j.status === 'done' ? act('+1장 더', () => api('POST', `/api/jobs/${j.id}/regenerate`, { count: 1 })) : null,
      j.status === 'failed' || j.status === 'canceled' ? act('재시도', () => api('POST', `/api/jobs/${j.id}/retry`), 'primary') : null,
      ACTIVE.has(j.status) ? act('취소', () => api('POST', `/api/jobs/${j.id}/cancel`)) : null,
      act(openLogs.has(j.id) ? '로그 닫기' : '로그', () => { if (openLogs.has(j.id)) openLogs.delete(j.id); else openLogs.add(j.id); render(); }),
      act('삭제', async () => { if (confirm('이 작업과 결과 이미지를 삭제할까요?')) await api('POST', '/api/jobs/bulk', { action: 'delete', ids: [j.id] }); }, 'danger')),
    openLogs.has(j.id)
      ? h('div', { class: 'log' }, (j.log || []).map((l) => h('div', { class: l.level }, `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`)))
      : null,
  );
}

// ---------------- viewer ----------------
function openViewerFor(batchId, start) {
  const batchJobs = [...store.state.jobs.values()].filter((x) => x.batchId === batchId).sort((a, b) => a.createdAt - b.createdAt);
  const entries = [];
  for (const j of batchJobs) j.results.forEach((r, idx) => entries.push({ jobId: j.id, idx }));
  if (start?.mode === 'source' && !entries.some((e) => e.jobId === start.jobId)) {
    // job without results: show only its source
    const j = store.state.jobs.get(start.jobId);
    return openSourceOnly(j);
  }
  if (!entries.length) return;
  let pos = start ? Math.max(0, entries.findIndex((e) => e.jobId === start.jobId && e.idx === start.idx)) : 0;
  let mode = start?.mode === 'source' ? 'side' : (localStorage.getItem('viewerMode') || 'result');

  const stage = h('div', { class: 'vstage' });
  const bar = h('div', { class: 'vbar' });
  const thumbs = h('div', { class: 'thumbs' });
  const viewer = h('div', { class: 'viewer' }, bar, stage, thumbs);

  const current = () => {
    const e = entries[pos];
    const j = store.state.jobs.get(e.jobId);
    return j && j.results[e.idx] ? { j, r: j.results[e.idx], idx: e.idx } : null;
  };

  function draw() {
    const cur = current();
    if (!cur) return close();
    const { j, r, idx } = cur;
    clear(bar);
    const m = (key, label) => h('button', { class: `btn sm ${mode === key ? 'primary' : ''}`, onclick: () => { mode = key; localStorage.setItem('viewerMode', key); draw(); } }, label);
    append(bar,
      h('b', {}, `${pos + 1} / ${entries.length}`),
      h('span', { class: 'small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40vw' } }, `${j.title || ''} — 결과 ${idx + 1}`),
      h('span', { class: 'small muted' }, `${r.model || ''} · ${r.aspectRatio || ''}`),
      h('span', { class: 'spacer' }),
      m('result', '결과 (1)'), m('slider', '비교 슬라이더 (2)'), m('side', '나란히 (3)'),
      h('button', { class: 'btn sm', onclick: () => download(fileUrl(r.file), resultFilename(j, idx)) }, '다운로드'),
      j.status === 'done' ? h('button', { class: 'btn sm', onclick: () => api('POST', `/api/jobs/${j.id}/regenerate`, { count: 1 }).then(() => toast('추가 생성을 큐에 넣었습니다.')) }, '+1장 더') : null,
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (!confirm('이 결과 이미지를 삭제할까요?')) return;
        await api('POST', `/api/jobs/${j.id}/delete-result`, { file: r.file });
        entries.splice(pos, 1);
        for (const e of entries) if (e.jobId === j.id && e.idx > idx) e.idx--;
        if (!entries.length) return close();
        pos = Math.min(pos, entries.length - 1);
        setTimeout(draw, 50);
      } }, '결과 삭제'),
      h('button', { class: 'btn sm', onclick: close }, '닫기 (Esc)'),
    );

    clear(stage);
    const src = fileUrl(j.sourceFile);
    const out = fileUrl(r.file);
    if (mode === 'side') {
      stage.append(h('div', { class: 'side' }, h('div', {}, h('img', { src })), h('div', {}, h('img', { src: out }))));
    } else if (mode === 'slider') {
      const over = h('div', { class: 'over' }, h('img', { src }));
      const handle = h('div', { class: 'handle' });
      const box = h('div', { class: 'compare' }, h('img', { src: out }), over, handle);
      const setX = (x) => {
        over.style.clipPath = `inset(0 ${100 - x}% 0 0)`;
        handle.style.left = `${x}%`;
      };
      setX(50);
      const move = (e) => {
        const rect = box.getBoundingClientRect();
        setX(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
      };
      box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); move(e); box.onpointermove = move; });
      box.addEventListener('pointerup', () => { box.onpointermove = null; });
      stage.append(box);
    } else {
      stage.append(h('img', { src: out }));
    }
    if (entries.length > 1) {
      append(stage,
        h('button', { class: 'nav prev', onclick: () => go(-1) }, '‹'),
        h('button', { class: 'nav next', onclick: () => go(1) }, '›'));
    }
    clear(thumbs);
    entries.forEach((e, i) => {
      const jj = store.state.jobs.get(e.jobId);
      const rr = jj?.results[e.idx];
      if (!rr) return;
      const t = h('img', { src: fileUrl(rr.file), class: i === pos ? 'on' : '', loading: 'lazy', onclick: () => { pos = i; draw(); } });
      thumbs.append(t);
      if (i === pos) setTimeout(() => t.scrollIntoView({ block: 'nearest', inline: 'center' }), 0);
    });
  }

  const go = (d) => { pos = (pos + d + entries.length) % entries.length; draw(); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === '1') { mode = 'result'; draw(); }
    else if (e.key === '2') { mode = 'slider'; draw(); }
    else if (e.key === '3') { mode = 'side'; draw(); }
  };
  function close() {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  document.body.append(viewer);
  draw();
}

function openSourceOnly(j) {
  if (!j) return;
  const viewer = h('div', { class: 'viewer', onclick: () => close() },
    h('div', { class: 'vbar' }, h('b', {}, j.title || '원본'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm' }, '닫기 (Esc)')),
    h('div', { class: 'vstage' }, h('img', { src: fileUrl(j.sourceFile) })));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    viewer.remove();
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  document.body.append(viewer);
}
