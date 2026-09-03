import assert from 'node:assert/strict';
import {
  emptyBoard, createTask, mergeBoards, sanitizeBoard, visibleTasks,
  touch, normalizeUrl, isSafeLink, sortTasks,
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

console.log(`\n${passed} Tests bestanden.`);
