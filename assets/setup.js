import { sealJson } from './crypto.js';
import { GithubStore } from './store.js';
import { emptyBoard, sanitizeBoard } from './board.js';

const $ = (s) => document.querySelector(s);
const status = $('#status');

// Auf <benutzer>.github.io ist der Besitzer bereits bekannt – Feld vorbelegen.
const ownerFromHost = location.hostname.match(/^([\w-]+)\.github\.io$/i)?.[1];
if (ownerFromHost) $('#repo').value = `${ownerFromHost}/firmen-aufgaben-data`;

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = 'status ' + kind;
}

$('#setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();

  const repoRaw = $('#repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const token = $('#token').value.trim();
  const pin = $('#pin').value;
  const pin2 = $('#pin2').value;

  if (!/^[\w.-]+\/[\w.-]+$/.test(repoRaw)) {
    return setStatus('Das Repository muss die Form benutzername/repository haben.', 'err');
  }
  if (pin.length < 4) return setStatus('Die PIN muss mindestens 4 Zeichen haben.', 'err');
  if (pin !== pin2) return setStatus('Die beiden PINs sind nicht gleich.', 'err');

  const [owner, repo] = repoRaw.split('/');
  const btn = $('#go');
  btn.disabled = true;
  setStatus('Prüfe Zugang zu GitHub …');

  try {
    const store = new GithubStore({ owner, repo, path: 'board.json', token });
    await store.probe();

    setStatus('Prüfe Schreibrecht …');
    const { board, sha } = await store.read();
    if (board === null) {
      await store.write(emptyBoard(), null);
    } else {
      // Bestehende Daten unangetastet lassen, nur Schreibrecht bestätigen.
      await store.write(sanitizeBoard(board), sha);
    }

    setStatus('Verschlüssele Zugang …');
    const sealed = await sealJson(pin, {
      owner,
      repo,
      path: 'board.json',
      branch: store.branch,
      token,
    });

    const base = location.href.replace(/setup\.html.*$/, 'index.html');
    const link = `${base}#c=${sealed}`;
    $('#invite').value = link;
    $('#open').href = link;
    $('#result').classList.remove('hidden');
    setStatus('Zugang erstellt. Die Pinnwand ist einsatzbereit.', 'ok');
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    setStatus(err.message || 'Unbekannter Fehler.', 'err');
  } finally {
    btn.disabled = false;
  }
});

$('#copy').addEventListener('click', async () => {
  const el = $('#invite');
  try {
    await navigator.clipboard.writeText(el.value);
    $('#copy').textContent = 'Kopiert ✓';
    setTimeout(() => ($('#copy').textContent = 'Link kopieren'), 1800);
  } catch {
    el.select();
    document.execCommand('copy');
  }
});
