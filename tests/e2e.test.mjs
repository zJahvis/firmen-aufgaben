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
const fake = { file: null, sha: null, writes: 0, files: new Map() };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** Weitere Dateien neben board.json – die Bilder. */
async function fakeOtherFile(route, req, pfad) {
  const datei = fake.files.get(pfad);
  if (req.method() === 'PUT') {
    const body = JSON.parse(req.postData() || '{}');
    if (datei && body.sha !== datei.sha) return route.fulfill({ status: 422, body: '{}' });
    const neu = { bytes: Buffer.from(body.content, 'base64'), sha: 'sha-' + ++fake.writes };
    fake.files.set(pfad, neu);
    return route.fulfill({ status: 201, contentType: 'application/json',
      body: JSON.stringify({ content: { sha: neu.sha } }) });
  }
  if (!datei) return route.fulfill({ status: 404, body: '{"message":"Not Found"}' });
  if (req.method() === 'GET') {
    if ((req.headers().accept || '').includes('raw')) {
      // so wie GitHub: kein Bildtyp, nur „raw"
      return route.fulfill({ status: 200, contentType: 'application/vnd.github.raw', body: datei.bytes });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ sha: datei.sha, content: datei.bytes.toString('base64') }) });
  }
  if (req.method() === 'DELETE') {
    const body = JSON.parse(req.postData() || '{}');
    if (body.sha !== datei.sha) return route.fulfill({ status: 409, body: '{}' });
    fake.files.delete(pfad);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }
  return route.fulfill({ status: 405, body: '{}' });
}

async function installFakeGithub(page) {
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const pfad = decodeURIComponent(new URL(req.url()).pathname.split('/contents/')[1] || '');
    if (pfad && pfad !== 'board.json') return fakeOtherFile(route, req, pfad);
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

/** Schreibt direkt in die Attrappe – simuliert Alex, Aaron oder Joe am anderen Gerät. */
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

    // Alle vier Personen stehen zur Wahl – und jede kann sich anmelden.
    assert.deepEqual(
      await page.locator('#who-dialog button').evaluateAll(
        (els) => els
          .map((el) => ({ text: el.textContent, y: el.getBoundingClientRect().top }))
          .sort((a, b) => a.y - b.y)
          .map((e) => e.text)),
      ['Ich bin JAHVIS', 'Ich bin Alex', 'Ich bin Aaron', 'Ich bin Joe'],
      'auch hier zaehlt die sichtbare Reihenfolge');
    await page.locator('#who-dialog button[value="Joe"]').click();
    await page.waitForFunction(() => document.querySelector('#who-chip').textContent.includes('Joe'));
    assert.equal(await page.evaluate(() => localStorage.getItem('fa.me')), 'Joe');

    await page.locator('#who-chip').click();
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

  await step('Aufgabe anlegen: Mittel, noch niemandem zugeteilt, Eintrag in der Aktivitaet', async () => {
    await page.fill('#new-title', 'Angebot für Meier schreiben');
    await page.click('#new-form button[type=submit]');
    await waitFor(() => !!titled('Angebot für Meier schreiben'), 'Speichern der neuen Aufgabe');
    const t = titled('Angebot für Meier schreiben');
    assert.equal(t.priority, 'mittel');
    assert.equal(t.assignee, '', 'neue Aufgaben gehoeren zunaechst niemandem');
    assert.equal(t.author, 'JAHVIS');
    assert.equal(t.status, 'offen');
    assert.deepEqual(t.comments, []);
    assert.equal(await page.locator('[data-stack="offen"] .card .prio').textContent(), 'Mittel');
    assert.match(
      await karte(page, 'offen', 'Angebot für Meier').locator('.assignee').textContent(),
      /Zuständig: Offen/
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

  await step('Zustaendigkeit laesst sich ueber das Menue setzen', async () => {
    const chip = karte(page, 'offen', 'Werkzeug bestellen').locator('.assignee');
    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    assert.equal(await page.locator('#assignee-task').textContent(), 'Werkzeug bestellen');
    // Alle vier Personen plus "niemand" stehen zur Wahl.
    assert.equal(await page.locator('#assignee-choices button').count(), 5);

    // Sichtbare Reihenfolge, nicht nur die im Dokument: .dlg-actions dreht auf
    // dem Telefon die Reihenfolge um, was bei einer Personenliste falsch waere.
    const reihenfolge = await page.locator('#assignee-choices button').evaluateAll(
      (els) => els
        .map((el) => ({ text: el.textContent, y: el.getBoundingClientRect().top }))
        .sort((a, b) => a.y - b.y)
        .map((e) => e.text));
    assert.deepEqual(reihenfolge, ['JAHVIS', 'Alex', 'Aaron', 'Joe', 'Niemand (offen)'],
      'von oben nach unten wie in ASSIGNEE_CHOICES');

    await page.locator('#assignee-choices button[value="Aaron"]').click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === 'Aaron', 'Wechsel auf Aaron');
    assert.match(await chip.textContent(), /Zuständig: Aaron/);

    // Abbrechen mit Escape darf die Zustaendigkeit nicht stillschweigend loeschen:
    // ein leerer Rueckgabewert bedeutet Abbruch, nicht "niemand".
    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#assignee-dialog').open);
    assert.equal(titled('Werkzeug bestellen').assignee, 'Aaron', 'Escape darf nichts aendern');

    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    await page.locator('#assignee-choices button[value="__offen"]').click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === '', 'Wechsel auf Offen');
    assert.match(await chip.textContent(), /Zuständig: Offen/);
  });

  await step('Zustaendigkeitsfilter blendet fremde Aufgaben aus', async () => {
    const chip = karte(page, 'offen', 'Werkzeug bestellen').locator('.assignee');
    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    await page.locator('#assignee-choices button[value="Alex"]').click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === 'Alex', 'auf Alex setzen');

    await page.locator('label[for="filter-assignee-alex"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-stack="offen"] .card').length === 1);
    assert.deepEqual(await titles(page, 'offen'), ['Werkzeug bestellen']);

    await page.locator('label[for="filter-assignee-aaron"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-stack="offen"] .card').length === 0);

    await page.locator('label[for="filter-assignee-joe"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-stack="offen"] .card').length === 0);

    await page.locator('label[for="filter-assignee-alle"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-stack="offen"] .card').length > 1);

    // zuruecksetzen, damit die folgenden Schritte alles sehen
    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    await page.locator('#assignee-choices button[value="__offen"]').click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === '', 'zuruecksetzen');
  });

  await step('Joe laesst sich zuteilen – im Menue und beim Bearbeiten', async () => {
    const chip = karte(page, 'offen', 'Werkzeug bestellen').locator('.assignee');
    await chip.click();
    await page.waitForSelector('#assignee-dialog[open]');
    await page.locator('#assignee-choices button[value="Joe"]').click();
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === 'Joe', 'Wechsel auf Joe');
    assert.match(await chip.textContent(), /Zuständig: Joe/);

    await page.locator('label[for="filter-assignee-joe"]').click();
    await page.waitForFunction(() =>
      document.querySelectorAll('[data-stack="offen"] .card').length === 1);
    await page.locator('label[for="filter-assignee-alle"]').click();

    await karte(page, 'offen', 'Werkzeug bestellen').locator('button', { hasText: 'Bearbeiten' }).click();
    await page.waitForSelector('#edit-dialog[open]');
    assert.ok(await page.locator('#edit-assignee-joe').isChecked(), 'Bearbeiten zeigt Joe an');
    await page.locator('label[for="edit-assignee-offen"]').click();
    await page.click('#edit-save');
    await waitFor(() => titled('Werkzeug bestellen')?.assignee === '', 'zuruecksetzen');
  });

  /** Ein grosses Testbild, im Browser gemalt – so wie ein Handyfoto. */
  const testbild = async (breite, hoehe, name) => {
    const daten = await page.evaluate(([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#B09060'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0A1C1E'; ctx.fillRect(0, 0, w / 2, h / 2);
      return c.toDataURL('image/png').split(',')[1];
    }, [breite, hoehe]);
    return { name, mimeType: 'image/png', buffer: Buffer.from(daten, 'base64') };
  };

  await step('Bild an eine Aufgabe anhaengen – verkleinert, als eigene Datei', async () => {
    const karteEl = karte(page, 'offen', 'Werkzeug bestellen');
    await karteEl.locator('button', { hasText: 'Bilder (0)' }).click();
    await page.waitForSelector('#images-dialog[open]');
    assert.equal(await page.locator('#images-title').textContent(), 'Werkzeug bestellen');
    assert.match(await page.locator('#gallery .empty').textContent(), /Noch keine Bilder/);

    await page.setInputFiles('#images-input', await testbild(3000, 2000, 'werkbank.png'));
    await waitFor(() => titled('Werkzeug bestellen')?.images?.length === 1, 'Bild in board.json');

    const t = titled('Werkzeug bestellen');
    const bild = t.images[0];
    assert.equal(bild.name, 'werkbank.png');
    assert.equal(bild.author, 'JAHVIS');
    const pfad = `bilder/${t.id}/${bild.id}.jpg`;
    assert.ok(fake.files.has(pfad), 'das Bild liegt als eigene Datei im Datenrepository');
    const bytes = fake.files.get(pfad).bytes;
    assert.equal(bytes[0], 0xFF, 'als JPEG gespeichert');
    assert.equal(bytes[1], 0xD8, 'als JPEG gespeichert');
    assert.ok(!fake.file.includes(bytes.toString('base64').slice(0, 40)), 'nicht in board.json eingebettet');
    assert.equal(board().activity[0].kind, 'bild');

    await page.waitForFunction(() => {
      const img = document.querySelector('#gallery .gallery-item img');
      return img && img.complete && img.naturalWidth > 0;
    });
    assert.deepEqual(
      await page.locator('#gallery .gallery-item img').evaluate((img) => [img.naturalWidth, img.naturalHeight]),
      [1600, 1067], 'lange Kante auf 1600 Pixel verkleinert');
    assert.match(await page.locator('#images-status').textContent(), /Bild angehängt/);
    assert.match(await page.locator('#gallery .note-author').textContent(), /JAHVIS/);
    await page.click('#images-close');

    await page.waitForFunction(() => document.querySelectorAll('.card .thumbs img').length === 1);
    assert.match(await karteEl.locator('button', { hasText: 'Bilder' }).textContent(), /Bilder \(1\)/);
    assert.match(await page.locator('#activity-list li .activity-text').first().textContent(),
      /JAHVIS hat ein Bild angehängt: Werkzeug bestellen/);
  });

  await step('Klick aufs Vorschaubild oeffnet die Bilder', async () => {
    await karte(page, 'offen', 'Werkzeug bestellen').locator('.thumb').first().click();
    await page.waitForSelector('#images-dialog[open]');
    assert.equal(await page.locator('#gallery .gallery-item').count(), 1);
    assert.match(await page.locator('#gallery .gallery-open').getAttribute('href'), /^blob:/);
    await page.click('#images-close');
  });

  await step('beim Anlegen lassen sich gleich Bilder mitgeben', async () => {
    await page.fill('#new-title', 'Schaden dokumentieren');
    await page.locator('#new-more summary').click();
    await page.setInputFiles('#new-images', [
      await testbild(800, 600, 'schaden-1.png'),
      await testbild(600, 800, 'schaden-2.png'),
    ]);
    assert.match(await page.locator('#new-images-hint').textContent(), /2 Bilder ausgewählt/);
    await page.click('#new-form button[type=submit]');
    await waitFor(() => titled('Schaden dokumentieren')?.images?.length === 2, 'beide Bilder angehaengt');
    assert.deepEqual(titled('Schaden dokumentieren').images.map((b) => b.name), ['schaden-1.png', 'schaden-2.png']);
    await page.waitForFunction(() => /2 Bilder angehängt/.test(document.querySelector('#new-images-hint').textContent));
    assert.equal(await page.locator('#new-images').evaluate((el) => el.files.length), 0, 'Auswahl ist geleert');
    await page.locator('#new-more').evaluate((el) => { el.open = false; });
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Schaden dokumentieren'));
      return card && card.querySelectorAll('.thumbs img').length === 2;
    });
  });

  await step('ein Bild laesst sich wieder entfernen', async () => {
    const t = titled('Schaden dokumentieren');
    const weg = t.images[0];
    const pfad = `bilder/${t.id}/${weg.id}.jpg`;
    assert.ok(fake.files.has(pfad));

    await karte(page, 'offen', 'Schaden dokumentieren').locator('button', { hasText: 'Bilder (2)' }).click();
    await page.waitForSelector('#images-dialog[open]');
    page.once('dialog', (d) => d.accept());
    await page.locator(`#gallery .gallery-item[data-id="${weg.id}"] button`, { hasText: 'Entfernen' }).click();
    await waitFor(() => titled('Schaden dokumentieren').images.find((b) => b.id === weg.id)?.removed === true,
      'als entfernt gespeichert');
    await waitFor(() => !fake.files.has(pfad), 'Datei im Datenrepository geloescht');
    assert.equal(await page.locator('#gallery .gallery-item').count(), 1);
    await page.click('#images-close');
    assert.match(await karte(page, 'offen', 'Schaden dokumentieren')
      .locator('button', { hasText: 'Bilder' }).textContent(), /Bilder \(1\)/);
  });

  await step('kein Bild? Dann eine klare Meldung statt eines stillen Fehlers', async () => {
    await karte(page, 'offen', 'Werkzeug bestellen').locator('button', { hasText: 'Bilder' }).click();
    await page.waitForSelector('#images-dialog[open]');
    await page.setInputFiles('#images-input',
      { name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('kein bild') });
    await page.waitForFunction(() => /kaputt\.png/.test(document.querySelector('#images-status').textContent));
    assert.match(await page.locator('#banner').textContent(), /Nicht alle Bilder/);
    assert.equal(titled('Werkzeug bestellen').images.length, 1, 'nichts Kaputtes angehängt');
    await page.click('#images-close');
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

  await step('alte Notiz wird zum ersten Kommentar – und der Kollege heisst jetzt Alex', async () => {
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
    assert.match(await karteEl.locator('.note-author').textContent(), /Alex/,
      'der alte Name wird beim Einlesen auf Alex umgeschluesselt');
  });

  await step('Neues von Alex erscheint als Zaehler und laesst sich abhaken', async () => {
    setRemote((data) => {
      // bewusst in der Zukunft: so sieht es aus, wenn die Uhr des anderen vorgeht
      const jetzt = new Date(Date.now() + 60000).toISOString();
      data.activity.unshift({
        id: 'akt-neu', at: jetzt, actor: 'Alex', kind: 'angelegt',
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

  await step('nach Neuladen bleibt alles erhalten – auch die Bilder', async () => {
    await page.reload();
    await page.waitForSelector('#app:not(.hidden)', { timeout: 15000 });
    await page.waitForSelector('.card[data-id="alt-1"]');
    // Nach dem Neuladen ist kein Bild mehr im Speicher: es kommt aus dem Repository.
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.card .thumbs img')];
      return imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    });
    const typ = await page.evaluate(async () =>
      (await fetch(document.querySelector('.card .thumbs img').src)).blob().then((b) => b.type));
    assert.equal(typ, 'image/jpeg', 'sonst laedt „in voller Groesse oeffnen" die Datei herunter');
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

  await step('wer sich frueher als „Kollege" angemeldet hat, ist jetzt Alex', async () => {
    const gesichert = { file: fake.file, sha: fake.sha };
    fake.file = JSON.stringify({
      version: 2,
      tasks: [{ id: 'k-1', title: 'Von Alex angelegt', url: '', note: '',
        status: 'offen', author: 'Kollege', assignee: 'Kollege',
        createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z',
        doneAt: null, deleted: false }],
      // Eigene Aktivitaet – sie darf fuer ihn selbst nicht als „neu" zaehlen.
      activity: [{ id: 'k-e1', at: new Date(Date.now() + 60000).toISOString(),
        actor: 'Kollege', kind: 'angelegt', taskId: 'k-1', title: 'Von Alex angelegt' }],
    });
    fake.sha = 'sha-kollege';

    const ctxK = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const pk = await ctxK.newPage();
    await installFakeGithub(pk);
    // So sah sein Browser vorher aus: alte Kennung im Speicher.
    await pk.addInitScript(() => { localStorage.setItem('fa.me', 'Kollege'); });
    await pk.goto(`${base}/index.html#c=${sealed}`);
    await pk.fill('#pin-input', PIN);
    await pk.click('#pin-submit');
    await pk.waitForSelector('#app:not(.hidden)', { timeout: 15000 });

    // Kein „Wer bist du?" mehr, und in der Kopfzeile steht der neue Name.
    await pk.waitForFunction(() => document.querySelector('#who-chip').textContent.includes('Alex'));
    assert.equal(await pk.evaluate(() => localStorage.getItem('fa.me')), 'Alex',
      'der alte Name verschwindet aus dem Speicher');

    await pk.waitForSelector('.card[data-id="k-1"]');
    assert.match(await pk.locator('.card[data-id="k-1"] .assignee').textContent(),
      /Zuständig: Alex/, 'die Zustaendigkeit darf nicht auf Offen fallen');
    assert.ok(await pk.locator('#news-chip').isHidden(),
      'die eigene Aktivitaet zaehlt nicht als neu');

    await ctxK.close();
    fake.file = gesichert.file;
    fake.sha = gesichert.sha;
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
      'Alex hat kommentiert: Altbestand prüfen',
      'Alex hat angelegt: Altbestand prüfen',
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
