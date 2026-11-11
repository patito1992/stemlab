// Fuente de datos del reproductor en la app del celu: todo sale de lo descargado en el teléfono.
import * as store from './store.js';
export const readOnly = true;

export const song = async uid => { const s = await store.getSong(uid); if (!s) throw new Error('Este tema no está en el teléfono.'); return { title: s.title }; };
export const stemNames = async uid => (await store.getSong(uid))?.stems || [];
export const stemAudio = async (uid, name) => { const b = await store.getStem(uid, name); if (!b) throw new Error('Falta el audio de ' + name); return b; };
export const analysis = async uid => (await store.getSong(uid))?.analysis || null;
export const lyrics = async uid => (await store.getSong(uid))?.lyrics || null;
export const setLyricsOffset = async (uid, offset) => store.setOffset(uid, offset);
