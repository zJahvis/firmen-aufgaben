import assert from 'node:assert/strict';
import {
  emptyBoard, createTask, mergeBoards, sanitizeBoard, visibleTasks,
  touch, normalizeUrl, isSafeLink, sortTasks,
  PRIORITIES, PRIORITY_LABELS, DEFAULT_PRIORITY, normalizePriority,
} from '../assets/board.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

console.log('board.js');

test('createTask setzt sinnvolle Vorgaben', () => {
  const t = createTask({ title: '  Angebot schreiben ', author: 'Kollege' });
  assert.equal(t.title, 'Angebot schreiben');
  assert.equal(t.status, 'offen');
  assert.equal(t.deleted, false);
  assert.equal(t.doneAt, null);
  assert.ok(t.id && t.createdAt && t.updatedAt);
});

test('normalizeUrl ergänzt https, lässt Leeres leer', () => {
  assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('https://a.de'), 'https://a.de');
  assert.equal(normalizeUrl('  '), '');
  assert.equal(normalizeUrl('Notiz ohne Link'), 'Notiz ohne Link');
});

test('isSafeLink lässt nur http(s) zu', () => {
  assert.equal(isSafeLink('https://a.de'), true);
  assert.equal(isSafeLink('http://a.de'), true);
  assert.equal(isSafeLink('javascript:alert(1)'), false);
  assert.equal(isSafeLink('kein link'), false);
});

test('merge behält Aufgaben beider Seiten', () => {
  const a = { version: 1, tasks: [createTask({ title: 'A' })] };
  const b = { version: 1, tasks: [createTask({ title: 'B' })] };
  const m = mergeBoards(a, b);
  assert.equal(m.tasks.length, 2);
});

test('merge nimmt je Aufgabe die neuere Fassung – unabhaengig von der Reihenfolge', () => {
  const base = createTask({ title: 'Alt' });
  const aelter = { version: 1, tasks: [{ ...base, title: 'Aelter', updatedAt: '2026-01-01T10:00:00.000Z' }] };
  const neuer = { version: 1, tasks: [{ ...base, title: 'Neuer', updatedAt: '2026-01-01T11:00:00.000Z' }] };
  assert.equal(mergeBoards(aelter, neuer).tasks[0].title, 'Neuer');
  assert.equal(mergeBoards(neuer, aelter).tasks[0].title, 'Neuer');
});

test('gleichzeitige Änderungen an verschiedenen Aufgaben gehen nicht verloren', () => {
  const t1 = createTask({ title: 'Eins' });
  const t2 = createTask({ title: 'Zwei' });
  const alt = '2026-02-01T08:00:00.000Z';
  const remote = { version: 1, tasks: [{ ...t1, updatedAt: alt }, { ...t2, status: 'erledigt', updatedAt: '2026-02-01T09:00:00.000Z' }] };
  const local = { version: 1, tasks: [{ ...t1, note: 'Notiz', updatedAt: '2026-02-01T09:05:00.000Z' }, { ...t2, updatedAt: alt }] };
  const m = mergeBoards(remote, local);
  assert.equal(m.tasks.find((t) => t.id === t1.id).note, 'Notiz');
  assert.equal(m.tasks.find((t) => t.id === t2.id).status, 'erledigt');
});

test('Löschung gewinnt bei gleichem Zeitstempel', () => {
  const t = createTask({ title: 'X' });
  const del = { ...t, deleted: true };
  assert.equal(mergeBoards({ tasks: [del] }, { tasks: [t] }).tasks[0].deleted, true);
});

test('alte Löschmarken werden aufgeräumt', () => {
  const t = { ...createTask({ title: 'Uralt' }), deleted: true, updatedAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(mergeBoards({ tasks: [t] }, emptyBoard()).tasks.length, 0);
});

test('visibleTasks filtert Status und Gelöschtes', () => {
  const board = {
    tasks: [
      createTask({ title: 'a', status: 'offen' }),
      createTask({ title: 'b', status: 'dran' }),
      { ...createTask({ title: 'c', status: 'offen' }), deleted: true },
    ],
  };
  assert.equal(visibleTasks(board, 'offen').length, 1);
  assert.equal(visibleTasks(board, 'dran').length, 1);
  assert.equal(visibleTasks(board, 'erledigt').length, 0);
});

test('sanitizeBoard repariert kaputte Daten', () => {
  const s = sanitizeBoard({ tasks: [null, { id: 'x' }, { id: 'x', title: 'doppelt' }, { id: 'y', status: 'quatsch' }] });
  assert.equal(s.tasks.length, 2);
  assert.equal(s.tasks[0].title, '');
  assert.equal(s.tasks[1].status, 'offen');
});

test('touch aktualisiert updatedAt', async () => {
  const t = { ...createTask({ title: 'T' }), updatedAt: '2020-01-01T00:00:00.000Z' };
  assert.ok(touch(t, { title: 'U' }).updatedAt > t.updatedAt);
});

test('erledigte Aufgaben stehen zuletzt erledigt zuerst', () => {
  const a = { ...createTask({ title: 'a', status: 'erledigt' }), doneAt: '2026-01-01T00:00:00.000Z' };
  const b = { ...createTask({ title: 'b', status: 'erledigt' }), doneAt: '2026-03-01T00:00:00.000Z' };
  assert.equal(sortTasks([a, b])[0].title, 'b');
});

test('neue Aufgaben sind standardmaessig Mittel', () => {
  assert.equal(createTask({ title: 'A' }).priority, 'mittel');
  assert.equal(DEFAULT_PRIORITY, 'mittel');
});

test('Wichtigkeit laesst sich beim Anlegen setzen', () => {
  assert.equal(createTask({ title: 'A', priority: 'hoch' }).priority, 'hoch');
  assert.equal(createTask({ title: 'A', priority: 'niedrig' }).priority, 'niedrig');
});

test('unbekannte Wichtigkeit faellt auf Mittel zurueck', () => {
  assert.equal(createTask({ title: 'A', priority: 'dringend' }).priority, 'mittel');
  assert.equal(normalizePriority(undefined), 'mittel');
  assert.equal(normalizePriority('HOCH'), 'mittel');
});

test('deutsche Bezeichnungen der Wichtigkeit', () => {
  assert.deepEqual(PRIORITIES, ['hoch', 'mittel', 'niedrig']);
  assert.deepEqual(PRIORITY_LABELS, { hoch: 'Hoch', mittel: 'Mittel', niedrig: 'Niedrig' });
});

test('Aufgaben aus der Zeit vor der Wichtigkeit bekommen Mittel', () => {
  const alt = { id: 'a', title: 'Ohne Feld', status: 'offen', createdAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(sanitizeBoard({ tasks: [alt] }).tasks[0].priority, 'mittel');
  assert.equal(sanitizeBoard({ tasks: [{ ...alt, priority: 'quatsch' }] }).tasks[0].priority, 'mittel');
});

test('nach Wichtigkeit: Hoch vor Mittel vor Niedrig', () => {
  const mk = (t, p, min) => ({
    ...createTask({ title: t, priority: p }),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  });
  const tasks = [mk('n', 'niedrig', 0), mk('m', 'mittel', 1), mk('h', 'hoch', 2)];
  assert.deepEqual(sortTasks(tasks, 'wichtigkeit').map((t) => t.title), ['h', 'm', 'n']);
});

test('bei gleicher Wichtigkeit entscheidet die Zeit', () => {
  const mk = (t, min) => ({
    ...createTask({ title: t, priority: 'hoch' }),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  });
  assert.deepEqual(sortTasks([mk('spaet', 5), mk('frueh', 1)], 'wichtigkeit').map((t) => t.title),
    ['frueh', 'spaet']);
});

test('nach Datum bleibt die Wichtigkeit unberuecksichtigt', () => {
  const mk = (t, p, min) => ({
    ...createTask({ title: t, priority: p }),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  });
  const tasks = [mk('h', 'hoch', 9), mk('n', 'niedrig', 1)];
  assert.deepEqual(sortTasks(tasks, 'datum').map((t) => t.title), ['n', 'h']);
});

test('Statusfilter und Wichtigkeit greifen zusammen', () => {
  const mk = (t, p, status, min) => ({
    ...createTask({ title: t, priority: p, status }),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  });
  const board = {
    tasks: [
      mk('offen-niedrig', 'niedrig', 'offen', 1),
      mk('offen-hoch', 'hoch', 'offen', 2),
      mk('dran-hoch', 'hoch', 'dran', 3),
      mk('offen-mittel', 'mittel', 'offen', 4),
    ],
  };
  assert.deepEqual(visibleTasks(board, 'offen', 'wichtigkeit').map((t) => t.title),
    ['offen-hoch', 'offen-mittel', 'offen-niedrig']);
  assert.deepEqual(visibleTasks(board, 'dran', 'wichtigkeit').map((t) => t.title), ['dran-hoch']);
  assert.equal(visibleTasks(board, 'erledigt', 'wichtigkeit').length, 0);
});

test('erledigte Aufgaben sortieren ebenfalls nach Wichtigkeit', () => {
  const mk = (t, p, tag) => ({
    ...createTask({ title: t, priority: p, status: 'erledigt' }),
    doneAt: `2026-03-0${tag}T00:00:00.000Z`,
  });
  assert.deepEqual(sortTasks([mk('m', 'mittel', 9), mk('h', 'hoch', 1)], 'wichtigkeit').map((t) => t.title),
    ['h', 'm']);
});

test('gespeichert wird unabhaengig von der Ansicht immer gleich sortiert', () => {
  const mk = (t, p, min) => ({
    ...createTask({ title: t, priority: p }),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  });
  const board = { tasks: [mk('h', 'hoch', 9), mk('n', 'niedrig', 1)] };
  assert.deepEqual(mergeBoards(emptyBoard(), board).tasks.map((t) => t.title), ['n', 'h']);
});

test('Aenderung der Wichtigkeit gewinnt beim Zusammenfuehren', () => {
  const base = createTask({ title: 'X', priority: 'niedrig' });
  const remote = { tasks: [{ ...base, updatedAt: '2026-02-01T09:00:00.000Z' }] };
  const local = { tasks: [{ ...base, priority: 'hoch', updatedAt: '2026-02-01T09:05:00.000Z' }] };
  assert.equal(mergeBoards(remote, local).tasks[0].priority, 'hoch');
});

console.log(`\n${passed} Tests bestanden.`);
