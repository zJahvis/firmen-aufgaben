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

/** 'wichtigkeit' sortiert nach Priorität, 'datum' nach Anlage- bzw. Erledigungszeit. */
export const SORT_MODES = ['wichtigkeit', 'datum'];
export const DEFAULT_SORT = 'wichtigkeit';

export function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : DEFAULT_PRIORITY;
}

export const BOARD_VERSION = 1;
const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 Tage

export function emptyBoard() {
  return { version: BOARD_VERSION, tasks: [] };
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function createTask({
  title,
  url = '',
  note = '',
  author = '',
  status = 'offen',
  priority = DEFAULT_PRIORITY,
}) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: String(title || '').trim(),
    url: normalizeUrl(url),
    note: String(note || ''),
    status: STATES.includes(status) ? status : 'offen',
    priority: normalizePriority(priority),
    author: String(author || ''),
    createdAt: now,
    updatedAt: now,
    doneAt: status === 'erledigt' ? now : null,
    deleted: false,
  };
}

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

export function touch(task, patch) {
  return { ...task, ...patch, updatedAt: new Date().toISOString() };
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt === b.updatedAt) return a.deleted ? a : b;
  return a.updatedAt > b.updatedAt ? a : b;
}

/**
 * Führt zwei Stände derselben Pinnwand zusammen.
 * Pro Aufgabe gewinnt die zuletzt geänderte Fassung (Last-Write-Wins je Aufgabe,
 * nicht je Datei) – dadurch überschreiben sich beide Nutzer nicht gegenseitig.
 */
export function mergeBoards(remote, local) {
  const byId = new Map();
  for (const t of remote?.tasks || []) byId.set(t.id, t);
  for (const t of local?.tasks || []) byId.set(t.id, newer(byId.get(t.id), t));

  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const tasks = [...byId.values()].filter(
    (t) => !(t.deleted && Date.parse(t.updatedAt || 0) < cutoff)
  );

  // Gespeichert wird immer in derselben Reihenfolge, unabhängig davon, wie die
  // Ansicht gerade sortiert – sonst schriebe jeder Nutzer die Datei neu, nur
  // weil er anders sortiert.
  return { version: BOARD_VERSION, tasks: sortTasks(tasks, 'datum') };
}

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
    }
    return byTime(a, b);
  });
}

/** Aufgaben einer Spalte – Statusfilter und Sortierung greifen zusammen. */
export function visibleTasks(board, status, mode = DEFAULT_SORT) {
  return sortTasks(
    (board?.tasks || []).filter((t) => !t.deleted && t.status === status),
    mode
  );
}

/** Repariert fremde/alte Daten, damit die Oberfläche nie auf undefined läuft. */
export function sanitizeBoard(input) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const seen = new Set();
  const clean = [];
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || seen.has(t.id)) continue;
    seen.add(t.id);
    clean.push({
      id: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
      note: typeof t.note === 'string' ? t.note : '',
      status: STATES.includes(t.status) ? t.status : 'offen',
      priority: normalizePriority(t.priority),
      author: typeof t.author === 'string' ? t.author : '',
      createdAt: t.createdAt || new Date(0).toISOString(),
      updatedAt: t.updatedAt || t.createdAt || new Date(0).toISOString(),
      doneAt: t.doneAt || null,
      deleted: t.deleted === true,
    });
  }
  return { version: BOARD_VERSION, tasks: clean };
}
