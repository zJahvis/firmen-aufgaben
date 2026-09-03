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

const board = () => JSON.parse(fake.file || '{"tasks":[]}');
const titled = (t) => board().tasks.find((x) => x.title === t);

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
    assert.match(await page.locator('#pin-error').textContent(), /stimmt nicht/);
    assert.ok(await page.locator('#app').isHidden());
  });

  await step('richtige PIN oeffnet die Pinnwand', async () => {
    await page.fill('#pin-input', PIN);
    await page.click('#pin-submit');
    await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await page.locator('#who-dialog button[value="JAHVIS"]').click();
    await page.waitForFunction(() => document.querySelector('#who-chip').textContent === 'JAHVIS');
  });

  await step('leere Pinnwand wird angelegt', async () => {
    await waitFor(() => fake.file !== null, 'Anlegen von board.json');
    assert.ok(fake.file, 'board.json muss serverseitig angelegt worden sein');
    assert.deepEqual(board().tasks, []);
  });

  await step('Aufgabe anlegen landet in Offen und wird gespeichert', async () => {
    await page.fill('#new-title', 'Angebot für Meier schreiben');
    await page.fill('#new-url', 'example.com/auftrag/17');
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Angebot für Meier schreiben'), 'Speichern der neuen Aufgabe');
    assert.equal(await page.locator('[data-stack="offen"] .card').count(), 1);
    assert.equal(await page.locator('.column-head .count[data-count="offen"]').textContent(), '1');
    const t = titled('Angebot für Meier schreiben');
    assert.ok(t, 'Aufgabe muss serverseitig liegen');
    assert.equal(t.url, 'https://example.com/auftrag/17');
    assert.equal(t.status, 'offen');
    assert.equal(t.author, 'JAHVIS');
  });

  await step('Link wird als anklickbarer Link dargestellt', async () => {
    const a = page.locator('[data-stack="offen"] .card a.link');
    assert.equal(await a.getAttribute('href'), 'https://example.com/auftrag/17');
    assert.equal(await a.getAttribute('rel'), 'noopener noreferrer');
  });

  await step('Verschieben nach Dran', async () => {
    await page.locator('[data-stack="offen"] .card button', { hasText: 'Dran' }).click();
    await waitFor(() => titled('Angebot für Meier schreiben')?.status === 'dran', 'Statuswechsel nach dran');
    assert.equal(titled('Angebot für Meier schreiben').status, 'dran');
    await page.locator('#tabs button[data-tab="dran"]').click();
    assert.equal(await page.locator('[data-stack="dran"] .card').count(), 1);
  });

  await step('Notiz hinzufuegen', async () => {
    await page.locator('[data-stack="dran"] .card button', { hasText: 'Notiz' }).click();
    await page.fill('#edit-note', 'Preisliste 2026 abgewartet, Rest steht.');
    await page.locator('#edit-save').click();
    await waitFor(() => (titled('Angebot für Meier schreiben')?.note || '').includes('Preisliste'), 'Speichern der Notiz');
    await page.waitForSelector('[data-stack="dran"] .card .note');
    assert.equal(titled('Angebot für Meier schreiben').note, 'Preisliste 2026 abgewartet, Rest steht.');
    assert.match(await page.locator('[data-stack="dran"] .card .note').textContent(), /Preisliste/);
  });

  await step('Als erledigt markieren', async () => {
    await page.locator('[data-stack="dran"] .card button', { hasText: 'Erledigt' }).click();
    await waitFor(() => titled('Angebot für Meier schreiben')?.status === 'erledigt', 'Statuswechsel nach erledigt');
    const t = titled('Angebot für Meier schreiben');
    assert.equal(t.status, 'erledigt');
    assert.ok(t.doneAt);
  });

  await step('Aenderung des Kollegen erscheint beim naechsten Abgleich', async () => {
    const data = board();
    data.tasks.push({
      id: 'fremd-1', title: 'Rechnung 4711 prüfen', url: '', note: '', status: 'offen',
      author: 'Kollege', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      doneAt: null, deleted: false,
    });
    fake.file = JSON.stringify(data);
    fake.sha = 'sha-fremd';
    await page.locator('#tabs button[data-tab="offen"]').click();
    await page.waitForSelector('[data-stack="offen"] .card', { timeout: 20000 });
    assert.match(await page.locator('[data-stack="offen"] .card h3').textContent(), /Rechnung 4711/);
  });

  await step('nach Neuladen bleibt man angemeldet und sieht denselben Stand', async () => {
    await page.reload();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await page.locator('#tabs button[data-tab="erledigt"]').click();
    assert.equal(await page.locator('[data-stack="erledigt"] .card').count(), 1);
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
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p3 = await wide.newPage();
    await installFakeGithub(p3);
    await p3.goto(`${base}/index.html#c=${sealed}`);
    await p3.fill('#pin-input', PIN);
    await p3.click('#pin-submit');
    await p3.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    for (const s of ['offen', 'dran', 'erledigt']) {
      assert.ok(await p3.locator(`[data-col="${s}"]`).isVisible(), s + ' muss sichtbar sein');
    }
    assert.ok(!(await p3.locator('#tabs').isVisible()), 'Reiter sind am Schreibtisch ausgeblendet');
    await wide.close();
  });

  console.log(`\n${passed} Oberflaechentests bestanden.`);
} finally {
  await browser.close();
  server.close();
}
