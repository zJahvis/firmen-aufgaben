// Datenmodell der Pinnwand + Zusammenführen (Merge) konkurrierender Stände.
// Bewusst ohne DOM-Zugriff, damit die Logik separat testbar ist.

export const STATES = ['offen', 'dran', 'erledigt'];

export const STATE_LABELS = {
  offen: 'Offen',
  dran: 'Dran',
  erledigt: 'Erledigt',
};

export const PRIORITIES = ['hoch', 'mittel', 'niedrig'];

export const PRIORITY_LABELS = {
  hoch: 'Hoch',
  mittel: 'Mittel',
  niedrig: 'Niedrig',
};

export const DEFAULT_PRIORITY = 'mittel';

/** Hoch vor Mittel vor Niedrig. */
const PRIORITY_RANK = { hoch: 0, mittel: 1, niedrig: 2 };

export const PEOPLE = ['JAHVIS', 'Kollege'];

/** Leer bedeutet: noch niemandem zugeteilt. */
export const ASSIGNEE_LABELS = { '': 'Offen', JAHVIS: 'JAHVIS', Kollege: 'Kollege' };
export const ASSIGNEE_CHOICES = ['JAHVIS', 'Kollege', ''];
export const DEFAULT_ASSIGNEE = 'JAHVIS';

/** 'wichtigkeit' sortiert nach Priorität, 'datum' nach Anlage- bzw. Erledigungszeit. */
export const SORT_MODES = ['wichtigkeit', 'datum'];
export const DEFAULT_SORT = 'wichtigkeit';

export const ACTIVITY_KINDS = [
  'angelegt', 'offen', 'dran', 'erledigt',
  'kommentiert', 'geaendert', 'archiviert', 'wiederhergestellt',
];

export const BOARD_VERSION = 2;
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 Tage
const ACTIVITY_LIMIT = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyBoard() {
  return { version: BOARD_VERSION, tasks: [], activity: [] };
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : DEFAULT_PRIORITY;
}

export function normalizeAssignee(value) {
  return PEOPLE.includes(value) ? value : '';
}

/* ------------------------------------------------------------------ */
/* Fristen                                                             */
/* ------------------------------------------------------------------ */

const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeDue(value) {
  return DUE_RE.test(String(value || '')) ? String(value) : '';
}

/** Heutiges Datum als YYYY-MM-DD in der Zeitzone des Geräts. */
export function todayIso(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayValue(iso) {
  const m = DUE_RE.exec(iso || '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/** Tage zwischen zwei Datumsangaben – negativ heißt: liegt zurück. */
export function daysUntil(due, today) {
  const a = dayValue(due);
  const b = dayValue(today);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

/** '', 'ueberfaellig', 'heute' oder 'spaeter'. Erledigtes ist nie überfällig. */
export function dueState(task, today) {
  const due = normalizeDue(task?.due);
  if (!due) return '';
  if (task.status === 'erledigt') return 'spaeter';
  const rest = daysUntil(due, today);
  if (rest === null) return '';
  if (rest < 0) return 'ueberfaellig';
  if (rest === 0) return 'heute';
  return 'spaeter';
}

export function formatDate(iso) {
  const m = DUE_RE.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : '';
}

/** Kurztext für die Frist, z. B. „2 Tage überfällig" oder „heute fällig". */
export function dueLabel(task, today) {
  const due = normalizeDue(task?.due);
  if (!due) return '';
  const rest = daysUntil(due, today);
  if (task.status === 'erledigt' || rest === null) return `Frist ${formatDate(due)}`;
  if (rest < -1) return `${Math.abs(rest)} Tage überfällig`;
  if (rest === -1) return '1 Tag überfällig';
  if (rest === 0) return 'heute fällig';
  if (rest === 1) return 'morgen fällig';
  return `fällig ${formatDate(due)}`;
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

export function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(raw)) return 'https://' + raw;
  return raw;
}

/** Nur http(s)-Links dürfen als anklickbarer Link gerendert werden. */
export function isSafeLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Kurze Beschriftung für einen Link. Eine eigene Beschriftung hat Vorrang,
 * sonst wird aus der Adresse eine lesbare Kurzform gebildet – die echte
 * Seitenüberschrift lässt sich von einer statischen Seite aus nicht laden.
 */
export function linkLabel(url, title = '') {
  const own = String(title || '').trim();
  if (own) return own;
  const raw = String(url || '').trim();
  if (!raw) return '';
  let host = '';
  let rest = '';
  try {
    const u = new URL(raw);
    host = u.hostname.replace(/^www\./i, '');
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || '';
    rest = decodeURIComponent(last)
      .replace(/\.(html?|php|aspx?|pdf|docx?|xlsx?|pptx?)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim();
  } catch {
    return raw.replace(/^https?:\/\//i, '').slice(0, 60);
  }
  return rest ? `${host} · ${rest}` : host;
}

/* ------------------------------------------------------------------ */
/* Aufgaben                                                            */
/* ------------------------------------------------------------------ */

export function createTask(input = {}) {
  const now = new Date().toISOString();
  const status = STATES.includes(input.status) ? input.status : 'offen';
  return sanitizeTask({
    id: newId(),
    title: String(input.title || '').trim(),
    url: normalizeUrl(input.url),
    linkTitle: input.linkTitle,
    url2: normalizeUrl(input.url2),
    linkTitle2: input.linkTitle2,
    status,
    priority: input.priority ?? DEFAULT_PRIORITY,
    due: input.due,
    author: input.author,
    assignee: input.assignee ?? DEFAULT_ASSIGNEE,
    comments: [],
    order: Date.now(),
    archived: false,
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'erledigt' ? now : null,
    deleted: false,
  });
}

export function touch(task, patch) {
  return sanitizeTask({ ...task, ...patch, updatedAt: new Date().toISOString() });
}

/** Hängt einen Kommentar an – der Verlauf wird nie verändert, nur ergänzt. */
export function addComment(task, { author, text, at = new Date().toISOString() }) {
  const body = String(text || '').trim();
  if (!body) return task;
  const bisher = task.comments || [];
  const letzter = bisher[bisher.length - 1];
  // Zwei Beiträge in derselben Millisekunde dürfen die Reihenfolge nicht
  // vertauschen: der neue bekommt dann garantiert den späteren Zeitpunkt.
  const zeit = letzter && at <= letzter.at
    ? new Date(Date.parse(letzter.at) + 1).toISOString()
    : at;
  const comment = { id: newId(), author: String(author || ''), text: body, at: zeit };
  return touch(task, { comments: [...bisher, comment] });
}

function sanitizeComment(raw, fallbackAt) {
  if (!raw || typeof raw.id !== 'string') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim()) return null;
  return {
    id: raw.id,
    author: typeof raw.author === 'string' ? raw.author : '',
    text,
    at: typeof raw.at === 'string' ? raw.at : fallbackAt,
  };
}

function sortComments(list) {
  return [...list].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
}

export function sanitizeTask(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const createdAt = raw.createdAt || new Date(0).toISOString();
  const updatedAt = raw.updatedAt || createdAt;

  const seen = new Set();
  const comments = [];
  for (const entry of Array.isArray(raw.comments) ? raw.comments : []) {
    const clean = sanitizeComment(entry, createdAt);
    if (clean && !seen.has(clean.id)) {
      seen.add(clean.id);
      comments.push(clean);
    }
  }
  // Aus der Zeit vor dem Kommentarverlauf: die alte Notiz wird zum ersten
  // Kommentar. Kennung und Zeitpunkt sind fest abgeleitet, damit jedes Gerät
  // dasselbe Ergebnis erzeugt und daraus keine Schreibschleife entsteht.
  const note = typeof raw.note === 'string' ? raw.note : '';
  if (!comments.length && note.trim()) {
    comments.push({ id: `${raw.id}-notiz`, author: String(raw.author || ''), text: note, at: createdAt });
  }

  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    linkTitle: typeof raw.linkTitle === 'string' ? raw.linkTitle : '',
    url2: typeof raw.url2 === 'string' ? raw.url2 : '',
    linkTitle2: typeof raw.linkTitle2 === 'string' ? raw.linkTitle2 : '',
    status: STATES.includes(raw.status) ? raw.status : 'offen',
    priority: normalizePriority(raw.priority),
    due: normalizeDue(raw.due),
    author: typeof raw.author === 'string' ? raw.author : '',
    assignee: normalizeAssignee(raw.assignee),
    comments: sortComments(comments),
    order: Number.isFinite(raw.order) ? raw.order : (Date.parse(createdAt) || 0),
    archived: raw.archived === true,
    createdAt,
    updatedAt,
    doneAt: raw.doneAt || null,
    deleted: raw.deleted === true,
  };
}

/* ------------------------------------------------------------------ */
/* Aktivität                                                           */
/* ------------------------------------------------------------------ */

export function makeActivity(kind, task, actor, at = new Date().toISOString()) {
  return {
    id: newId(),
    at,
    actor: String(actor || ''),
    kind: ACTIVITY_KINDS.includes(kind) ? kind : 'geaendert',
    taskId: task?.id || '',
    title: task?.title || '',
  };
}

const ACTIVITY_TEXT = {
  angelegt: 'hat angelegt',
  offen: 'hat zurück auf Offen gesetzt',
  dran: 'hat begonnen',
  erledigt: 'hat erledigt',
  kommentiert: 'hat kommentiert',
  geaendert: 'hat geändert',
  archiviert: 'hat archiviert',
  wiederhergestellt: 'hat wiederhergestellt',
};

export function activityText(entry) {
  return `${entry.actor || 'Jemand'} ${ACTIVITY_TEXT[entry.kind] || 'hat geändert'}: ${entry.title || 'Aufgabe'}`;
}

function sanitizeActivity(list) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
    if (typeof raw.at !== 'string') continue;
    seen.add(raw.id);
    clean.push({
      id: raw.id,
      at: raw.at,
      actor: typeof raw.actor === 'string' ? raw.actor : '',
      kind: ACTIVITY_KINDS.includes(raw.kind) ? raw.kind : 'geaendert',
      taskId: typeof raw.taskId === 'string' ? raw.taskId : '',
      title: typeof raw.title === 'string' ? raw.title : '',
    });
  }
  // Neueste zuerst, gekappt – sonst wüchse die Datei unbegrenzt.
  clean.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
  return clean.slice(0, ACTIVITY_LIMIT);
}

/* ------------------------------------------------------------------ */
/* Zusammenführen                                                      */
/* ------------------------------------------------------------------ */

function unionComments(a = [], b = []) {
  const byId = new Map();
  for (const c of a) byId.set(c.id, c);
  for (const c of b) if (!byId.has(c.id)) byId.set(c.id, c);
  return sortComments([...byId.values()]);
}

function newerTask(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = a.updatedAt === b.updatedAt
    ? (a.deleted || a.archived ? a : b)
    : (a.updatedAt > b.updatedAt ? a : b);
  // Kommentare sind ein Verlauf: hier zählt die Vereinigung, nicht der
  // jüngere Stand – sonst gingen gleichzeitige Beiträge verloren.
  const comments = unionComments(a.comments, b.comments);
  return comments.length === base.comments.length ? base : { ...base, comments };
}

/**
 * Führt zwei Stände derselben Pinnwand zusammen.
 * Pro Aufgabe gewinnt die zuletzt geänderte Fassung (Last-Write-Wins je Aufgabe,
 * nicht je Datei) – dadurch überschreiben sich beide Nutzer nicht gegenseitig.
 */
export function mergeBoards(remote, local) {
  const byId = new Map();
  for (const t of remote?.tasks || []) byId.set(t.id, t);
  for (const t of local?.tasks || []) byId.set(t.id, newerTask(byId.get(t.id), t));

  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const tasks = [...byId.values()].filter(
    (t) => !(t.deleted && Date.parse(t.updatedAt || 0) < cutoff)
  );

  const activity = sanitizeActivity([...(remote?.activity || []), ...(local?.activity || [])]);

  // Gespeichert wird immer in derselben Reihenfolge, unabhängig davon, wie die
  // Ansicht gerade sortiert – sonst schriebe jeder Nutzer die Datei neu, nur
  // weil er anders sortiert.
  return { version: BOARD_VERSION, tasks: sortTasks(tasks, 'datum'), activity };
}

/** Repariert fremde/alte Daten, damit die Oberfläche nie auf undefined läuft. */
export function sanitizeBoard(input) {
  const seen = new Set();
  const tasks = [];
  for (const raw of Array.isArray(input?.tasks) ? input.tasks : []) {
    const clean = sanitizeTask(raw);
    if (clean && !seen.has(clean.id)) {
      seen.add(clean.id);
      tasks.push(clean);
    }
  }
  return { version: BOARD_VERSION, tasks, activity: sanitizeActivity(input?.activity) };
}

/* ------------------------------------------------------------------ */
/* Sortieren, Filtern, Suchen                                          */
/* ------------------------------------------------------------------ */

function byTime(a, b) {
  if (a.status === 'erledigt' && b.status === 'erledigt') {
    return String(b.doneAt || b.updatedAt).localeCompare(String(a.doneAt || a.updatedAt));
  }
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

export function sortTasks(tasks, mode = DEFAULT_SORT) {
  return [...tasks].sort((a, b) => {
    if (mode === 'wichtigkeit') {
      const rank = PRIORITY_RANK[normalizePriority(a.priority)] - PRIORITY_RANK[normalizePriority(b.priority)];
      if (rank !== 0) return rank;
      if (a.status !== 'erledigt' || b.status !== 'erledigt') {
        const order = (a.order || 0) - (b.order || 0);
        if (order !== 0) return order;
      }
    }
    return byTime(a, b);
  });
}

export function matchesQuery(task, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    task.title,
    task.url, task.linkTitle,
    task.url2, task.linkTitle2,
    task.author, task.assignee,
    ...(task.comments || []).map((c) => `${c.author} ${c.text}`),
  ].join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Aufgaben einer Spalte. Status, Wichtigkeitsfilter, Suche und Sortierung
 * greifen zusammen; Archiviertes und Gelöschtes bleibt außen vor.
 */
export function selectTasks(board, { status, sort = DEFAULT_SORT, priority = 'alle', query = '' } = {}) {
  const tasks = (board?.tasks || []).filter(
    (t) => !t.deleted
      && !t.archived
      && (!status || t.status === status)
      && (priority === 'alle' || normalizePriority(t.priority) === priority)
      && matchesQuery(t, query)
  );
  return sortTasks(tasks, sort);
}

export function archivedTasks(board, { query = '' } = {}) {
  return (board?.tasks || [])
    .filter((t) => !t.deleted && t.archived && matchesQuery(t, query))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Heute fällige und überfällige Aufgaben – überfällige zuerst. */
export function dueOverview(board, today) {
  return (board?.tasks || [])
    .filter((t) => !t.deleted && !t.archived && t.status !== 'erledigt'
      && normalizeDue(t.due) && daysUntil(t.due, today) <= 0)
    .sort((a, b) => (a.due === b.due ? String(a.createdAt).localeCompare(String(b.createdAt)) : a.due.localeCompare(b.due)));
}

/**
 * Verlauf für die Anzeige. Neben den aufgezeichneten Ereignissen werden
 * Einträge aus den vorhandenen Aufgaben abgeleitet – sonst bliebe die
 * Aktivitätszeile auf einer Pinnwand leer, die es schon vor dieser
 * Erweiterung gab. Abgeleitetes wird nur angezeigt, nie gespeichert.
 */
export function activityFeed(board, limit = 20) {
  const echte = (board?.activity || []).filter((e) => e && typeof e.at === 'string');

  // Wie viele Ereignisse je Aufgabe und Art bereits aufgezeichnet sind.
  const gezaehlt = new Map();
  for (const e of echte) {
    const schluessel = `${e.taskId}|${e.kind}`;
    gezaehlt.set(schluessel, (gezaehlt.get(schluessel) || 0) + 1);
  }

  const abgeleitet = [];
  for (const t of board?.tasks || []) {
    if (t.deleted) continue;

    // Angelegt wird eine Aufgabe genau einmal.
    if (!gezaehlt.get(`${t.id}|angelegt`) && t.createdAt) {
      abgeleitet.push({
        id: `abgeleitet-${t.id}-angelegt`, at: t.createdAt, actor: t.author,
        kind: 'angelegt', taskId: t.id, title: t.title,
      });
    }

    // Aufgezeichnet wurden die jüngsten Kommentare; die älteren werden ergänzt.
    const kommentare = t.comments || [];
    const fehlende = Math.max(0, kommentare.length - (gezaehlt.get(`${t.id}|kommentiert`) || 0));
    for (const c of kommentare.slice(0, fehlende)) {
      abgeleitet.push({
        id: `abgeleitet-${c.id}`, at: c.at, actor: c.author,
        kind: 'kommentiert', taskId: t.id, title: t.title,
      });
    }
  }

  return [...echte, ...abgeleitet]
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)))
    .slice(0, limit);
}

/** Neue Aktivität anderer seit dem letzten Besuch. */
export function unseenActivity(board, { since, me }) {
  if (!since) return [];
  return (board?.activity || []).filter((e) => e.at > since && e.actor && e.actor !== me);
}

/* ------------------------------------------------------------------ */
/* Reihenfolge von Hand                                                */
/* ------------------------------------------------------------------ */

/** Ordnungswert zwischen zwei Nachbarn – für Ziehen und die Pfeiltasten. */
export function orderBetween(before, after) {
  if (!Number.isFinite(before) && !Number.isFinite(after)) return Date.now();
  if (!Number.isFinite(before)) return after - 1000;
  if (!Number.isFinite(after)) return before + 1000;
  return (before + after) / 2;
}

/**
 * Neuer Ordnungswert, wenn `id` an die Stelle `index` derselben Wichtigkeit
 * rückt. `siblings` ist die angezeigte Liste dieser Wichtigkeit.
 */
export function orderForIndex(siblings, id, index) {
  const rest = siblings.filter((t) => t.id !== id);
  const ziel = Math.max(0, Math.min(index, rest.length));
  const before = ziel > 0 ? rest[ziel - 1].order : undefined;
  const after = ziel < rest.length ? rest[ziel].order : undefined;
  return orderBetween(before, after);
}
