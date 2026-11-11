// Inicio de sesión con Google (Google Identity Services) y cliente mínimo de Drive para la carpeta oculta de la app.
// El celu nunca ve el resto de tu Drive: el permiso es solo `drive.appdata`.
import { CLIENT_ID, CENTRAL_URL, API_KEY } from './config.js';

const SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tokenClient = null, token = null, expires = 0;

export class AuthNeeded extends Error {}

// ---- modo amigo: la biblioteca del dueño llega por la "central"; los archivos se bajan de Drive con su ID ----
export const role = () => localStorage.getItem('stemlab.role') || 'owner';
export const isFriend = () => role() === 'friend';
let lib = { songs: [], queue: [], pending: [] };
async function central(action, extra = {}) {
  const t = await accessToken();
  let r;
  try { r = await fetch(CENTRAL_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: t, action, ...extra }) }); }
  catch { throw new Error('Sin conexión con la central.'); }
  let j; try { j = await r.json(); } catch { throw new Error('La central no respondió bien.'); }
  if (j.error) throw new Error(j.error);
  return j;
}
/** Después de conectar: ¿esta cuenta es del dueño, un amigo autorizado o ninguna de las dos? */
export async function detectRole() {
  if (!CENTRAL_URL) { localStorage.setItem('stemlab.role', 'owner'); return 'owner'; }
  const j = await central('me');
  localStorage.setItem('stemlab.role', j.role);
  return j.role;
}
async function friendList() {
  lib = await central('library');
  const out = [{ name: 'manifest.json', id: '__central__', modifiedTime: String(lib.songs.length) }];
  for (const s of lib.songs) {
    out.push({ name: `audio-${s.uid}.zip`, id: s.audio_id, size: String(s.audio_size || 0), modifiedTime: '' });
    out.push({ name: `meta-${s.uid}.json`, id: s.meta_id, modifiedTime: s.meta_mod || '' });
  }
  for (const p of lib.pending || []) out.push({ name: `pending-${p.id}.json`, id: '__p' + p.id, modifiedTime: '' });
  return out;
}
const pubUrl = id => `${API}/files/${id}?alt=media&key=${API_KEY}`;

function loadGsi() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar el inicio de sesión de Google (¿sin internet?).'));
    document.head.appendChild(s);
  });
}

export const hasSession = () => localStorage.getItem('stemlab.google') === '1';
export const email = () => localStorage.getItem('stemlab.email') || '';

/** Pide un token. interactive=false intenta renovarlo en silencio (sin ventana). */
export async function signIn(interactive = false) {
  await loadGsi();
  const t = await new Promise((resolve, reject) => {
    tokenClient ||= google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
    tokenClient.callback = r => r.error ? reject(new AuthNeeded(r.error)) : resolve(r);
    tokenClient.error_callback = e => reject(new AuthNeeded(e?.type === 'popup_closed' ? 'Cerraste la ventana de Google.' : (e?.type || 'No se pudo iniciar sesión.')));
    tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
  token = t.access_token; expires = Date.now() + (Number(t.expires_in) - 120) * 1000;
  localStorage.setItem('stemlab.google', '1');
  if (interactive || !email()) {
    try {
      const u = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })).json();
      if (u.email) localStorage.setItem('stemlab.email', u.email);
    } catch { /* el correo es solo informativo */ }
  }
  return token;
}

/** Para usar al empezar un clic del usuario: si el permiso venció, lo renueva con la ventana de Google (necesita el gesto del usuario en el celu). */
export async function fresh() {
  if (token && Date.now() < expires) return token;
  return signIn(true);
}

async function accessToken() {
  if (token && Date.now() < expires) return token;
  if (!hasSession()) throw new AuthNeeded('Conectá tu cuenta de Google.');
  return signIn(false);
}

export async function signOut() {
  try { if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token); } catch { /* da igual */ }
  token = null; expires = 0;
  localStorage.removeItem('stemlab.google'); localStorage.removeItem('stemlab.email'); localStorage.removeItem('stemlab.role');
}

async function req(method, url, { params, headers, body } = {}) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    const t = await accessToken();
    let r;
    try {
      r = await fetch(url + (params ? '?' + new URLSearchParams(params) : ''), { method, headers: { Authorization: 'Bearer ' + t, ...headers }, body });
    } catch { lastErr = new Error('Sin conexión con Google.'); await sleep(800 * 2 ** i); continue; }
    if (r.status === 401) { token = null; expires = 0; lastErr = new AuthNeeded('La sesión caducó.'); continue; }
    if ([429, 500, 502, 503, 504].includes(r.status)) { lastErr = new Error(`Google respondió ${r.status}.`); await sleep(1000 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`Google respondió ${r.status}.`);
    return r;
  }
  throw lastErr || new Error('No se pudo hablar con Drive.');
}

export async function list() {
  if (isFriend()) return friendList();
  const out = []; let page;
  do {
    const params = { spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,size,modifiedTime)' };
    if (page) params.pageToken = page;
    const j = await (await req('GET', API + '/files', { params })).json();
    out.push(...(j.files || [])); page = j.nextPageToken;
  } while (page);
  return out;
}

export const readJson = async id => {
  if (isFriend()) {
    if (id === '__central__') return { songs: lib.songs, queue: lib.queue };
    if (id.startsWith('__p')) return (lib.pending || []).find(p => '__p' + p.id === id) || {};
    const r = await fetch(pubUrl(id)); if (!r.ok) throw new Error(`No se pudo leer el tema (${r.status}).`); return r.json();
  }
  return (await req('GET', `${API}/files/${id}`, { params: { alt: 'media' } })).json();
};

/** Baja un archivo entero informando el avance (0..1). Devuelve un ArrayBuffer. */
export async function download(id, size, onProgress = () => {}) {
  let r;
  if (isFriend()) { r = await fetch(pubUrl(id)); if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? 'Google limitó esta descarga por ahora: probá en unos minutos.' : `No se pudo bajar (${r.status}).`); }
  else r = await req('GET', `${API}/files/${id}`, { params: { alt: 'media' } });
  const total = Number(size) || Number(r.headers.get('content-length')) || 0;
  if (!r.body?.getReader) return r.arrayBuffer();
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total));
  }
  const all = new Uint8Array(got); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all.buffer;
}

export async function putJson(name, obj, fileId = null) {
  const boundary = 'stemlab' + Math.random().toString(16).slice(2);
  const meta = fileId ? { name } : { name, parents: ['appDataFolder'] };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;
  const r = await req(fileId ? 'PATCH' : 'POST', `${UP}/files${fileId ? '/' + fileId : ''}`,
    { params: { uploadType: 'multipart', fields: 'id' }, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return (await r.json()).id;
}

/** Sube un archivo (por ejemplo un MP3) con carga reanudable y avance. */
export async function uploadFile(name, file, onProgress = () => {}) {
  const t = await accessToken();
  const r = await req('POST', `${UP}/files`, { params: { uploadType: 'resumable', fields: 'id' },
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': file.type || 'application/octet-stream', 'X-Upload-Content-Length': String(file.size) },
    body: JSON.stringify({ name, parents: ['appDataFolder'] }) });
  const session = r.headers.get('Location');
  if (!session) throw new Error('Google no abrió la subida.');
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', session);
    x.setRequestHeader('Authorization', 'Bearer ' + t);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status === 200 || x.status === 201) ? resolve(JSON.parse(x.responseText).id) : reject(new Error(`Falló la subida (${x.status}).`));
    x.onerror = () => reject(new Error('Se cortó la conexión al subir.'));
    x.send(file);
  });
}

export async function remove(id) {
  try { await req('DELETE', `${API}/files/${id}`); } catch (e) { if (!/404/.test(e.message)) throw e; }
}

export const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---- pedidos para la PC (los lee y borra la PC cuando está encendida) ----------------------------------
export const requestUrl = (url, title = '') => { if (isFriend()) return central('request', { url, title });
  const id = newId(); return putJson(`pending-${id}.json`, { id, kind: 'url', url, title, created: Date.now() }); };
export async function requestFile(file, onProgress) {
  if (isFriend()) throw new Error('Subir audios no está disponible en la biblioteca compartida: pegá un link.');
  const id = newId(), ext = (file.name.match(/\.([A-Za-z0-9]{1,5})$/) || [, 'mp3'])[1].toLowerCase();
  await uploadFile(`inbox-${id}.${ext}`, file, onProgress);                       // primero el audio, después el pedido
  return putJson(`pending-${id}.json`, { id, kind: 'file', file: `inbox-${id}.${ext}`, title: file.name.replace(/\.[^.]+$/, ''), created: Date.now() });
}
export const requestDelete = uid => isFriend() ? central('delete', { uid }) : putJson(`delete-${uid}.json`, { uid, created: Date.now() });
