// Almacenamiento en el teléfono (IndexedDB): temas descargados con sus stems, análisis y letra.
const DB = 'stemlab', V = 1;
let dbp = null;
const open = () => dbp ||= new Promise((res, rej) => {
  const r = indexedDB.open(DB, V);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('songs', { keyPath: 'uid' }); d.createObjectStore('stems'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (stores, mode, fn) => {
  const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(stores, mode); let out; Promise.resolve(fn(t)).then(v => out = v); t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error); });
};
const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const listSongs = () => tx(['songs'], 'readonly', t => wrap(t.objectStore('songs').getAll()));
export const getSong = uid => tx(['songs'], 'readonly', t => wrap(t.objectStore('songs').get(uid)));
export const getStem = (uid, name) => tx(['stems'], 'readonly', t => wrap(t.objectStore('stems').get(`${uid}/${name}`)));

/** Guarda un tema completo. meta = contenido de meta-<uid>.json; stems = {nombre: ArrayBuffer}; extra = datos propios. */
export function putSong(meta, stems, extra = {}) {
  return tx(['songs', 'stems'], 'readwrite', t => {
    const names = Object.keys(stems);
    for (const n of names) t.objectStore('stems').put(stems[n], `${meta.uid}/${n}`);
    t.objectStore('songs').put({ ...meta, ...extra, stems: names, bytes: names.reduce((s, n) => s + stems[n].byteLength, 0), saved: Date.now() });
  });
}
/** Actualiza solo los datos chicos (análisis, letra, título) sin tocar el audio. */
export const updateMeta = (meta, extra = {}) => tx(['songs'], 'readwrite', async t => {
  const st = t.objectStore('songs'), old = await wrap(st.get(meta.uid));
  if (old) st.put({ ...meta, ...extra, stems: old.stems, bytes: old.bytes, saved: old.saved, lyrics: meta.lyrics ? { ...meta.lyrics, offset: old.lyrics?.offset ?? meta.lyrics.offset } : null });
});
export const setOffset = (uid, offset) => tx(['songs'], 'readwrite', async t => {
  const st = t.objectStore('songs'), s = await wrap(st.get(uid));
  if (s?.lyrics) { s.lyrics.offset = offset; st.put(s); return s.lyrics; }
  return null;
});
export const delSong = uid => tx(['songs', 'stems'], 'readwrite', async t => {
  const s = await wrap(t.objectStore('songs').get(uid));
  for (const n of s?.stems || []) t.objectStore('stems').delete(`${uid}/${n}`);
  t.objectStore('songs').delete(uid);
});
export async function clearAll() {
  await tx(['songs', 'stems'], 'readwrite', t => { t.objectStore('songs').clear(); t.objectStore('stems').clear(); });
}
export const usage = async () => (await listSongs()).reduce((s, x) => s + (x.bytes || 0), 0);
