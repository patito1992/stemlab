// Inicio de sesión con Google (Google Identity Services) y cliente mínimo de Drive para la carpeta oculta de la app.
// El celu nunca ve el resto de tu Drive: el permiso es solo `drive.appdata`.
import { CLIENT_ID } from './config.js';

const SCOPE = 'openid email https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tokenClient = null, token = null, expires = 0;

export class AuthNeeded extends Error {}

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
  localStorage.removeItem('stemlab.google'); localStorage.removeItem('stemlab.email');
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
  const out = []; let page;
  do {
    const params = { spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,size,modifiedTime)' };
    if (page) params.pageToken = page;
    const j = await (await req('GET', API + '/files', { params })).json();
    out.push(...(j.files || [])); page = j.nextPageToken;
  } while (page);
  return out;
}

export const readJson = async id => (await req('GET', `${API}/files/${id}`, { params: { alt: 'media' } })).json();

/** Baja un archivo entero informando el avance (0..1). Devuelve un ArrayBuffer. */
export async function download(id, size, onProgress = () => {}) {
  const r = await req('GET', `${API}/files/${id}`, { params: { alt: 'media' } });
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
export const requestUrl = (url, title = '') => { const id = newId(); return putJson(`pending-${id}.json`, { id, kind: 'url', url, title, created: Date.now() }); };
export async function requestFile(file, onProgress) {
  const id = newId(), ext = (file.name.match(/\.([A-Za-z0-9]{1,5})$/) || [, 'mp3'])[1].toLowerCase();
  await uploadFile(`inbox-${id}.${ext}`, file, onProgress);                       // primero el audio, después el pedido
  return putJson(`pending-${id}.json`, { id, kind: 'file', file: `inbox-${id}.${ext}`, title: file.name.replace(/\.[^.]+$/, ''), created: Date.now() });
}
export const requestDelete = uid => putJson(`delete-${uid}.json`, { uid, created: Date.now() });
