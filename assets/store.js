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
    return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${this.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
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
