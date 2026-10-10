import { api, createStore, toast } from './util.js';

export const store = createStore({
  settings: null,
  credentials: { configured: false },
  queue: {},
  aspectRatios: [],
  characters: [],
  jobs: new Map(),
  tab: 'transform',
});

export async function refreshState() {
  const s = await api('GET', '/api/state');
  store.set('aspectRatios', s.aspectRatios);
  store.set('settings', s.settings);
  store.set('credentials', s.credentials);
  store.set('queue', s.queue);
}

export async function refreshCharacters() {
  const { characters } = await api('GET', '/api/characters');
  store.set('characters', characters);
}

export function characterById(id) {
  return store.state.characters.find((c) => c.id === id) || null;
}

export async function refreshJobs() {
  const { jobs, queue } = await api('GET', '/api/jobs');
  store.set('jobs', new Map(jobs.map((j) => [j.id, j])));
  store.set('queue', queue);
}

let source = null;
let jobsEmitTimer = null;

function emitJobsSoon() {
  if (jobsEmitTimer) return;
  jobsEmitTimer = setTimeout(() => {
    jobsEmitTimer = null;
    store.emit('jobs');
  }, 120);
}

// Server-sent events keep job state live; EventSource reconnects by itself.
export function connectEvents() {
  if (source) source.close();
  source = new EventSource('/api/events');
  let first = true;
  source.addEventListener('open', () => {
    if (!first) refreshJobs().catch(() => {});
    first = false;
  });
  source.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    const prev = store.state.jobs.get(job.id);
    store.state.jobs.set(job.id, job);
    if (prev && prev.status !== job.status) {
      if (job.status === 'failed') toast(`실패: ${job.title || job.id} — ${job.error || ''}`, 'error', 6000);
    }
    emitJobsSoon();
  });
  source.addEventListener('remove', (e) => {
    store.state.jobs.delete(JSON.parse(e.data).id);
    emitJobsSoon();
  });
  source.addEventListener('state', (e) => store.set('queue', JSON.parse(e.data)));
}

export function modelOptions() {
  const s = store.state.settings;
  return (s?.models || []).map((m) => ({ value: m.key, label: `${m.label} (${m.id})` }));
}
