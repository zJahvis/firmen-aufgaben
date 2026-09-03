// Verschlüsselung: PIN -> AES-GCM-Schlüssel (PBKDF2-SHA256).
// Der Zugangs-Token liegt nur als Chiffrat vor; ohne PIN ist er wertlos.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Verschlüsselt ein Objekt zu einem kompakten base64url-String. */
export async function sealJson(pin, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)))
  );
  const out = new Uint8Array(1 + salt.length + iv.length + ct.length);
  out[0] = 1; // Formatversion
  out.set(salt, 1);
  out.set(iv, 1 + salt.length);
  out.set(ct, 1 + salt.length + iv.length);
  return bytesToB64url(out);
}

/** Entschlüsselt einen sealJson-String. Wirft bei falscher PIN. */
export async function openJson(pin, sealed) {
  const raw = b64urlToBytes(sealed);
  if (raw.length < 30 || raw[0] !== 1) throw new Error('Ungültiges Zugangspaket');
  const salt = raw.slice(1, 17);
  const iv = raw.slice(17, 29);
  const ct = raw.slice(29);
  const key = await deriveKey(pin, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(pt));
}
