// Biblioteca de la app del celu: lee la lista que publica tu PC en Drive, baja los temas al teléfono y manda pedidos a la PC.
import { initPanels } from './ui.js';
import * as g from './google.js';
import * as store from './store.js';
import { unzip } from './zip.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '';
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = t => (t.replace(/[\(\[].*?[\)\]]/g, '').match(/[\p{L}\p{N}]+/gu) || ['♪']).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const size = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';
const note = t => { const n = $('#note'); n.textContent = t || ''; n.classList.toggle('hidden', !t); };

initPanels($('#foldAll'));
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded) return; reloaded = true; if (!document.querySelector('#menu[open]')) location.reload(); });
}

let files = [], manifest = { songs: [], queue: [] }, local = [], online = true;
const progress = {};                      // uid -> 0..1 mientras se descarga
const deleting = () => { try { return JSON.parse(localStorage.getItem('stemlab.deleting') || '[]'); } catch { return []; } };
const setDeleting = a => localStorage.setItem('stemlab.deleting', JSON.stringify([...new Set(a)]));
const pendingTitles = {};

// ---- sincronizar con Drive -----------------------------------------------------------------------------
let syncing = false;
async function sync(msg = true) {
  if (syncing || !g.hasSession()) return;
  syncing = true; $('#syncNow').disabled = true; if (msg) $('#syncMsg').textContent = 'Consultando tu Drive…';
  try {
    files = await g.list(); online = true;
    const m = files.find(f => f.name === 'manifest.json');
    manifest = m ? await g.readJson(m.id) : { songs: [], queue: [] };
    setDeleting(deleting().filter(u => manifest.songs.some(s => s.uid === u)));
    for (const f of files.filter(f => /^pending-.*\.json$/.test(f.name) && !(f.name in pendingTitles)))
      pendingTitles[f.name] = await g.readJson(f.id).then(j => j.title || j.url || 'Tema nuevo').catch(() => 'Tema nuevo');
    await refreshMeta();
    $('#syncMsg').textContent = m ? `Lista actualizada ${new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}.` : 'Todavía no hay nada en tu Drive: abrí StemLab en la PC y esperá a que sincronice.';
    note('');
  } catch (e) {
    online = false;
    if (e instanceof g.AuthNeeded) { renderAccount(); note('Hay que volver a conectar la cuenta de Google.'); $('#syncMsg').textContent = ''; }
    else { $('#syncMsg').textContent = ''; note(e.message + ' Se muestran los temas que ya están en el teléfono.'); }
  }
  syncing = false; $('#syncNow').disabled = false; await render();
}
// Si la PC actualizó la letra o los acordes de un tema ya descargado, se actualiza solo (es un archivo chico).
async function refreshMeta() {
  local = await store.listSongs();
  for (const s of local) {
    const mf = files.find(f => f.name === `meta-${s.uid}.json`);
    if (mf && mf.modifiedTime !== s.metaMod) { try { await store.updateMeta(await g.readJson(mf.id), { metaMod: mf.modifiedTime }); } catch { /* se reintenta la próxima */ } }
  }
}

// ---- descargar un tema ---------------------------------------------------------------------------------
async function download(uid) {
  const af = files.find(f => f.name === `audio-${uid}.zip`), mf = files.find(f => f.name === `meta-${uid}.json`);
  if (!af || !mf) { note('Ese tema todavía no está completo en Drive.'); return; }
  progress[uid] = 0.001; render();
  try {
    navigator.storage?.persist?.();
    const meta = await g.readJson(mf.id);
    const buf = await g.download(af.id, af.size, p => { progress[uid] = p; paint(uid); });
    progress[uid] = 1; paint(uid);
    const entries = await unzip(buf), stems = {};
    for (const n of meta.stems) { const e = entries[`${n}.opus`]; if (!e) throw new Error('Falta ' + n + ' en el paquete.'); stems[n] = e; }
    await store.putSong(meta, stems, { metaMod: mf.modifiedTime });
    note('');
  } catch (e) { note('No se pudo bajar el tema: ' + e.message); }
  delete progress[uid]; local = await store.listSongs(); render();
}
function paint(uid) { const b = document.querySelector(`[data-bar="${uid}"]`); if (b) b.style.width = Math.round(progress[uid] * 100) + '%'; }

// ---- pantalla --------------------------------------------------------------------------------------------
function renderAccount() {
  const on = g.hasSession();
  $('#acctOff').classList.toggle('hidden', on); $('#acctOn').classList.toggle('hidden', !on);
  $('#acctMail').textContent = g.email() || 'tu cuenta de Google'; $('#acctTag').textContent = on ? 'conectada' : '';
}
async function render() {
  local = await store.listSongs();
  const hidden = deleting(), byUid = new Map();
  for (const s of manifest.songs) if (!hidden.includes(s.uid)) byUid.set(s.uid, { ...s, cloud: true });
  for (const s of local) byUid.set(s.uid, { ...(byUid.get(s.uid) || {}), uid: s.uid, title: s.title, duration: s.duration, bpm: s.bpm, key: s.key, created: s.created, here: true, bytes: s.bytes });
  const all = [...byUid.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
  $('#count').textContent = all.length || ''; $('#empty').style.display = all.length ? 'none' : '';
  $('#list').innerHTML = all.map(s => {
    const cover = `<div class="cover" style="--h:${hue(s.title || '')}">${esc(initials(s.title || '♪'))}${s.here ? '<span class="go">▶</span>' : ''}</div>`;
    const chips = [fmt(s.duration), s.bpm ? Math.round(s.bpm) + ' BPM' : '', s.key || '', s.here ? size(s.bytes || 0) : (s.audio_size ? size(s.audio_size) : '')].filter(Boolean)
      .map((c, i) => `<span class="chip${i === 2 ? ' acc' : ''}">${esc(c)}</span>`).join('');
    const x = `<button class="x" data-menu="${s.uid}" aria-label="Opciones">⋯</button>`;
    if (s.here) return `<div class="song"><a class="song-link" href="player.html?id=${s.uid}" style="display:contents">${cover}<div class="name">${esc(s.title)}</div></a><div class="chips">${chips}</div>${x}</div>`;
    if (s.uid in progress) return `<div class="song busy">${cover}<div class="name">${esc(s.title)}</div><div class="bar2"><i data-bar="${s.uid}" style="width:${Math.round(progress[s.uid] * 100)}%"></i></div><div class="stage">Bajando…</div></div>`;
    return `<div class="song">${cover}<div class="name">${esc(s.title)}</div><div class="chips">${chips}</div><button class="btn dl" data-dl="${s.uid}">Bajar al teléfono</button>${x}</div>`;
  }).join('');
  const bytes = local.reduce((t, s) => t + (s.bytes || 0), 0);
  $('#total').textContent = local.length ? `En el teléfono: ${local.length} tema(s), ${size(bytes)}` : '';
  $('#usage').textContent = local.length ? `Hay ${local.length} tema(s) descargados, ${size(bytes)}.` : 'No hay temas descargados.';
  const waiting = files.filter(f => /^pending-.*\.json$/.test(f.name)).map(f => ({ title: pendingTitles[f.name] || 'Tema nuevo', stage: 'Esperando a la PC' }));
  const q = [...waiting, ...(manifest.queue || []).map(x => ({ title: x.title, stage: x.stage || x.status }))];
  $('#p-queue').classList.toggle('hidden', !q.length); $('#queueTag').textContent = q.length || '';
  $('#queue').innerHTML = q.map(x => `<div class="qrow"><b>${esc(x.title)}</b><span>${esc(x.stage)}</span></div>`).join('');
  renderAccount();
}

// ---- acciones --------------------------------------------------------------------------------------------
$('#signin').onclick = async () => {
  try { await g.signIn(true); await sync(); } catch (e) { note(e.message); }
  renderAccount();
};
$('#signout').onclick = async () => { await g.signOut(); files = []; manifest = { songs: [], queue: [] }; renderAccount(); render(); };
$('#syncNow').onclick = () => sync();
$('#list').addEventListener('click', e => {
  const d = e.target.closest('[data-dl]'); if (d) return download(d.dataset.dl);
  const m = e.target.closest('[data-menu]'); if (m) openMenu(m.dataset.menu);
});
let menuUid = null;
function openMenu(uid) {
  menuUid = uid; const s = [...manifest.songs, ...local].find(x => x.uid === uid);
  $('#menuTitle').textContent = s?.title || 'Tema';
  const here = local.some(x => x.uid === uid);
  $('#mRemove').style.display = here ? '' : 'none';
  $('#menu').showModal();
}
$('#mCancel').onclick = () => $('#menu').close();
$('#mRemove').onclick = async () => { $('#menu').close(); await store.delSong(menuUid); render(); };
$('#mDelete').onclick = async () => {
  $('#menu').close();
  if (!confirm('Esto borra el tema del teléfono, de tu Drive y de tu PC (cuando esté encendida). No se puede deshacer. ¿Seguir?')) return;
  try {
    await store.delSong(menuUid);
    if (g.hasSession()) { await g.requestDelete(menuUid); setDeleting([...deleting(), menuUid]); }
  } catch (e) { note('No se pudo pedir el borrado: ' + e.message); }
  render();
};
$('#urlForm').onsubmit = async e => {
  e.preventDefault();
  if (!g.hasSession()) return note('Primero conectá tu cuenta de Google.');
  try { await g.requestUrl($('#url').value.trim()); $('#url').value = ''; $('#addNote').textContent = 'Pedido enviado. Tu PC lo toma cuando esté encendida.'; note(''); await sync(false); }
  catch (err) { note('No se pudo enviar el pedido: ' + err.message); }
};
$('#file').onchange = async e => {
  if (!g.hasSession()) { note('Primero conectá tu cuenta de Google.'); return; }
  const list = [...e.target.files]; e.target.value = '';
  let ok = 0;
  for (const [i, f] of list.entries()) {
    try { await g.requestFile(f, p => { $('#addNote').textContent = `Subiendo ${i + 1}/${list.length}: ${f.name} (${Math.round(p * 100)}%)`; }); ok++; }
    catch (err) { note(`No se pudo subir «${f.name}»: ${err.message}`); }
  }
  if (ok) $('#addNote').textContent = `${ok} archivo(s) enviados. Tu PC los procesa de a uno cuando esté encendida.`;
  await sync(false);
};
$('#wipe').onclick = async () => {
  if (!confirm('Se borran de este teléfono todos los temas descargados, la sesión de Google y la memoria de la app. En tu Drive y en tu PC no se toca nada. ¿Seguir?')) return;
  await g.signOut();
  await store.clearAll();
  for (const k of Object.keys(localStorage)) if (k.startsWith('stemlab')) localStorage.removeItem(k);
  for (const k of await caches.keys()) await caches.delete(k);
  for (const r of await navigator.serviceWorker?.getRegistrations?.() || []) await r.unregister();
  note('Listo: este teléfono quedó limpio.'); setTimeout(() => location.reload(), 800);
};

// ---- arranque ---------------------------------------------------------------------------------------------
await render();
if (g.hasSession()) { sync(false); setInterval(() => { if (!document.hidden) sync(false); }, 60000); }
addEventListener('online', () => sync(false));
