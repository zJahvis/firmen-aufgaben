import { openJson } from './crypto.js';
import { GithubStore, ConflictError, AuthError } from './store.js';
import {
  STATES, STATE_LABELS, emptyBoard, createTask, mergeBoards, sanitizeBoard,
  selectTasks, archivedTasks, dueOverview, unseenActivity, activityText, activityFeed,
  touch, addComment, makeActivity, normalizeUrl, isSafeLink, linkLabel,
  PRIORITY_LABELS, DEFAULT_PRIORITY, normalizePriority,
  ASSIGNEE_LABELS, ASSIGNEE_CHOICES, DEFAULT_ASSIGNEE, normalizeAssignee,
  SORT_MODES, DEFAULT_SORT, todayIso, dueLabel, dueState, formatDate,
  orderForIndex,
} from './board.js';

const LS_CONFIG = 'fa.config';   // verschlüsseltes Zugangspaket
const LS_SESSION = 'fa.session'; // entschlüsselt, solange „angemeldet bleiben"
const LS_ME = 'fa.me';
const LS_CACHE = 'fa.cache';
const LS_SORT = 'fa.sort';
const LS_PRIO = 'fa.prio';
const LS_HIDEDONE = 'fa.hidedone';
const LS_SEEN = 'fa.seen';
const LS_NOTIFY = 'fa.notify';
const LS_ACTIVITY_OPEN = 'fa.activity';
const POLL_MS = 10000;

const $ = (sel) => document.querySelector(sel);

/** Liest bzw. setzt eine Auswahlgruppe (Wichtigkeit, Zuständigkeit, Sortierung). */
function readChoice(name, fallback) {
  const picked = document.querySelector(`input[name="${name}"]:checked`);
  return picked ? picked.value : fallback;
}

function setChoice(name, value) {
  const target = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (target) target.checked = true;
}

const state = {
  board: emptyBoard(),
  sha: null,
  tab: 'offen',
  sort: SORT_MODES.includes(localStorage.getItem(LS_SORT)) ? localStorage.getItem(LS_SORT) : DEFAULT_SORT,
  filterPrio: ['alle', ...Object.keys(PRIORITY_LABELS)].includes(localStorage.getItem(LS_PRIO))
    ? localStorage.getItem(LS_PRIO) : 'alle',
  query: '',
  hideDone: localStorage.getItem(LS_HIDEDONE) === '1',
  showArchive: false,
  me: localStorage.getItem(LS_ME) || '',
  seenAt: localStorage.getItem(LS_SEEN) || '',
  notify: localStorage.getItem(LS_NOTIFY) === '1',
  today: todayIso(),
  store: null,
  rendered: { offen: [], dran: [], erledigt: [] },
};

let inFlight = false;
let dirty = false;
let saveTimer = null;
let pollTimer = null;
const notified = new Set();
let firstSync = true;

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
  updateBell();
  setChoice('sort', state.sort);
  setChoice('filter-prio', state.filterPrio);
  $('#hide-done').checked = state.hideDone;
  render();

  if (!state.me) askWho();

  pull();
  pollTimer = setInterval(() => {
    state.today = todayIso();
    if (!document.hidden) pull(true);
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(true); });
  window.addEventListener('online', () => pull(true));
}

/* ------------------------------------------------------------------ */
/* Oberfläche verdrahten                                               */
/* ------------------------------------------------------------------ */

function wireUi() {
  $('#new-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const title = $('#new-title').value.trim();
    if (!title) return;
    const task = createTask({
      title,
      url: $('#new-url').value,
      url2: $('#new-url2').value,
      due: $('#new-due').value,
      author: state.me || 'Unbekannt',
      assignee: readChoice('new-assignee', DEFAULT_ASSIGNEE),
      priority: readChoice('new-prio', DEFAULT_PRIORITY),
    });
    state.board = {
      ...state.board,
      tasks: [...state.board.tasks, task],
      activity: [makeActivity('angelegt', task, state.me), ...state.board.activity],
    };
    $('#new-title').value = '';
    $('#new-url').value = '';
    $('#new-url2').value = '';
    $('#new-due').value = '';
    setChoice('new-prio', DEFAULT_PRIORITY);
    setChoice('new-assignee', DEFAULT_ASSIGNEE);
    $('#new-title').focus();
    cacheAndRender();
    scheduleSave();
  });

  $('#search').addEventListener('input', (ev) => {
    state.query = ev.target.value;
    $('#search-clear').classList.toggle('hidden', !state.query);
    render();
  });
  $('#search-clear').addEventListener('click', () => {
    state.query = '';
    $('#search').value = '';
    $('#search-clear').classList.add('hidden');
    render();
  });

  $('#filter-row').addEventListener('change', (ev) => {
    state.filterPrio = ev.target.value;
    localStorage.setItem(LS_PRIO, state.filterPrio);
    render();
  });

  $('#sort-row').addEventListener('change', (ev) => {
    const mode = ev.target.value;
    if (!SORT_MODES.includes(mode)) return;
    state.sort = mode;
    localStorage.setItem(LS_SORT, mode);
    render();
  });

  $('#hide-done').addEventListener('change', (ev) => {
    state.hideDone = ev.target.checked;
    localStorage.setItem(LS_HIDEDONE, state.hideDone ? '1' : '0');
    if (state.hideDone && state.tab === 'erledigt') state.tab = 'offen';
    render();
  });

  $('#archive-toggle').addEventListener('click', () => {
    state.showArchive = !state.showArchive;
    render();
  });

  $('#tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render();
  });

  $('#activity-details').open = localStorage.getItem(LS_ACTIVITY_OPEN) !== '0';
  $('#activity-details').addEventListener('toggle', (ev) => {
    localStorage.setItem(LS_ACTIVITY_OPEN, ev.target.open ? '1' : '0');
  });

  $('#overview-set-due').addEventListener('click', () => {
    $('#new-more').open = true;
    $('#new-due').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#new-title').focus();
  });

  $('#news-chip').addEventListener('click', markSeen);
  $('#bell').addEventListener('click', toggleBell);

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
      render();
    }
  });

  $('#comments-close').addEventListener('click', () => $('#comments-dialog').close());
  $('#comment-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('#comment-text').value.trim();
    if (!text || !commentingId) return;
    mutateTask(commentingId, (t) => addComment(t, { author: state.me || 'Unbekannt', text }), 'kommentiert');
    $('#comment-text').value = '';
    renderThread(commentingId);
  });
}

function askWho() {
  const dlg = $('#who-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

function updateWhoChip() {
  const chip = $('#who-chip');
  const voll = document.createElement('span');
  voll.className = 'who-full';
  voll.textContent = state.me || 'Wer bin ich?';
  const kurz = document.createElement('span');
  kurz.className = 'who-short';
  kurz.textContent = state.me ? state.me[0] : '?';
  chip.replaceChildren(voll, kurz);
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

/* ------------------------------------------------------------------ */
/* Hinweise (Neu-Zähler und Browser-Hinweise)                          */
/* ------------------------------------------------------------------ */

function unseen() {
  return unseenActivity(state.board, { since: state.seenAt, me: state.me });
}

function markSeen() {
  // Geht die Uhr des anderen Geräts vor, liegt ein Eintrag in der Zukunft.
  // Dann zählt sein Zeitstempel, sonst bliebe der Zähler für immer stehen.
  const neuste = (state.board.activity || [])[0]?.at || '';
  const jetzt = new Date().toISOString();
  state.seenAt = neuste > jetzt ? neuste : jetzt;
  localStorage.setItem(LS_SEEN, state.seenAt);
  render();
}

function updateBell() {
  const btn = $('#bell');
  const möglich = typeof Notification !== 'undefined';
  btn.classList.toggle('hidden', !möglich);
  if (!möglich) return;
  const an = state.notify && Notification.permission === 'granted';
  btn.classList.toggle('on', an);
  btn.setAttribute('aria-pressed', String(an));
  btn.title = Notification.permission === 'denied'
    ? 'Der Browser blockiert Hinweise für diese Seite'
    : an ? 'Browser-Hinweise sind an' : 'Browser-Hinweise einschalten';
}

async function toggleBell() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'denied') {
    showBanner('Der Browser blockiert Hinweise für diese Seite. Das lässt sich nur in den Browser-Einstellungen ändern.');
    return;
  }
  if (Notification.permission === 'default') {
    const antwort = await Notification.requestPermission();
    state.notify = antwort === 'granted';
  } else {
    state.notify = !state.notify;
  }
  localStorage.setItem(LS_NOTIFY, state.notify ? '1' : '0');
  updateBell();
}

/**
 * Hinweis im Browser, wenn der oder die andere etwas Neues eingetragen hat.
 * Das funktioniert nur, solange die Seite in einem Tab offen ist – echtes
 * Web-Push bräuchte einen eigenen Server, den GitHub Pages nicht bietet.
 */
function maybeNotify() {
  const neu = unseen();
  for (const eintrag of neu) {
    const erstmals = !notified.has(eintrag.id);
    notified.add(eintrag.id);
    if (!erstmals || firstSync) continue;
    if (typeof Notification === 'undefined') continue;
    if (!state.notify || Notification.permission !== 'granted') continue;
    try {
      new Notification('Firmen-Aufgaben', { body: activityText(eintrag), tag: eintrag.id });
    } catch { /* Browser darf ablehnen */ }
  }
  firstSync = false;
}

/* ------------------------------------------------------------------ */
/* Rendern                                                             */
/* ------------------------------------------------------------------ */

const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

function relativeDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? `heute ${fmtTime.format(d)}`
    : fmtDay.format(d);
}

function render() {
  const neu = new Set(unseen().map((e) => e.taskId));

  $('#archive-toggle').setAttribute('aria-pressed', String(state.showArchive));
  $('#archive-toggle').classList.toggle('btn-primary', state.showArchive);
  $('#board').classList.toggle('hidden', state.showArchive);
  $('#tabs').classList.toggle('hidden', state.showArchive);
  $('#archive').classList.toggle('hidden', !state.showArchive);
  $('#board').classList.toggle('two-columns', state.hideDone);

  for (const status of STATES) {
    const tasks = selectTasks(state.board, {
      status,
      sort: state.sort,
      priority: state.filterPrio,
      query: state.query,
    });
    state.rendered[status] = tasks;
    const stack = document.querySelector(`[data-stack="${status}"]`);
    stack.replaceChildren(...(tasks.length ? tasks.map((t) => renderCard(t, neu)) : [emptyHint(status)]));
    for (const el of document.querySelectorAll(`[data-count="${status}"]`)) {
      el.textContent = String(tasks.length);
    }
    const versteckt = status === 'erledigt' && state.hideDone;
    const col = document.querySelector(`[data-col="${status}"]`);
    col.classList.toggle('is-off', versteckt);
    col.classList.toggle('is-hidden-mobile', status !== state.tab);
    document.querySelector(`#tabs button[data-tab="${status}"]`).classList.toggle('is-off', versteckt);
  }

  for (const btn of document.querySelectorAll('#tabs button[data-tab]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
  }

  renderArchive(neu);
  renderOverview();
  renderActivity();
  renderNews();
}

function renderNews() {
  const anzahl = unseen().length;
  $('#news-chip').classList.toggle('hidden', anzahl === 0);
  $('#news-count').textContent = String(anzahl);
}

function emptyHint(status) {
  const div = document.createElement('div');
  div.className = 'empty';
  const gefiltert = state.query || state.filterPrio !== 'alle';
  div.textContent = gefiltert
    ? 'Nichts gefunden.'
    : { offen: 'Nichts offen. 🎉', dran: 'Gerade ist nichts in Arbeit.', erledigt: 'Noch nichts erledigt.' }[status];
  return div;
}

function chip(text, cls) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  return span;
}

function svgIcon(pfade, größe = 13) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(größe));
  svg.setAttribute('height', String(größe));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of pfade) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}

function linkChip(url, title) {
  if (!url) return null;
  const label = linkLabel(url, title);
  if (!isSafeLink(url)) {
    const div = document.createElement('div');
    div.className = 'meta';
    div.textContent = 'Link: ' + url;
    return div;
  }
  const a = document.createElement('a');
  a.className = 'link';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = url;
  const mark = svgIcon(['M8 16 16 8', 'M9 8h7v7']);
  mark.setAttribute('class', 'link-mark');
  const text = document.createElement('span');
  text.className = 'link-text';
  text.textContent = label;
  a.append(mark, text);
  return a;
}

function renderCard(task, neu) {
  const card = document.createElement('article');
  card.className = `card s-${task.status}`;
  card.dataset.id = task.id;
  card.dataset.status = task.status;
  card.dataset.priority = task.priority;
  if (task.archived) card.classList.add('is-archived');

  const kopf = document.createElement('div');
  kopf.className = 'card-head';

  if (neu?.has(task.id)) kopf.append(chip('Neu', 'flag flag-neu'));

  const priority = normalizePriority(task.priority);
  kopf.append(chip(PRIORITY_LABELS[priority], `prio prio-${priority}`));

  const frist = dueState(task, state.today);
  if (frist) kopf.append(chip(dueLabel(task, state.today), `due due-${frist}`));

  if (ziehbar(task)) {
    const griff = document.createElement('button');
    griff.type = 'button';
    griff.className = 'grip';
    griff.title = 'Zum Sortieren ziehen';
    griff.setAttribute('aria-label', 'Zum Sortieren ziehen');
    griff.append(svgIcon(['M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'], 14));
    griff.addEventListener('mousedown', () => { card.draggable = true; });
    griff.addEventListener('mouseup', () => { card.draggable = false; });
    kopf.append(griff);
  }

  card.append(kopf);

  const h = document.createElement('h3');
  h.textContent = task.title || '(ohne Titel)';
  card.append(h);

  const links = document.createElement('div');
  links.className = 'links';
  for (const [url, title] of [[task.url, task.linkTitle], [task.url2, task.linkTitle2]]) {
    const el = linkChip(url, title);
    if (el) links.append(el);
  }
  if (links.childElementCount) card.append(links);

  const zuständig = document.createElement('button');
  zuständig.type = 'button';
  zuständig.className = `assignee assignee-${normalizeAssignee(task.assignee) || 'offen'}`;
  zuständig.textContent = 'Zuständig: ' + ASSIGNEE_LABELS[normalizeAssignee(task.assignee)];
  zuständig.title = 'Zuständigkeit weiterschalten';
  zuständig.addEventListener('click', () => cycleAssignee(task.id));
  card.append(zuständig);

  const letzter = (task.comments || [])[task.comments.length - 1];
  if (letzter) {
    const note = document.createElement('div');
    note.className = 'note';
    const wer = document.createElement('span');
    wer.className = 'note-author';
    wer.textContent = `${letzter.author || 'Jemand'} · ${relativeDate(letzter.at)}`;
    const txt = document.createElement('span');
    txt.className = 'note-text';
    txt.textContent = letzter.text;
    note.append(wer, txt);
    card.append(note);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const teile = [];
  if (task.author) teile.push('von ' + task.author);
  teile.push('erstellt ' + relativeDate(task.createdAt));
  if (task.status === 'erledigt' && task.doneAt) teile.push('erledigt ' + relativeDate(task.doneAt));
  if (task.due && !frist) teile.push('Frist ' + formatDate(task.due));
  meta.textContent = teile.join(' · ');
  card.append(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const more = document.createElement('div');
  more.className = 'actions actions-more';

  const add = (row, label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    row.append(b);
    return b;
  };

  if (task.archived) {
    add(actions, 'Wiederherstellen', 'btn-primary', () => setArchived(task.id, false));
    add(more, `Kommentare (${task.comments.length})`, 'btn-ghost', () => openComments(task.id));
    add(more, 'Endgültig löschen', 'btn-ghost btn-danger', () => removeForever(task.id));
    card.append(actions, more);
    return card;
  }

  if (task.status === 'offen') {
    add(actions, 'Dran', 'btn-primary', () => setStatus(task.id, 'dran'));
    add(actions, 'Erledigt', '', () => setStatus(task.id, 'erledigt'));
  } else if (task.status === 'dran') {
    add(actions, 'Erledigt', 'btn-primary', () => setStatus(task.id, 'erledigt'));
    add(actions, 'Zurück zu Offen', '', () => setStatus(task.id, 'offen'));
  } else {
    add(actions, 'Wieder öffnen', '', () => setStatus(task.id, 'dran'));
  }

  add(more, `Kommentare (${task.comments.length})`, 'btn-ghost', () => openComments(task.id));
  add(more, 'Bearbeiten', 'btn-ghost', () => openEdit(task.id));
  add(more, 'Archivieren', 'btn-ghost', () => setArchived(task.id, true));

  if (ziehbar(task)) {
    add(more, '↑', 'btn-ghost btn-move', () => moveTask(task.id, -1)).title = 'Eine Position höher';
    add(more, '↓', 'btn-ghost btn-move', () => moveTask(task.id, 1)).title = 'Eine Position tiefer';
  }

  card.append(actions, more);
  wireDrag(card, task);
  return card;
}

function renderArchive(neu) {
  const tasks = archivedTasks(state.board, { query: state.query });
  $('#archive-count').textContent = String(tasks.length);
  $('#archive-toggle').textContent = tasks.length ? `Archiv (${tasks.length})` : 'Archiv';
  const stack = document.querySelector('[data-stack="archiv"]');
  if (!state.showArchive) return;
  if (!tasks.length) {
    const leer = document.createElement('div');
    leer.className = 'empty';
    leer.textContent = state.query ? 'Nichts gefunden.' : 'Das Archiv ist leer.';
    stack.replaceChildren(leer);
    return;
  }
  stack.replaceChildren(...tasks.map((t) => renderCard(t, neu)));
}

function renderOverview() {
  const fällig = dueOverview(state.board, state.today);
  const mitFrist = (state.board.tasks || []).some((t) => !t.deleted && !t.archived && t.due);

  $('#overview-count').textContent = String(fällig.length);
  $('#overview-empty').classList.toggle('hidden', fällig.length > 0);
  $('#overview-empty-text').textContent = mitFrist
    ? 'Heute ist nichts fällig, und nichts ist überfällig.'
    : 'Noch keine Aufgabe hat eine Frist. Beim Anlegen unter „Weitere Angaben" lässt sich eine setzen.';
  $('#overview-set-due').classList.toggle('hidden', mitFrist);

  const liste = $('#due-list');
  liste.replaceChildren(...fällig.map((task) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'due-row';
    const zustand = dueState(task, state.today);
    btn.append(chip(dueLabel(task, state.today), `due due-${zustand}`));
    const titel = document.createElement('span');
    titel.className = 'due-title';
    titel.textContent = task.title;
    btn.append(titel);
    btn.append(chip(STATE_LABELS[task.status], 'due-status'));
    btn.addEventListener('click', () => jumpTo(task));
    li.append(btn);
    return li;
  }));
}

function jumpTo(task) {
  state.showArchive = false;
  state.tab = task.status;
  if (state.hideDone && task.status === 'erledigt') {
    state.hideDone = false;
    $('#hide-done').checked = false;
    localStorage.setItem(LS_HIDEDONE, '0');
  }
  render();
  const card = document.querySelector(`.card[data-id="${CSS.escape(task.id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('is-flash');
  setTimeout(() => card.classList.remove('is-flash'), 1600);
}

function renderActivity() {
  const eintraege = activityFeed(state.board, 15);
  $('#activity-count').textContent = String(eintraege.length);
  $('#activity-empty').classList.toggle('hidden', eintraege.length > 0);
  $('#activity-list').replaceChildren(...eintraege.map((e) => {
    const li = document.createElement('li');
    const zeit = document.createElement('span');
    zeit.className = 'activity-time';
    zeit.textContent = relativeDate(e.at);
    const txt = document.createElement('span');
    txt.className = 'activity-text';
    txt.textContent = activityText(e);
    li.append(zeit, txt);
    return li;
  }));
}

/* ------------------------------------------------------------------ */
/* Kommentare                                                          */
/* ------------------------------------------------------------------ */

let commentingId = null;

function openComments(id) {
  commentingId = id;
  renderThread(id);
  $('#comment-text').value = '';
  const dlg = $('#comments-dialog');
  dlg.showModal();
  $('#comment-text').focus();
}

function renderThread(id) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  $('#comments-title').textContent = task.title || 'Kommentare';
  const liste = $('#thread');
  if (!task.comments.length) {
    const leer = document.createElement('li');
    leer.className = 'empty';
    leer.textContent = 'Noch keine Kommentare.';
    liste.replaceChildren(leer);
    return;
  }
  liste.replaceChildren(...task.comments.map((c) => {
    const li = document.createElement('li');
    const kopf = document.createElement('span');
    kopf.className = 'note-author';
    kopf.textContent = `${c.author || 'Jemand'} · ${relativeDate(c.at)}`;
    const txt = document.createElement('span');
    txt.className = 'note-text';
    txt.textContent = c.text;
    li.append(kopf, txt);
    return li;
  }));
}

/* ------------------------------------------------------------------ */
/* Bearbeiten                                                          */
/* ------------------------------------------------------------------ */

let editingId = null;

function openEdit(id) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  editingId = id;
  $('#edit-name').value = task.title;
  $('#edit-url').value = task.url;
  $('#edit-linktitle').value = task.linkTitle;
  $('#edit-url2').value = task.url2;
  $('#edit-linktitle2').value = task.linkTitle2;
  $('#edit-due').value = task.due;
  setChoice('edit-prio', normalizePriority(task.priority));
  setChoice('edit-assignee', normalizeAssignee(task.assignee));
  const dlg = $('#edit-dialog');
  dlg.showModal();
  $('#edit-name').focus();
}

function onEditClose(ev) {
  const dlg = ev.target;
  if (dlg.returnValue !== 'save' || !editingId) { editingId = null; return; }
  const title = $('#edit-name').value.trim();
  if (!title) { editingId = null; return; }
  updateTask(editingId, {
    title,
    url: normalizeUrl($('#edit-url').value),
    linkTitle: $('#edit-linktitle').value.trim(),
    url2: normalizeUrl($('#edit-url2').value),
    linkTitle2: $('#edit-linktitle2').value.trim(),
    due: $('#edit-due').value,
    priority: readChoice('edit-prio', DEFAULT_PRIORITY),
    assignee: readChoice('edit-assignee', ''),
  }, 'geaendert');
  editingId = null;
}

/* ------------------------------------------------------------------ */
/* Aktionen                                                            */
/* ------------------------------------------------------------------ */

function mutateTask(id, transform, kind) {
  const vorher = state.board.tasks.find((t) => t.id === id);
  if (!vorher) return;
  const nachher = transform(vorher);
  if (nachher === vorher) return;
  state.board = {
    ...state.board,
    tasks: state.board.tasks.map((t) => (t.id === id ? nachher : t)),
    activity: kind
      ? [makeActivity(kind, nachher, state.me), ...state.board.activity]
      : state.board.activity,
  };
  cacheAndRender();
  scheduleSave();
}

function updateTask(id, patch, kind) {
  mutateTask(id, (t) => touch(t, patch), kind);
}

function setStatus(id, status) {
  updateTask(id, { status, doneAt: status === 'erledigt' ? new Date().toISOString() : null }, status);
}

function setArchived(id, archived) {
  updateTask(id, { archived }, archived ? 'archiviert' : 'wiederhergestellt');
}

function removeForever(id) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  if (!confirm(`„${task.title}" endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
  updateTask(id, { deleted: true }, null);
}

function cycleAssignee(id) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  const jetzt = normalizeAssignee(task.assignee);
  const nächster = ASSIGNEE_CHOICES[(ASSIGNEE_CHOICES.indexOf(jetzt) + 1) % ASSIGNEE_CHOICES.length];
  updateTask(id, { assignee: nächster }, 'geaendert');
}

/* ------------------------------------------------------------------ */
/* Reihenfolge von Hand                                                */
/* ------------------------------------------------------------------ */

/** Von Hand sortiert wird nur, wenn die Wichtigkeit die Reihenfolge bestimmt. */
function ziehbar(task) {
  return !task.archived && state.sort === 'wichtigkeit' && task.status !== 'erledigt';
}

function siblings(task) {
  return (state.rendered[task.status] || []).filter((t) => t.priority === task.priority);
}

function moveTask(id, delta) {
  const task = state.board.tasks.find((t) => t.id === id);
  if (!task) return;
  const liste = siblings(task);
  const i = liste.findIndex((t) => t.id === id);
  const ziel = i + delta;
  if (i < 0 || ziel < 0 || ziel >= liste.length) return;
  updateTask(id, { order: orderForIndex(liste, id, ziel) }, null);
}

let dragId = null;

function wireDrag(card, task) {
  if (!ziehbar(task)) return;

  card.addEventListener('dragstart', (ev) => {
    dragId = task.id;
    card.classList.add('is-dragging');
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', task.id); } catch { /* Safari */ }
  });

  card.addEventListener('dragend', () => {
    dragId = null;
    card.draggable = false;
    card.classList.remove('is-dragging');
    for (const el of document.querySelectorAll('.drop-before,.drop-after')) {
      el.classList.remove('drop-before', 'drop-after');
    }
  });

  card.addEventListener('dragover', (ev) => {
    if (!passendesZiel(task)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const kasten = card.getBoundingClientRect();
    const unten = ev.clientY > kasten.top + kasten.height / 2;
    card.classList.toggle('drop-before', !unten);
    card.classList.toggle('drop-after', unten);
  });

  card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));

  card.addEventListener('drop', (ev) => {
    if (!passendesZiel(task)) return;
    ev.preventDefault();
    const unten = card.classList.contains('drop-after');
    card.classList.remove('drop-before', 'drop-after');
    dropAuf(dragId, task, unten);
  });
}

function passendesZiel(ziel) {
  if (!dragId || dragId === ziel.id) return false;
  const gezogen = state.board.tasks.find((t) => t.id === dragId);
  return !!gezogen && gezogen.status === ziel.status && gezogen.priority === ziel.priority;
}

function dropAuf(id, ziel, danach) {
  const liste = siblings(ziel);
  const rest = liste.filter((t) => t.id !== id);
  const index = rest.findIndex((t) => t.id === ziel.id);
  if (index < 0) return;
  updateTask(id, { order: orderForIndex(liste, id, index + (danach ? 1 : 0)) }, null);
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
    for (let versuch = 0; ; versuch++) {
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
        if (err instanceof ConflictError && versuch < 4) continue;
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

async function pull(leise) {
  if (inFlight) return;
  if (!leise) setSync('busy', 'lädt …');
  try {
    const { board: remote, sha } = await state.store.read();
    if (remote === null) { await flush(); return; }
    const sauber = sanitizeBoard(remote);
    const merged = mergeBoards(sauber, state.board);
    const lokalGeaendert = JSON.stringify(merged) !== JSON.stringify(sauber);
    state.board = merged;
    state.sha = sha;
    if (!state.seenAt) markSeen();
    cacheAndRender();
    maybeNotify();
    hideBanner();
    if (lokalGeaendert) { scheduleSave(); return; }
    setSync('ok', 'aktuell ' + fmtTime.format(new Date()));
  } catch (err) {
    setSync('error', 'offline');
    if (!leise) {
      showBanner(
        err instanceof AuthError
          ? 'Zugang abgelehnt: Der GitHub-Token ist ungültig oder abgelaufen. Bitte Einrichtung erneut ausführen.'
          : 'Konnte nicht laden: ' + err.message
      );
    }
  }
}

boot();
