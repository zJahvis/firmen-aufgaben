// Speicher-Anbindung: eine JSON-Datei in einem privaten GitHub-Repository,
// beschrieben über die GitHub Contents API. Das Repository ist damit die
// Datenbank – serverseitig gespeichert, versioniert, kostenlos.

const API = 'https://api.github.com';

export class ConflictError extends Error {}
export class AuthError extends Error {}

export class GithubStore {
  constructor({ owner, repo, path = 'board.json', branch = 'main', token }) {
    this.owner = owner;
    this.repo = repo;
    this.path = path;
    this.branch = branch;
    this.token = token;
  }

  get fileUrl() {
    return this.urlFor(this.path);
  }

  urlFor(path) {
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  /** Weitere Dateien (Bilder) liegen im selben Ordner wie board.json. */
  siblingPath(rel) {
    const i = this.path.lastIndexOf('/');
    return i < 0 ? rel : this.path.slice(0, i + 1) + rel;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  async request(url, init = {}) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', ...init, headers: this.headers(init.headers) });
    } catch (err) {
      throw new Error('Keine Verbindung zu GitHub. Bist du online?');
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      if (/rate limit/i.test(body)) throw new Error('GitHub-Limit erreicht. Bitte kurz warten.');
      throw new AuthError('Zugang abgelehnt – Token ungültig, abgelaufen oder ohne Schreibrecht.');
    }
    return res;
  }

  /** Liest die Pinnwand. Gibt {board:null, sha:null} zurück, wenn es sie noch nicht gibt. */
  async read() {
    const res = await this.request(`${this.fileUrl}?ref=${encodeURIComponent(this.branch)}`);
    if (res.status === 404) return { board: null, sha: null };
    if (!res.ok) throw new Error(`Laden fehlgeschlagen (HTTP ${res.status})`);
    const json = await res.json();
    return { board: JSON.parse(decodeBase64Utf8(json.content || '')), sha: json.sha };
  }

  /** Schreibt die Pinnwand. sha=null legt die Datei neu an. */
  async write(board, sha) {
    const body = {
      message: `Aufgaben aktualisiert (${new Date().toISOString()})`,
      content: encodeBase64Utf8(JSON.stringify(board, null, 2) + '\n'),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    const res = await this.request(this.fileUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 409 || res.status === 422) {
      throw new ConflictError('Jemand anderes hat gleichzeitig gespeichert.');
    }
    if (!res.ok) throw new Error(`Speichern fehlgeschlagen (HTTP ${res.status})`);
    const json = await res.json();
    return { sha: json.content.sha };
  }

  /**
   * Legt eine Binärdatei (base64) neu an. Jede Datei ist ein eigener Commit;
   * kommt ein gleichzeitiges Speichern der Pinnwand dazwischen, meldet GitHub
   * einen Konflikt – dann einfach noch einmal.
   */
  async writeFile(rel, base64, message) {
    const body = JSON.stringify({ message, content: base64, branch: this.branch });
    for (let versuch = 0; ; versuch++) {
      const res = await this.request(this.urlFor(this.siblingPath(rel)), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) return;
      if (res.status === 409 && versuch < 4) {
        await new Promise((r) => setTimeout(r, 400 * (versuch + 1)));
        continue;
      }
      if (res.status === 413) throw new Error('Das Bild ist zu groß.');
      throw new Error(`Hochladen fehlgeschlagen (HTTP ${res.status})`);
    }
  }

  /** Lädt eine Datei als Blob – das Repository ist privat, ein <img src> ginge nicht. */
  async readFile(rel) {
    const res = await this.request(
      `${this.urlFor(this.siblingPath(rel))}?ref=${encodeURIComponent(this.branch)}`,
      { headers: { Accept: 'application/vnd.github.raw' } }
    );
    if (res.status === 404) throw new Error('Bild nicht gefunden.');
    if (!res.ok) throw new Error(`Bild laden fehlgeschlagen (HTTP ${res.status})`);
    return res.blob();
  }

  /** Löscht eine Datei. Gibt es sie nicht (mehr), ist das kein Fehler. */
  async deleteFile(rel, message) {
    const url = this.urlFor(this.siblingPath(rel));
    for (let versuch = 0; ; versuch++) {
      const info = await this.request(`${url}?ref=${encodeURIComponent(this.branch)}`);
      if (info.status === 404) return;
      if (!info.ok) throw new Error(`Löschen fehlgeschlagen (HTTP ${info.status})`);
      const { sha } = await info.json();
      const res = await this.request(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sha, branch: this.branch }),
      });
      if (res.ok || res.status === 404) return;
      if (res.status === 409 && versuch < 4) continue;
      throw new Error(`Löschen fehlgeschlagen (HTTP ${res.status})`);
    }
  }

  /** Prüft Zugang und Standard-Branch; wird beim Einrichten benutzt. */
  async probe() {
    const res = await this.request(
      `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`
    );
    if (res.status === 404) throw new Error('Repository nicht gefunden oder Token hat keinen Zugriff darauf.');
    if (!res.ok) throw new Error(`Repository-Prüfung fehlgeschlagen (HTTP ${res.status})`);
    const json = await res.json();
    this.branch = json.default_branch || this.branch;
    return json;
  }
}

export function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeBase64Utf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
