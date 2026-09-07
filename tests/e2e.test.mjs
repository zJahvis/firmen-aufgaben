// Oberflaechentest: startet die echte Seite in Chromium und ersetzt nur
// die GitHub-API durch einen Speicher im Arbeitsspeicher.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sealJson } from '../assets/crypto.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '246810';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ok  ' + name);
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  try {
    const buf = await readFile(path.join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('nicht gefunden');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- Attrappe der GitHub Contents API -------------------------------------
const fake = { file: null, sha: null, writes: 0 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function installFakeGithub(page) {
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      if (fake.file === null) return route.fulfill({ status: 404, body: '{"message":"Not Found"}' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: b64(fake.file), sha: fake.sha, encoding: 'base64' }),
      });
    }
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      fake.file = Buffer.from(body.content, 'base64').toString('utf8');
      fake.sha = 'sha-' + ++fake.writes;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ content: { sha: fake.sha } }),
      });
    }
    return route.fulfill({ status: 405, body: '{}' });
  });
}

async function waitFor(cond, was, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Zeitueberschreitung beim Warten auf: ' + was);
}

const board = () => JSON.parse(fake.file || '{"tasks":[],"activity":[]}');
const titled = (t) => board().tasks.find((x) => x.title === t);
const titles = (page, stack) => page.locator(`[data-stack="${stack}"] .card h3`).allTextContents();
const karte = (page, stack, teil) =>
  page.locator(`[data-stack="${stack}"] .card`).filter({ hasText: teil });

/** Schreibt direkt in die Attrappe – simuliert den Kollegen am anderen Gerät. */
function setRemote(mutate) {
  const data = board();
  mutate(data);
  fake.file = JSON.stringify(data);
  fake.sha = 'sha-fremd-' + Math.random().toString(36).slice(2);
}

const heute = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });

try {
  console.log('Oberflaeche (Chromium)');
  const sealed = await sealJson(PIN, {
    owner: 'testfirma', repo: 'aufgaben-daten', path: 'board.json', branch: 'main', token: 'github_pat_test',
  });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // Handyformat
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error('  JS-Fehler:', e.message); process.exitCode = 1; });
  await installFakeGithub(page);

  await step('Zugangslink oeffnet die PIN-Abfrage', async () => {
    await page.goto(`${base}/index.html#c=${sealed}`);
    await page.waitForSelector('#pin-input');
    assert.equal(await page.locator('#gate-sub').textContent(), 'Bitte PIN eingeben');
    assert.equal(new URL(page.url()).hash, '', 'Das Chiffrat muss aus der Adresszeile verschwinden');
  });

  await step('falsche PIN wird abgewiesen', async () => {
    await page.fill('#pin-input', '111111');
    await page.click('#pin-submit');
    await page.waitForFunction(() => document.querySelector('#pin-error').textContent.length > 0);
    assert.ok(await page.locator('#app').isHidden());
  });

  await step('richtige PIN oeffnet die Pinnwand', async () => {
    await page.fill('#pin-input', PIN);
    await page.click('#pin-submit');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await page.locator('#who-dialog button[value="JAHVIS"]').click();
    await page.waitForFunction(() => document.querySelector('#who-chip').textContent.includes('JAHVIS'));
    await waitFor(() => fake.file !== null, 'Anlegen von board.json');
  });

  await step('Morgen-Uebersicht und Aktivitaet sind auch auf einer leeren Pinnwand da', async () => {
    await page.waitForSelector('#overview', { state: 'visible' });
    assert.equal(await page.locator('#overview-title').textContent(), 'Morgen-Übersicht');
    assert.equal(await page.locator('#overview-count').textContent(), '0');
    assert.match(await page.locator('#overview-empty-text').textContent(), /noch keine Aufgabe hat eine Frist/i);
    assert.ok(await page.locator('#overview-set-due').isVisible(), 'Weg zur Frist wird angeboten');

    await page.waitForSelector('#activity', { state: 'visible' });
    assert.equal(await page.locator('#activity-title').textContent(), 'Aktivität');
    assert.ok(await page.locator('#activity-details').evaluate((el) => el.open), 'aufgeklappt statt zugeklappt');
    assert.ok(await page.locator('#activity-empty').isVisible());
  });

  await step('„Frist eintragen" klappt die weiteren Angaben auf', async () => {
    assert.equal(await page.locator('#new-more').evaluate((el) => el.open), false);
    await page.click('#overview-set-due');
    await page.waitForFunction(() => document.querySelector('#new-more').open);
    assert.ok(await page.locator('#new-due').isVisible());
    // wieder zuklappen, damit die folgenden Schritte den normalen Weg gehen
    await page.locator('#new-more').evaluate((el) => { el.open = false; });
  });

  await step('Aufgabe anlegen: Mittel, JAHVIS zustaendig, Eintrag in der Aktivitaet', async () => {
    await page.fill('#new-title', 'Angebot für Meier schreiben');
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Angebot für Meier schreiben'), 'Speichern der neuen Aufgabe');
    const t = titled('Angebot für Meier schreiben');
    assert.equal(t.priority, 'mittel');
    assert.equal(t.assignee, 'JAHVIS');
    assert.equal(t.author, 'JAHVIS');
    assert.equal(t.status, 'offen');
    assert.deepEqual(t.comments, []);
    assert.equal(await page.locator('[data-stack="offen"] .card .prio').textContent(), 'Mittel');
    assert.match(
      await karte(page, 'offen', 'Angebot für Meier').locator('.assignee').textContent(),
      /Zuständig: JAHVIS/
    );
    const eintrag = board().activity[0];
    assert.equal(eintrag.kind, 'angelegt');
    assert.equal(eintrag.actor, 'JAHVIS');
    await page.waitForFunction(() => document.querySelector('#activity-count').textContent === '1');
    assert.ok(await page.locator('#activity-empty').isHidden());
    assert.match(await page.locator('#activity-list li .activity-text').first().textContent(),
      /JAHVIS hat angelegt: Angebot für Meier schreiben/);
  });

  await step('Weitere Angaben: zwei getrennte Links und eine Frist', async () => {
    await page.fill('#new-title', 'Preisliste verschicken');
    await page.locator('#new-more summary').click();
    await page.fill('#new-url', 'example.com/preisliste.pdf');
    await page.fill('#new-url2', 'example.com/ablage/2026');
    await page.fill('#new-due', '2020-01-15');
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Preisliste verschicken'), 'Speichern mit Links und Frist');
    const t = titled('Preisliste verschicken');
    assert.equal(t.url, 'https://example.com/preisliste.pdf');
    assert.equal(t.url2, 'https://example.com/ablage/2026');
    assert.equal(t.due, '2020-01-15');

    const karteEl = karte(page, 'offen', 'Preisliste verschicken');
    assert.equal(await karteEl.locator('.links .link').count(), 2, 'beide Links stehen getrennt auf der Karte');
    assert.equal(await karteEl.locator('.links .link').first().locator('.link-text').textContent(),
      'example.com · preisliste', 'Kurzform statt roher Adresse');
  });

  await step('abgelaufene Frist wird als ueberfaellig markiert', async () => {
    const karteEl = karte(page, 'offen', 'Preisliste verschicken');
    assert.match(await karteEl.locator('.due-ueberfaellig').textContent(), /überfällig/);
  });

  await step('Morgen-Uebersicht zeigt Ueberfaelliges oben', async () => {
    await page.waitForFunction(() => document.querySelector('#overview-count').textContent === '1');
    assert.match(await page.locator('#due-list .due-title').first().textContent(), /Preisliste/);
    await page.fill('#new-title', 'Heute anrufen');
    await page.fill('#new-due', heute);
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Heute anrufen'), 'Aufgabe mit heutiger Frist');
    await page.waitForFunction(() => document.querySelectorAll('#due-list li').length === 2);
    assert.deepEqual(await page.locator('#due-list .due-title').allTextContents(),
      ['Preisliste verschicken', 'Heute anrufen'], 'überfällig vor heute');
    await page.fill('#new-due', '');
  });

  await step('Wichtigkeit beim Anlegen und Sortierung', async () => {
    await page.fill('#new-title', 'Werkzeug bestellen');
    await page.locator('label[for="new-prio-hoch"]').click();
    await page.click('#new-form button[type=submit]');
    await waitFor(() => titled('Werkzeug bestellen')?.priority === 'hoch', 'Hoch speichern');
    assert.equal((await titles(page, 'offen'))[0], 'Werkzeug bestellen', 'Hoch steht oben');

    await page.locator('label[for="sort-datum"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-stack="offen"] .card h3').textContent.startsWith('Angebot'));
    assert.equal((await titles(page, 'offen'))[0], 'Angebot für Meier schreiben', 'nach Datum: Anlagereihenfolge');
    await page.locator('label[for="sort-wichtigkeit"]').click();
  });

  await step('Filter Wichtigkeit mal Status', async () => {
    await page.locator('label[for="filter-prio-hoch"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .card').length === 1);
    assert.deepEqual(await titles(page, 'offen'), ['Werkzeug bestellen']);
    assert.equal(await page.locator('.column[data-col="dran"] .empty').textContent(), 'Nichts gefunden.');
    await page.locator('label[for="filter-prio-alle"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .card').length === 4);
  });

  await step('Suche findet ueber Titel und Kommentare', async () => {
    await page.fill('#search', 'werkzeug');
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .card').length === 1);
    assert.deepEqual(await titles(page, 'offen'), ['Werkzeug bestellen']);
    await page.click('#search-clear');
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .card').length === 4);
  });

  await step('Kommentare haengen sich an und sind durchsuchbar', async () => {
    await karte(page, 'offen', 'Angebot für Meier').locator('button', { hasText: 'Kommentare' }).click();
    await page.waitForSelector('#comments-dialog[open]');
    assert.equal(await page.locator('#thread .empty').textContent(), 'Noch keine Kommentare.');
    await page.fill('#comment-text', 'Warte auf die Freigabe vom Chef');
    await page.click('#comment-save');
    await waitFor(() => titled('Angebot für Meier schreiben')?.comments.length === 1, 'Kommentar speichern');
    await page.fill('#comment-text', 'Freigabe ist da');
    await page.click('#comment-save');
    await waitFor(() => titled('Angebot für Meier schreiben')?.comments.length === 2, 'zweiter Kommentar');
    assert.equal(await page.locator('#thread li').count(), 2, 'der Verlauf wächst, er wird nicht ersetzt');
    await page.click('#comments-close');

    const karteEl = karte(page, 'offen', 'Angebot für Meier');
    assert.match(await karteEl.locator('.note-text').textContent(), /Freigabe ist da/);
    await page.fill('#search', 'chef');
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .card').length === 1);
    assert.deepEqual(await titles(page, 'offen'), ['Angebot für Meier schreiben']);
    await page.click('#search-clear');
  });

  await step('Zustaendigkeit laesst sich auf der Karte weiterschalten', async () => {
    const chip = karte(page, 'offen', 'Werkzeug bestellen').locator('.assignee');
    await chip.click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === 'Kollege', 'Wechsel auf Kollege');
    assert.match(await chip.textContent(), /Zuständig: Kollege/);
    await chip.click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === '', 'Wechsel auf Offen');
    assert.match(await chip.textContent(), /Zuständig: Offen/);
  });

  await step('Reihenfolge innerhalb einer Wichtigkeit mit den Pfeilen', async () => {
    await page.fill('#new-title', 'Zweite hohe Aufgabe');
    await page.locator('label[for="new-prio-hoch"]').click();
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Zweite hohe Aufgabe'), 'zweite hohe Aufgabe');
    assert.deepEqual((await titles(page, 'offen')).slice(0, 2), ['Werkzeug bestellen', 'Zweite hohe Aufgabe']);

    await karte(page, 'offen', 'Zweite hohe Aufgabe').locator('button[title="Eine Position höher"]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-stack="offen"] .card h3').textContent.startsWith('Zweite'));
    assert.deepEqual((await titles(page, 'offen')).slice(0, 2), ['Zweite hohe Aufgabe', 'Werkzeug bestellen']);
    await waitFor(() => titled('Zweite hohe Aufgabe').order < titled('Werkzeug bestellen').order,
      'neue Reihenfolge gespeichert');
  });

  await step('Ziehen und Fallenlassen sortiert dieselbe Wichtigkeit um', async () => {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('[data-stack="offen"] .card')].slice(0, 2).map((c) => c.dataset.id));
    await page.evaluate(([quelle, ziel]) => {
      const src = document.querySelector(`.card[data-id="${quelle}"]`);
      const dst = document.querySelector(`.card[data-id="${ziel}"]`);
      const dt = new DataTransfer();
      const kasten = dst.getBoundingClientRect();
      const unten = kasten.top + kasten.height * 0.8;
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: unten }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: unten }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    }, ids);
    await page.waitForFunction(() =>
      document.querySelector('[data-stack="offen"] .card h3').textContent.startsWith('Werkzeug'));
    assert.deepEqual((await titles(page, 'offen')).slice(0, 2), ['Werkzeug bestellen', 'Zweite hohe Aufgabe']);
  });

  await step('Griff verschwindet, wenn nach Datum sortiert wird', async () => {
    assert.ok(await page.locator('[data-stack="offen"] .card .grip').first().count() > 0);
    await page.locator('label[for="sort-datum"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .grip').length === 0);
    await page.locator('label[for="sort-wichtigkeit"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-stack="offen"] .grip').length > 0);
  });

  await step('Status wechseln schreibt die Aktivitaet mit', async () => {
    await karte(page, 'offen', 'Angebot für Meier').locator('button', { hasText: 'Dran' }).click();
    await waitFor(() => titled('Angebot für Meier schreiben')?.status === 'dran', 'Statuswechsel');
    await page.locator('#tabs button[data-tab="dran"]').click();
    await karte(page, 'dran', 'Angebot für Meier').locator('button', { hasText: 'Erledigt' }).click();
    await waitFor(() => titled('Angebot für Meier schreiben')?.status === 'erledigt', 'erledigt');
    assert.equal(board().activity[0].kind, 'erledigt');
    assert.match(
      await page.locator('#activity-list li .activity-text').first().textContent(),
      /JAHVIS hat erledigt: Angebot für Meier schreiben/
    );
  });

  await step('Erledigt ausblenden raeumt Spalte und Reiter weg', async () => {
    await page.check('#hide-done');
    await page.waitForFunction(() =>
      document.querySelector('#tabs button[data-tab="erledigt"]').classList.contains('is-off'));
    assert.ok(await page.locator('.column[data-col="erledigt"]').isHidden());
    await page.uncheck('#hide-done');
    await page.waitForFunction(() =>
      !document.querySelector('#tabs button[data-tab="erledigt"]').classList.contains('is-off'));
  });

  await step('Archivieren statt loeschen – mit Wiederherstellen', async () => {
    await page.locator('#tabs button[data-tab="offen"]').click();
    await karte(page, 'offen', 'Heute anrufen').locator('button', { hasText: 'Archivieren' }).click();
    await waitFor(() => titled('Heute anrufen')?.archived === true, 'archivieren');
    assert.equal(await karte(page, 'offen', 'Heute anrufen').count(), 0, 'nicht mehr in der Spalte');
    assert.equal(titled('Heute anrufen').deleted, false, 'die Aufgabe bleibt erhalten');

    await page.click('#archive-toggle');
    await page.waitForSelector('#archive:not(.hidden)');
    const imArchiv = karte(page, 'archiv', 'Heute anrufen');
    assert.equal(await imArchiv.count(), 1);
    await imArchiv.locator('button', { hasText: 'Wiederherstellen' }).click();
    await waitFor(() => titled('Heute anrufen')?.archived === false, 'wiederherstellen');
    await page.click('#archive-toggle');
    await page.waitForSelector('#board:not(.hidden)');
    assert.equal(await karte(page, 'offen', 'Heute anrufen').count(), 1);
  });

  await step('alte Notiz des Kollegen wird zum ersten Kommentar', async () => {
    setRemote((data) => {
      data.tasks.push({
        // so sah eine Aufgabe vor dieser Erweiterung aus: nur note, kein comments
        id: 'alt-1', title: 'Rechnung 4711 prüfen', url: '', note: 'Beleg fehlt noch',
        status: 'offen', author: 'Kollege', createdAt: '2026-01-02T08:00:00.000Z',
        updatedAt: '2026-01-02T08:00:00.000Z', doneAt: null, deleted: false,
      });
    });
    await page.waitForSelector('.card[data-id="alt-1"]', { timeout: 20000 });
    const karteEl = page.locator('.card[data-id="alt-1"]');
    assert.match(await karteEl.locator('.note-text').textContent(), /Beleg fehlt noch/);
    assert.match(await karteEl.locator('.prio').textContent(), /Mittel/, 'Wichtigkeit bekommt einen Vorgabewert');
    assert.match(await karteEl.locator('.assignee').textContent(), /Offen/, 'Zuständigkeit bleibt offen');
    assert.match(await karteEl.locator('button', { hasText: 'Kommentare' }).textContent(), /\(1\)/);
  });

  await step('Neues vom Kollegen erscheint als Zaehler und laesst sich abhaken', async () => {
    setRemote((data) => {
      // bewusst in der Zukunft: so sieht es aus, wenn die Uhr des anderen vorgeht
      const jetzt = new Date(Date.now() + 60000).toISOString();
      data.activity.unshift({
        id: 'akt-neu', at: jetzt, actor: 'Kollege', kind: 'angelegt',
        taskId: 'alt-1', title: 'Rechnung 4711 prüfen',
      });
    });
    await page.waitForSelector('#news-chip:not(.hidden)', { timeout: 20000 });
    assert.equal(await page.locator('#news-count').textContent(), '1');
    assert.ok(await page.locator('.card[data-id="alt-1"] .flag-neu').isVisible());
    await page.click('#news-chip');
    await page.waitForFunction(() => document.querySelector('#news-chip').classList.contains('hidden'));
    assert.equal(await page.locator('.card[data-id="alt-1"] .flag-neu').count(), 0);
  });

  await step('nach Neuladen bleibt alles erhalten', async () => {
    await page.reload();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await page.waitForSelector('.card[data-id="alt-1"]');
    assert.equal(await page.locator('#tabs button[data-tab="offen"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('input[name="sort"]:checked').getAttribute('value'), 'wichtigkeit');
  });

  await step('Sperren verlangt wieder die PIN', async () => {
    await page.click('#logout');
    await page.waitForSelector('#pin-input', { timeout: 15000 });
    assert.ok(await page.locator('#app').isHidden());
  });

  await step('Einrichtungsseite ist ohne Zugang erreichbar', async () => {
    const p2 = await ctx.newPage();
    await installFakeGithub(p2);
    await p2.goto(`${base}/setup.html`);
    assert.match(await p2.locator('h1').textContent(), /Einrichtung/);
    await p2.fill('#repo', 'testfirma/aufgaben-daten');
    await p2.fill('#token', 'github_pat_test');
    await p2.fill('#pin', '1234');
    await p2.fill('#pin2', '9999');
    await p2.click('#go');
    assert.match(await p2.locator('#status').textContent(), /nicht gleich/);
    await p2.fill('#pin2', '1234');
    await p2.click('#go');
    await p2.waitForSelector('#result:not(.hidden)', { timeout: 20000 });
    assert.match(await p2.locator('#invite').inputValue(), /index\.html#c=/);
    await p2.close();
  });

  await step('Ansicht am Schreibtisch zeigt alle drei Spalten', async () => {
    const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p3 = await wide.newPage();
    await installFakeGithub(p3);
    await p3.goto(`${base}/index.html#c=${sealed}`);
    await p3.fill('#pin-input', PIN);
    await p3.click('#pin-submit');
    await p3.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await p3.locator('#who-dialog button[value="JAHVIS"]').click();
    await p3.waitForFunction(() => !document.querySelector('#who-dialog').open);
    for (const s of ['offen', 'dran', 'erledigt']) {
      assert.ok(await p3.locator(`[data-col="${s}"]`).isVisible(), s + ' muss sichtbar sein');
    }
    assert.ok(!(await p3.locator('#tabs').isVisible()), 'Reiter sind am Schreibtisch ausgeblendet');
    await p3.check('#hide-done');
    await p3.waitForSelector('.board.two-columns');
    assert.ok(await p3.locator('[data-col="erledigt"]').isHidden(), 'Erledigt ist ausgeblendet');
    await wide.close();
  });

  await step('Pinnwand von vor dieser Erweiterung zeigt trotzdem einen Verlauf', async () => {
    const gesichert = { file: fake.file, sha: fake.sha };
    // Aufgaben und Notizen, aber kein Ereignisprotokoll – genau der gemeldete Fall.
    fake.file = JSON.stringify({
      version: 2,
      tasks: [{
        id: 'alt-99', title: 'Altbestand prüfen', url: '', note: 'Liegt seit Januar',
        status: 'offen', author: 'Kollege', createdAt: '2026-01-02T09:00:00.000Z',
        updatedAt: '2026-01-02T09:00:00.000Z', doneAt: null, deleted: false,
      }],
      activity: [],
    });
    fake.sha = 'sha-altbestand';

    const alt = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const p4 = await alt.newPage();
    await installFakeGithub(p4);
    await p4.goto(`${base}/index.html#c=${sealed}`);
    await p4.fill('#pin-input', PIN);
    await p4.click('#pin-submit');
    await p4.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await p4.locator('#who-dialog button[value="JAHVIS"]').click();

    await p4.waitForFunction(() => document.querySelectorAll('#activity-list li').length === 2);
    const zeilen = await p4.locator('#activity-list .activity-text').allTextContents();
    assert.deepEqual(zeilen, [
      'Kollege hat kommentiert: Altbestand prüfen',
      'Kollege hat angelegt: Altbestand prüfen',
    ], 'der Verlauf wird aus den vorhandenen Daten abgeleitet');
    assert.ok(await p4.locator('#overview').isVisible(), 'die Übersicht bleibt sichtbar');
    assert.match(await p4.locator('#overview-empty-text').textContent(), /noch keine Aufgabe hat eine Frist/i);

    await alt.close();
    fake.file = gesichert.file;
    fake.sha = gesichert.sha;
  });

  console.log(`\n${passed} Oberflaechentests bestanden.`);
} finally {
  await browser.close();
  server.close();
}
