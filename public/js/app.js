import { h, append, clear, toast, imageFilesFrom } from './util.js';
import { store, refreshState, refreshCharacters, refreshJobs, connectEvents } from './state.js';
import { initTransform, transformPaste } from './transform.js';
import { initColorize, colorizePaste } from './colorize.js';
import { initCharacters, charactersPaste } from './characters.js';
import { initJobs } from './jobs.js';
import { initSettings } from './settings.js';

const TABS = ['transform', 'colorize', 'characters', 'jobs', 'settings'];

function showTab(name) {
  if (!TABS.includes(name)) name = 'transform';
  store.state.tab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0 });
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) {
    e.preventDefault();
    showTab(a.dataset.goto);
  }
});

function renderQueuePill() {
  const pill = document.getElementById('queue-pill');
  const jobs = [...store.state.jobs.values()];
  const n = (st) => jobs.filter((j) => j.status === st).length;
  const q = store.state.queue || {};
  clear(pill);
  const running = n('running');
  const waiting = n('queued') + n('retrying');
  if (!running && !waiting && !q.paused) {
    pill.append(h('span', {}, '대기 중인 작업 없음'));
    return;
  }
  append(pill,
    h('span', {}, '생성 중 ', h('b', {}, running)),
    h('span', {}, '대기 ', h('b', {}, waiting)),
    q.paused ? h('span', { class: 'warn' }, '⏸ 일시정지') : null,
    q.cooldownUntil ? h('span', { class: 'warn' }, '⏳ 한도 대기') : null,
  );
}

function renderBanner() {
  document.getElementById('cred-banner').classList.toggle('hidden', Boolean(store.state.credentials?.configured));
}

// Ctrl+V: paste images into whatever tab is open
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'file'))) return;
  const files = imageFilesFrom([...(e.clipboardData?.items || [])].map((it) => (it.kind === 'file' ? it.getAsFile() : null)));
  if (!files.length) return;
  e.preventDefault();
  if (charactersPaste(files)) return;
  if (store.state.tab === 'transform') transformPaste(files);
  else if (store.state.tab === 'colorize') colorizePaste(files);
  else toast('이미지는 캐릭터 변환 / 만화 채색 / 캐릭터 라이브러리 탭에서 붙여넣을 수 있습니다.');
});

async function main() {
  store.on('jobs', renderQueuePill);
  store.on('queue', renderQueuePill);
  store.on('credentials', renderBanner);
  try {
    await refreshState();
    await Promise.all([refreshCharacters(), refreshJobs()]);
  } catch (e) {
    toast(e.message, 'error', 10000);
  }
  initTransform(document.getElementById('tab-transform'));
  initColorize(document.getElementById('tab-colorize'));
  initCharacters(document.getElementById('tab-characters'));
  initJobs(document.getElementById('tab-jobs'));
  initSettings(document.getElementById('tab-settings'));
  renderBanner();
  renderQueuePill();
  connectEvents();
  showTab(location.hash.slice(1) || (store.state.credentials?.configured ? 'transform' : 'settings'));
}

main();
