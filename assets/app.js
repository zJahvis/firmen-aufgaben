import { openJson } from './crypto.js';
import { GithubStore, ConflictError, AuthError } from './store.js';
import {
  STATES, emptyBoard, createTask, mergeBoards, sanitizeBoard, visibleTasks,
  touch, normalizeUrl, isSafeLink,
} from './board.js';

const LS_CONFIG = 'fa.config';   // verschlüsseltes Zugangspaket
const LS_SESSION = 'fa.session'; // entschlüsselt, solange „angemeldet bleiben"
const LS_ME = 'fa.me';
const LS_CACHE = 'fa.cache';
const POLL_MS = 10000;

const $ = (sel) => document.querySelector(sel);

const state = {
  board: emptyBoard(),
  sha: null,
  tab: 'offen',
  me: localStorage.getItem(LS_ME) || '',
  store: null,
};

let inFlight = false;
let dirty = false;
let saveTimer = null;
let pollTimer = null;

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

function readSealedConfig() {
  const hash = location.hash || '';
  const m = hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (m) {
    localStorage.setItem(LS_CONFIG, m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  return localStorage.getItem(LS_CONFIG);
}

function boot() {
  const sealed = readSealedConfig();
  if (!sealed) {
    $('#pin-form').classList.add('hidden');
    $('#gate-sub').textContent = 'Kein Zugang hinterlegt';
    $('#gate-setup').classList.remove('hidden');
    return;
  }

  const saved = sessionStorage.getItem(LS_SESSION) || localStorage.getItem(LS_SESSION);
  if (saved) {
    try {
      start(JSON.parse(saved));
      return;
    } catch {
      sessionStorage.removeItem(LS_SESSION);
      localStorage.removeItem(LS_SESSION);
    }
  }

  $('#pin-input').focus();
  $('#pin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pin = $('#pin-input').value.trim();
    const err = $('#pin-error');
    const btn = $('#pin-submit');
    if (!pin) return;
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Prüfe …';
    try {
      const cfg = await openJson(pin, sealed);
      const where = $('#remember').checked ? localStorage : sessionStorage;
      where.setItem(LS_SESSION, JSON.stringify(cfg));
      start(cfg);
    } catch {
      err.textContent = 'PIN stimmt nicht.';
      $('#pin-input').value = '';
      $('#pin-input').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Anmelden';
    }
  });
}

function start(cfg) {
  state.store = new GithubStore(cfg);
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');

  const cached = localStorage.getItem(LS_CACHE);
  if (cached) {
    try { state.board = sanitizeBoard(JSON.parse(cached)); } catch { /* egal */ }
  }

  wireUi();
  updateWhoChip();
  render();

  if (!state.me) askWho();

  pull();
  pollTimer = setInterval(() => { if (!document.hidden) pull(true); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(true); });
  window.addEventListener('online', () => pull(true));
}

/* ------------------------------------------------------------------ */
/* Oberfläche                                                          */
/* ------------------------------------------------------------------ */

function wireUi() {
  $('#new-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = $('#new-title').value.trim();
    if (!title) return;
    const task = createTask({ title, url: $('#new-url').value, author: state.me || 'Unbekannt' });
    state.board = { ...state.board, tasks: [...state.board.tasks, task] };
    $('#new-title').value = '';
    $('#new-url').value = '';
    $('#new-title').focus();
    cacheAndRender();
    scheduleSave();
  });

  $('#tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render();
  });

  $('#logout').addEventListener('click', () => {
    sessionStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_SESSION);
    location.reload();
  });

  $('#who-chip').addEventListener('click', askWho);

  $('#edit-dialog').addEventListener('close', onEditClose);
  $('#who-dialog').addEventListener('close', (ev) => {
    const val = ev.target.returnValue;
    if (val === 'JAHVIS' || val === 'Kollege') {
      state.me = val;
      localStorage.setItem(LS_ME, val);
      updateWhoChip();
    }
  });
}

function askWho() {
  const dlg = $('#who-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

function updateWhoChip() {
  $('#who-chip').textContent = state.me || 'Wer bin ich?';
}

function setSync(kind, text) {
  const el = $('#sync');
  el.classList.remove('busy', 'error');
  if (kind === 'busy') el.classList.add('busy');
  if (kind === 'error') el.classList.add('error');
  $('#sync-text').textContent = text;
}

function showBanner(msg) {
  const b = $('#banner');
  b.textContent = msg;
  b.classList.remove('hidden');
}

function hideBanner() {
  $('#banner').classList.add('hidden');
}

const fmtDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

function relativeDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `heute ${fmtTime.format(d)}` : fmtDate.format(d);
}

function render() {
  for (const status of STATES) {
    const stack = document.querySelector(`[data-stack="${status}"]`);
    const tasks = visibleTasks(state.board, status);
    stack.replaceChildren(
      ...(tasks.length ? tasks.map(renderCard) : [emptyHint(status)])
    );
    for (const el of document.querySelectorAll(`[data-count="${status}"]`)) {
      el.textContent = String(tasks.length);
    }
    const col = document.querySelector(`[data-col="${status}"]`);
    col.classList.toggle('is-hidden-mobile', status !== state.tab);
  }
  for (const btn of document.querySelectorAll('#tabs button[data-tab]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
  }
}

function emptyHint(status) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = {
    offen: 'Nichts offen. 🎉',
    dran: 'Gerade ist nichts in Arbeit.',
    erledigt: 'Noch nichts erledigt.',
  }[status];
  return div;
}

function renderCard(task) {
  const card = document.createElement('article');
  card.className = `card s-${task.status}`;

  const h = document.createElement('h3');
  h.textContent = task.title || '(ohne Titel)';
  card.append(h);

  if (task.url) {
    if (isSafeLink(task.url)) {
      const a = document.createElement('a');
      a.className = 'link';
      a.href = task.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '🔗 ' + task.url.replace(/^https?:\/\//, '');
      card.append(a);
    } else {
      const span = document.createElement('div');
      span.className = 'meta';
      span.textContent = 'Link: ' + task.url;
      card.append(span);
    }
  }

  if (task.note.trim()) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = task.note;
    card.append(note);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const parts = [];
  if (task.author) parts.push('von ' + task.author);
  parts.push('erstellt ' + relativeDate(task.createdAt));
  if (task.status === 'erledigt' && task.doneAt) parts.push('erledigt ' + relativeDate(task.doneAt));
  meta.textContent = parts.join(' · ');
  card.append(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const add = (label, cls, fn, title) => {
    const b = document.createElement('button');
    b.className = `btn btn-sm ${cls}`;
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    actions.append(b);
    return b;
  };

  if (task.status === 'offen') {
    add('▶ Dran', 'btn-primary', () => setStatus(task.id, 'dran'));
    add('✓ Erledigt', '', () => setStatus(task.id, 'erledigt'));
  } else if (task.status === 'dran') {
    add('✓ Erledigt', 'btn-primary', () => setStatus(task.id, 'erledigt'));
    add('← Offen', '', () => setStatus(task.id, 'offen'));
  } else {
    add('↩ Wieder öffnen', '', () => setStatus(task.id, 'dran'));
  }

  add(task.note.trim() ? '✎ Notiz' : '+ Notiz', 'btn-ghost', () => openEdit(task.id, true));
  add('Bearbeiten', 'btn-ghost', () => openEdit(task.id, false));
  add('Löschen', 'btn-ghost btn-danger', () => removeTask(task.id));

  card.append(actions);
  return card;
}

/* ------------------------------------------------------------------ */
/* Aktionen                                                            */
/* ------------------------------------------------------------------ */

function updateTask(id, patch) {
  state.board = {
    ...state.board,
    tasks: state.board.tasks.map((t) => (t.id === id ? touch(t, patch) : t)),
  };
  cacheAndRender();
  scheduleSave();
}

function setStatus(id, status) {
  updateTask(id, { status, doneAt: status === 'erledigt' ? new Date().toISOString() : null });
}

function removeTask(id) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  if (!confirm(`„${task.title}" wirklich löschen?`)) return;
  updateTask(id, { deleted: true });
}

let editingId = null;

function openEdit(id, focusNote) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  editingId = id;
  $('#edit-name').value = task.title;
  $('#edit-url').value = task.url;
  $('#edit-note').value = task.note;
  $('#edit-title').textContent = focusNote ? 'Notiz' : 'Aufgabe bearbeiten';
  const dlg = $('#edit-dialog');
  dlg.showModal();
  const target = focusNote ? $('#edit-note') : $('#edit-name');
  target.focus();
  if (focusNote) target.setSelectionRange(target.value.length, target.value.length);
}

function onEditClose(ev) {
  const dlg = ev.target;
  if (dlg.returnValue !== 'save' || !editingId) { editingId = null; return; }
  const title = $('#edit-name').value.trim();
  if (!title) { editingId = null; return; }
  updateTask(editingId, {
    title,
    url: normalizeUrl($('#edit-url').value),
    note: $('#edit-note').value,
  });
  editingId = null;
}

/* ------------------------------------------------------------------ */
/* Synchronisation                                                     */
/* ------------------------------------------------------------------ */

function cacheAndRender() {
  localStorage.setItem(LS_CACHE, JSON.stringify(state.board));
  render();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSync('busy', 'speichert …');
  saveTimer = setTimeout(flush, 600);
}

async function flush() {
  if (inFlight) { dirty = true; return; }
  inFlight = true;
  setSync('busy', 'speichert …');
  try {
    for (let attempt = 0; ; attempt++) {
      const { board: remote, sha } = await state.store.read();
      const merged = mergeBoards(sanitizeBoard(remote || emptyBoard()), state.board);
      try {
        const res = await state.store.write(merged, sha);
        state.board = merged;
        state.sha = res.sha;
        cacheAndRender();
        setSync('ok', 'gespeichert ' + fmtTime.format(new Date()));
        hideBanner();
        break;
      } catch (err) {
        if (err instanceof ConflictError && attempt < 4) continue;
        throw err;
      }
    }
  } catch (err) {
    setSync('error', 'nicht gespeichert');
    showBanner(
      err instanceof AuthError
        ? 'Zugang abgelehnt: Der GitHub-Token ist ungültig oder abgelaufen. Bitte Einrichtung erneut ausführen.'
        : 'Änderungen konnten nicht gespeichert werden: ' + err.message
    );
  } finally {
    inFlight = false;
    if (dirty) { dirty = false; flush(); }
  }
}

async function pull(silent) {
  if (inFlight) return;
  if (!silent) setSync('busy', 'lädt …');
  try {
    const { board: remote, sha } = await state.store.read();
    if (remote === null) { await flush(); return; }
    const clean = sanitizeBoard(remote);
    const merged = mergeBoards(clean, state.board);
    const changedLocally = JSON.stringify(merged) !== JSON.stringify(clean);
    state.board = merged;
    state.sha = sha;
    cacheAndRender();
    hideBanner();
    if (changedLocally) { scheduleSave(); return; }
    setSync('ok', 'aktuell ' + fmtTime.format(new Date()));
  } catch (err) {
    setSync('error', 'offline');
    if (!silent) {
      showBanner(
        err instanceof AuthError
          ? 'Zugang abgelehnt: Der GitHub-Token ist ungültig oder abgelaufen. Bitte Einrichtung erneut ausführen.'
          : 'Konnte nicht laden: ' + err.message
      );
    }
  }
}

boot();
