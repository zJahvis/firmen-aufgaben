import assert from 'node:assert/strict';
import {
  emptyBoard, createTask, touch, addComment, mergeBoards, sanitizeBoard,
  selectTasks, archivedTasks, dueOverview, unseenActivity, activityText, makeActivity,
  normalizeUrl, isSafeLink, linkLabel, sortTasks, matchesQuery, activityFeed,
  PRIORITIES, PRIORITY_LABELS, DEFAULT_PRIORITY, normalizePriority, normalizeAssignee,
  todayIso, daysUntil, dueState, dueLabel, formatDate, normalizeDue,
  orderBetween, orderForIndex,
} from '../assets/board.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

/** Aufgabe mit fest gesetzter Zeit und Reihenfolge – macht Tests vorhersagbar. */
function mk(title, extra = {}, minute = 0) {
  const zeit = new Date(Date.UTC(2026, 8, 1, 8, minute)).toISOString();
  return { ...createTask({ title, ...extra }), createdAt: zeit, updatedAt: zeit, order: minute };
}

console.log('board.js');

/* ---------------- Grundlagen ---------------- */

test('createTask setzt sinnvolle Vorgaben', () => {
  const t = createTask({ title: '  Angebot schreiben ', author: 'Kollege' });
  assert.equal(t.title, 'Angebot schreiben');
  assert.equal(t.status, 'offen');
  assert.equal(t.priority, 'mittel');
  assert.equal(t.assignee, 'JAHVIS');
  assert.equal(t.archived, false);
  assert.equal(t.deleted, false);
  assert.deepEqual(t.comments, []);
  assert.equal(t.due, '');
  assert.ok(t.id && t.createdAt && Number.isFinite(t.order));
});

test('normalizeUrl ergaenzt https, laesst Leeres leer', () => {
  assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('https://a.de'), 'https://a.de');
  assert.equal(normalizeUrl('  '), '');
});

test('isSafeLink laesst nur http(s) zu', () => {
  assert.equal(isSafeLink('https://a.de'), true);
  assert.equal(isSafeLink('javascript:alert(1)'), false);
});

test('deutsche Bezeichnungen der Wichtigkeit', () => {
  assert.deepEqual(PRIORITIES, ['hoch', 'mittel', 'niedrig']);
  assert.deepEqual(PRIORITY_LABELS, { hoch: 'Hoch', mittel: 'Mittel', niedrig: 'Niedrig' });
  assert.equal(DEFAULT_PRIORITY, 'mittel');
  assert.equal(normalizePriority('dringend'), 'mittel');
  assert.equal(normalizeAssignee('Chef'), '');
  assert.equal(normalizeAssignee('Kollege'), 'Kollege');
});

/* ---------------- Fristen ---------------- */

test('todayIso nimmt die Ortszeit, nicht UTC', () => {
  assert.equal(todayIso(new Date(2026, 8, 7, 23, 30)), '2026-09-07');
  assert.equal(todayIso(new Date(2026, 0, 5, 0, 5)), '2026-01-05');
});

test('normalizeDue laesst nur echte Datumsangaben durch', () => {
  assert.equal(normalizeDue('2026-09-07'), '2026-09-07');
  assert.equal(normalizeDue('07.09.2026'), '');
  assert.equal(normalizeDue(undefined), '');
});

test('daysUntil zaehlt Tage in beide Richtungen', () => {
  assert.equal(daysUntil('2026-09-07', '2026-09-07'), 0);
  assert.equal(daysUntil('2026-09-09', '2026-09-07'), 2);
  assert.equal(daysUntil('2026-09-04', '2026-09-07'), -3);
  assert.equal(daysUntil('', '2026-09-07'), null);
});

test('dueState erkennt ueberfaellig und heute', () => {
  const heute = '2026-09-07';
  assert.equal(dueState(mk('a', { due: '2026-09-05' }), heute), 'ueberfaellig');
  assert.equal(dueState(mk('a', { due: heute }), heute), 'heute');
  assert.equal(dueState(mk('a', { due: '2026-09-20' }), heute), 'spaeter');
  assert.equal(dueState(mk('a'), heute), '');
});

test('Erledigtes ist nie ueberfaellig', () => {
  const t = mk('a', { due: '2026-01-01', status: 'erledigt' });
  assert.equal(dueState(t, '2026-09-07'), 'spaeter');
});

test('dueLabel schreibt verstaendliches Deutsch', () => {
  const heute = '2026-09-07';
  assert.equal(dueLabel(mk('a', { due: heute }), heute), 'heute fällig');
  assert.equal(dueLabel(mk('a', { due: '2026-09-08' }), heute), 'morgen fällig');
  assert.equal(dueLabel(mk('a', { due: '2026-09-06' }), heute), '1 Tag überfällig');
  assert.equal(dueLabel(mk('a', { due: '2026-09-04' }), heute), '3 Tage überfällig');
  assert.equal(dueLabel(mk('a', { due: '2026-09-20' }), heute), 'fällig 20.09.26');
  assert.equal(formatDate('2026-09-07'), '07.09.26');
});

test('Morgen-Uebersicht zeigt ueberfaellig zuerst, dann heute', () => {
  const heute = '2026-09-07';
  const board = sanitizeBoard({ tasks: [
    mk('heute', { due: heute }, 1),
    mk('spaeter', { due: '2026-10-01' }, 2),
    mk('alt', { due: '2026-09-02' }, 3),
    mk('fertig', { due: '2026-09-01', status: 'erledigt' }, 4),
    { ...mk('weg', { due: '2026-09-01' }, 5), archived: true },
  ] });
  assert.deepEqual(dueOverview(board, heute).map((t) => t.title), ['alt', 'heute']);
});

/* ---------------- Links ---------------- */

test('linkLabel bildet eine lesbare Kurzform', () => {
  assert.equal(linkLabel('https://www.example.com/auftraege/mein-auftrag.pdf'), 'example.com · mein auftrag');
  assert.equal(linkLabel('https://example.com'), 'example.com');
  assert.equal(linkLabel('https://example.com/x', 'Angebot Meier'), 'Angebot Meier');
  assert.equal(linkLabel(''), '');
});

test('zwei getrennte Links werden gespeichert', () => {
  const t = createTask({ title: 'A', url: 'example.com/a', url2: 'example.com/ordner' });
  assert.equal(t.url, 'https://example.com/a');
  assert.equal(t.url2, 'https://example.com/ordner');
});

/* ---------------- Kommentare ---------------- */

test('Kommentare werden angehaengt, nie ersetzt', () => {
  let t = createTask({ title: 'A' });
  t = addComment(t, { author: 'Kollege', text: 'Erster' });
  t = addComment(t, { author: 'JAHVIS', text: 'Zweiter' });
  assert.deepEqual(t.comments.map((c) => c.text), ['Erster', 'Zweiter']);
  assert.equal(t.comments[0].author, 'Kollege');
});

test('Kommentare in derselben Millisekunde behalten ihre Reihenfolge', () => {
  const gleich = '2026-05-01T10:00:00.000Z';
  let t = createTask({ title: 'A' });
  t = addComment(t, { author: 'X', text: 'Erster', at: gleich });
  t = addComment(t, { author: 'X', text: 'Zweiter', at: gleich });
  t = addComment(t, { author: 'X', text: 'Dritter', at: gleich });
  assert.deepEqual(t.comments.map((c) => c.text), ['Erster', 'Zweiter', 'Dritter']);
  assert.ok(t.comments[0].at < t.comments[1].at && t.comments[1].at < t.comments[2].at);
});

test('leere Kommentare werden verworfen', () => {
  const t = addComment(createTask({ title: 'A' }), { author: 'X', text: '   ' });
  assert.equal(t.comments.length, 0);
});

test('alte Notiz wird zum ersten Kommentar – und zwar immer gleich', () => {
  const alt = {
    id: 'a1', title: 'Alt', note: 'Warte auf Freigabe', author: 'Kollege',
    status: 'offen', createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
  };
  const eins = sanitizeBoard({ tasks: [alt] }).tasks[0];
  const zwei = sanitizeBoard({ tasks: [alt] }).tasks[0];
  assert.equal(eins.comments.length, 1);
  assert.equal(eins.comments[0].text, 'Warte auf Freigabe');
  assert.equal(eins.comments[0].author, 'Kollege');
  assert.equal(eins.comments[0].id, 'a1-notiz');
  assert.deepEqual(eins, zwei, 'zweimal aufbereiten muss dasselbe ergeben');
  assert.equal('note' in eins, false, 'das alte Feld wird nicht weitergeschleppt');
});

test('vorhandene Kommentare verdraengen die Notiz-Wanderung', () => {
  const t = sanitizeBoard({ tasks: [{
    id: 'a1', title: 'A', note: 'alt', createdAt: '2026-01-01T00:00:00.000Z',
    comments: [{ id: 'c1', author: 'X', text: 'schon da', at: '2026-01-02T00:00:00.000Z' }],
  }] }).tasks[0];
  assert.deepEqual(t.comments.map((c) => c.text), ['schon da']);
});

test('gleichzeitige Kommentare gehen beim Zusammenfuehren nicht verloren', () => {
  const basis = createTask({ title: 'A' });
  const remote = { tasks: [{ ...basis, updatedAt: '2026-02-01T09:00:00.000Z',
    comments: [{ id: 'c-remote', author: 'Kollege', text: 'von drüben', at: '2026-02-01T09:00:00.000Z' }] }] };
  const local = { tasks: [{ ...basis, updatedAt: '2026-02-01T09:05:00.000Z',
    comments: [{ id: 'c-local', author: 'JAHVIS', text: 'von hier', at: '2026-02-01T09:05:00.000Z' }] }] };
  const zusammen = mergeBoards(remote, local).tasks[0];
  assert.deepEqual(zusammen.comments.map((c) => c.text), ['von drüben', 'von hier']);
});

/* ---------------- Zusammenfuehren ---------------- */

test('merge behaelt Aufgaben beider Seiten', () => {
  const m = mergeBoards({ tasks: [mk('A', {}, 1)] }, { tasks: [mk('B', {}, 2)] });
  assert.equal(m.tasks.length, 2);
});

test('merge nimmt je Aufgabe die neuere Fassung', () => {
  const basis = createTask({ title: 'Alt' });
  const aelter = { tasks: [{ ...basis, title: 'Aelter', updatedAt: '2026-01-01T10:00:00.000Z' }] };
  const neuer = { tasks: [{ ...basis, title: 'Neuer', updatedAt: '2026-01-01T11:00:00.000Z' }] };
  assert.equal(mergeBoards(aelter, neuer).tasks[0].title, 'Neuer');
  assert.equal(mergeBoards(neuer, aelter).tasks[0].title, 'Neuer');
});

test('Archivieren gewinnt bei gleichem Zeitstempel', () => {
  const t = createTask({ title: 'X' });
  const weg = { ...t, archived: true };
  assert.equal(mergeBoards({ tasks: [weg] }, { tasks: [t] }).tasks[0].archived, true);
});

test('alte Loeschmarken werden aufgeraeumt', () => {
  const t = { ...createTask({ title: 'Uralt' }), deleted: true, updatedAt: '2020-01-01T00:00:00.000Z' };
  assert.equal(mergeBoards({ tasks: [t] }, emptyBoard()).tasks.length, 0);
});

test('gespeichert wird unabhaengig von der Ansicht immer gleich sortiert', () => {
  const board = { tasks: [mk('h', { priority: 'hoch' }, 9), mk('n', { priority: 'niedrig' }, 1)] };
  assert.deepEqual(mergeBoards(emptyBoard(), board).tasks.map((t) => t.title), ['n', 'h']);
});

/* ---------------- Aktivitaet ---------------- */

test('Aktivitaet wird lesbar formuliert', () => {
  const t = mk('Angebot Meier');
  assert.equal(activityText(makeActivity('angelegt', t, 'Kollege')), 'Kollege hat angelegt: Angebot Meier');
  assert.equal(activityText(makeActivity('erledigt', t, 'JAHVIS')), 'JAHVIS hat erledigt: Angebot Meier');
});

test('Aktivitaet wird zusammengefuehrt, sortiert und gekappt', () => {
  const eintrag = (i, at) => ({ id: 'e' + i, at, actor: 'X', kind: 'angelegt', taskId: 't', title: 'T' });
  const viele = Array.from({ length: 80 }, (_, i) =>
    eintrag(i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
  const m = mergeBoards({ activity: viele.slice(0, 50) }, { activity: viele.slice(40) });
  assert.equal(m.activity.length, 60, 'auf 60 Einträge begrenzt');
  assert.equal(m.activity[0].id, 'e79', 'neueste zuerst');
  assert.ok(m.activity[0].at > m.activity[1].at);
});

test('Verlauf zeigt auch Aufgaben von vor dieser Erweiterung', () => {
  // So sieht eine Pinnwand aus, die es vor dem Ereignisprotokoll schon gab:
  // Aufgaben und Notizen sind da, aufgezeichnete Ereignisse gibt es keine.
  const board = sanitizeBoard({
    activity: [],
    tasks: [
      { id: 't1', title: 'Rechnung prüfen', author: 'Kollege', note: 'Beleg fehlt',
        createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z' },
      { id: 't2', title: 'Angebot schreiben', author: 'JAHVIS',
        createdAt: '2026-01-03T09:00:00.000Z', updatedAt: '2026-01-03T09:00:00.000Z' },
    ],
  });
  const verlauf = activityFeed(board);
  assert.deepEqual(verlauf.map(activityText), [
    'JAHVIS hat angelegt: Angebot schreiben',
    'Kollege hat kommentiert: Rechnung prüfen',
    'Kollege hat angelegt: Rechnung prüfen',
  ]);
});

test('Verlauf zaehlt aufgezeichnete Ereignisse nicht doppelt', () => {
  // Der aufgezeichnete Zeitstempel weicht um Millisekunden vom Anlagezeitpunkt
  // ab – gezaehlt wird deshalb je Aufgabe und Art, nicht nach Uhrzeit.
  const board = sanitizeBoard({
    tasks: [{ id: 't1', title: 'A', author: 'Kollege', createdAt: '2026-01-02T09:00:00.000Z',
      comments: [
        { id: 'c1', author: 'Kollege', text: 'alt', at: '2026-01-02T10:00:00.000Z' },
        { id: 'c2', author: 'JAHVIS', text: 'neu', at: '2026-01-02T11:00:00.000Z' },
      ] }],
    activity: [
      { id: 'e1', at: '2026-01-02T09:00:00.417Z', actor: 'Kollege', kind: 'angelegt', taskId: 't1', title: 'A' },
      { id: 'e2', at: '2026-01-02T11:00:00.812Z', actor: 'JAHVIS', kind: 'kommentiert', taskId: 't1', title: 'A' },
    ],
  });
  const verlauf = activityFeed(board);
  assert.equal(verlauf.length, 3, 'zwei aufgezeichnete plus der eine unbekannte Kommentar');
  assert.deepEqual(verlauf.map((e) => e.id), ['e2', 'abgeleitet-c1', 'e1']);
});

test('Verlauf laesst Geloeschtes weg und haelt die Obergrenze ein', () => {
  const board = sanitizeBoard({
    activity: [],
    tasks: [
      { id: 'weg', title: 'Geloescht', author: 'X', deleted: true, createdAt: '2026-01-01T09:00:00.000Z' },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: 't' + i, title: 'T' + i, author: 'X',
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
      })),
    ],
  });
  const verlauf = activityFeed(board, 5);
  assert.equal(verlauf.length, 5);
  assert.equal(verlauf[0].title, 'T29', 'neueste zuerst');
  assert.equal(verlauf.some((e) => e.title === 'Geloescht'), false);
});

test('neue Aktivitaet anderer wird als ungelesen erkannt', () => {
  const board = { activity: [
    { id: 'a', at: '2026-05-02T10:00:00.000Z', actor: 'Kollege', kind: 'angelegt', taskId: 't1', title: 'T' },
    { id: 'b', at: '2026-05-02T10:00:00.000Z', actor: 'JAHVIS', kind: 'angelegt', taskId: 't2', title: 'T' },
    { id: 'c', at: '2026-05-01T10:00:00.000Z', actor: 'Kollege', kind: 'angelegt', taskId: 't3', title: 'T' },
  ] };
  const neu = unseenActivity(board, { since: '2026-05-02T00:00:00.000Z', me: 'JAHVIS' });
  assert.deepEqual(neu.map((e) => e.id), ['a'], 'eigene und alte Einträge zählen nicht');
  assert.deepEqual(unseenActivity(board, { since: '', me: 'JAHVIS' }), [], 'ohne Anker gilt nichts als neu');
});

/* ---------------- Sortieren, Filtern, Suchen ---------------- */

test('nach Wichtigkeit: Hoch vor Mittel vor Niedrig', () => {
  const tasks = [mk('n', { priority: 'niedrig' }, 1), mk('m', {}, 2), mk('h', { priority: 'hoch' }, 3)];
  assert.deepEqual(sortTasks(tasks, 'wichtigkeit').map((t) => t.title), ['h', 'm', 'n']);
});

test('innerhalb einer Wichtigkeit zaehlt die Reihenfolge von Hand', () => {
  const a = mk('a', { priority: 'hoch' }, 1);
  const b = mk('b', { priority: 'hoch' }, 2);
  assert.deepEqual(sortTasks([b, a], 'wichtigkeit').map((t) => t.title), ['a', 'b']);
  assert.deepEqual(sortTasks([{ ...a, order: 9 }, b], 'wichtigkeit').map((t) => t.title), ['b', 'a']);
});

test('nach Datum bleibt die Wichtigkeit unberuecksichtigt', () => {
  const tasks = [mk('h', { priority: 'hoch' }, 9), mk('n', { priority: 'niedrig' }, 1)];
  assert.deepEqual(sortTasks(tasks, 'datum').map((t) => t.title), ['n', 'h']);
});

test('erledigte Aufgaben stehen zuletzt erledigt zuerst', () => {
  const a = { ...mk('a', { status: 'erledigt' }, 1), doneAt: '2026-01-01T00:00:00.000Z' };
  const b = { ...mk('b', { status: 'erledigt' }, 2), doneAt: '2026-03-01T00:00:00.000Z' };
  assert.deepEqual(sortTasks([a, b], 'wichtigkeit').map((t) => t.title), ['b', 'a']);
});

test('Statusfilter und Wichtigkeitsfilter greifen zusammen', () => {
  const board = sanitizeBoard({ tasks: [
    mk('offen-hoch', { priority: 'hoch' }, 1),
    mk('offen-mittel', {}, 2),
    mk('dran-hoch', { priority: 'hoch', status: 'dran' }, 3),
  ] });
  assert.deepEqual(selectTasks(board, { status: 'offen', priority: 'hoch' }).map((t) => t.title), ['offen-hoch']);
  assert.deepEqual(selectTasks(board, { status: 'offen', priority: 'alle' }).map((t) => t.title),
    ['offen-hoch', 'offen-mittel']);
  assert.deepEqual(selectTasks(board, { status: 'dran', priority: 'hoch' }).map((t) => t.title), ['dran-hoch']);
  assert.equal(selectTasks(board, { status: 'dran', priority: 'niedrig' }).length, 0);
});

test('Suche greift auf Titel, Links und Kommentare zu', () => {
  const t = addComment(mk('Angebot Meier', { url: 'https://example.com/preisliste' }), {
    author: 'Kollege', text: 'Freigabe vom Chef fehlt',
  });
  assert.equal(matchesQuery(t, 'meier'), true);
  assert.equal(matchesQuery(t, 'preisliste'), true);
  assert.equal(matchesQuery(t, 'freigabe chef'), true, 'mehrere Wörter müssen alle passen');
  assert.equal(matchesQuery(t, 'rechnung'), false);
  assert.equal(matchesQuery(t, '   '), true, 'leere Suche filtert nicht');
});

test('Archiviertes verschwindet aus den Spalten und taucht im Archiv auf', () => {
  const board = sanitizeBoard({ tasks: [
    mk('sichtbar', {}, 1),
    { ...mk('weggelegt', {}, 2), archived: true },
    { ...mk('geloescht', {}, 3), deleted: true },
  ] });
  assert.deepEqual(selectTasks(board, { status: 'offen' }).map((t) => t.title), ['sichtbar']);
  assert.deepEqual(archivedTasks(board).map((t) => t.title), ['weggelegt']);
  assert.equal(archivedTasks(board, { query: 'sichtbar' }).length, 0);
});

/* ---------------- Reihenfolge von Hand ---------------- */

test('orderBetween trifft die Mitte und haelt die Enden frei', () => {
  assert.equal(orderBetween(10, 20), 15);
  assert.equal(orderBetween(undefined, 20), -980);
  assert.equal(orderBetween(10, undefined), 1010);
  assert.ok(Number.isFinite(orderBetween(undefined, undefined)));
});

test('orderForIndex schiebt eine Aufgabe an die gewuenschte Stelle', () => {
  const liste = [mk('a', {}, 10), mk('b', {}, 20), mk('c', {}, 30)];
  const nachOben = orderForIndex(liste, liste[2].id, 0);
  assert.ok(nachOben < 10, 'ganz nach oben');
  const inDieMitte = orderForIndex(liste, liste[0].id, 1);
  assert.ok(inDieMitte > 20 && inDieMitte < 30, 'zwischen b und c');
  const nachUnten = orderForIndex(liste, liste[0].id, 2);
  assert.ok(nachUnten > 30, 'ganz nach unten');
});

test('touch aktualisiert updatedAt und laesst die Aufgabe heil', () => {
  const t = { ...createTask({ title: 'T' }), updatedAt: '2020-01-01T00:00:00.000Z' };
  const n = touch(t, { title: 'U' });
  assert.ok(n.updatedAt > t.updatedAt);
  assert.equal(n.title, 'U');
  assert.equal(n.id, t.id);
});

test('sanitizeBoard repariert kaputte Daten', () => {
  const s = sanitizeBoard({ tasks: [null, { id: 'x' }, { id: 'x', title: 'doppelt' }, { id: 'y', status: 'quatsch' }] });
  assert.equal(s.tasks.length, 2);
  assert.equal(s.tasks[0].title, '');
  assert.equal(s.tasks[1].status, 'offen');
  assert.deepEqual(s.activity, []);
});

console.log(`\n${passed} Tests bestanden.`);
