// Exportar la mezcla (volúmenes, mute/solo, tempo y tono actuales) como MP3.
// Se renderiza en el navegador con el MISMO procesador SoundTouch que se escucha en el reproductor (suena igual),
// y el backend la convierte a MP3 con ffmpeg.
import { SoundTouchNode } from './vendor/soundtouch-node.js';
import { effectiveGain, RHYTHMIC } from './engine.js';
import * as data from './data.js';

const SR = 44100;
const bufLen = (sec) => Math.max(1, Math.ceil(sec * SR));

// Latencia (s) que agrega el procesador con estos parámetros: se mide con un golpe de prueba.
async function measureLatency(tempo, semis) {
  const t0 = 0.4, ctx = new OfflineAudioContext(1, bufLen((t0 + 0.4) / tempo + 1.2), SR);
  await SoundTouchNode.register(ctx, './vendor/soundtouch-processor.js');
  const n = Math.floor(0.12 * SR), b = ctx.createBuffer(1, Math.floor(SR * (t0 + 0.4)), SR), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[Math.floor(t0 * SR) + i] = Math.sin(2 * Math.PI * 1000 * i / SR) * Math.sin(Math.PI * i / n) ** 2;
  const src = ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = tempo;
  const st = new SoundTouchNode({ context: ctx }); st.playbackRate.value = tempo; st.pitchSemitones.value = semis;
  src.connect(st); st.connect(ctx.destination); src.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  // centro de energía del golpe (más estable que el pico)
  let sw = 0, swt = 0; for (let i = 0; i < out.length; i++) { const e = out[i] * out[i]; sw += e; swt += e * i; }
  if (sw < 1e-9) return 0.11;
  return Math.max(0, swt / sw / SR - (t0 + 0.06) / tempo);
}

// Renderiza un grupo de stems (melódicos o rítmicos) ya con su procesador. Devuelve [L, R] alineados al inicio del tema.
async function renderGroup(entries, anySolo, tempo, semis, outSec, onStep) {
  const ctx = new OfflineAudioContext(2, bufLen(outSec + 0.6), SR);
  const useST = Math.abs(tempo - 1) > 0.001 || semis !== 0;
  let latency = 0, st = null;
  if (useST) {
    await SoundTouchNode.register(ctx, './vendor/soundtouch-processor.js');
    st = new SoundTouchNode({ context: ctx });
    st.playbackRate.value = tempo; st.pitchSemitones.value = semis;
    st.connect(ctx.destination);
    latency = await measureLatency(tempo, semis);
  }
  for (const [, s] of entries) {
    const g = effectiveGain(s, anySolo); if (g <= 0.0001) continue;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = s.buffer; src.playbackRate.value = tempo; gain.gain.value = g;
    src.connect(gain); gain.connect(st || ctx.destination); src.start(0);
  }
  onStep();
  const r = await ctx.startRendering();
  const skip = Math.round(latency * SR), n = bufLen(outSec);
  const ch = [0, 1].map(c => { const o = new Float32Array(n), src = r.getChannelData(Math.min(c, r.numberOfChannels - 1)); o.set(src.subarray(skip, skip + n)); return o; });
  return { ch, latency };
}

function toWav16(L, R) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (const x of [L[i], R[i]]) { v.setInt16(o, Math.max(-1, Math.min(1, x)) * 32767, true); o += 2; }
  return buf;
}

// opts: { name, title, range: {a, b} | null (tramo del tema original), onProgress(texto) }
export async function exportMp3(engine, opts = {}) {
  const say = opts.onProgress || (() => {});
  const tempo = engine.tempo, semis = engine.semitones;
  const anySolo = Object.values(engine.stems).some(s => s.solo);
  const mel = Object.entries(engine.stems).filter(([n]) => !RHYTHMIC.has(n));
  const rhy = Object.entries(engine.stems).filter(([n]) => RHYTHMIC.has(n));
  const outSec = engine.duration / tempo;
  say('Mezclando…');
  const parts = [];
  if (mel.length) parts.push(await renderGroup(mel, anySolo, tempo, semis, outSec, () => say('Procesando instrumentos melódicos…')));
  if (rhy.length) parts.push(await renderGroup(rhy, anySolo, tempo, 0, outSec, () => say('Procesando batería…')));
  const n = parts[0].ch[0].length, L = new Float32Array(n), R = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < n; i++) { L[i] += p.ch[0][i]; R[i] += p.ch[1][i]; }
  const m = engine.masterVol; let peak = 0;
  for (let i = 0; i < n; i++) { L[i] *= m; R[i] *= m; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  const g = peak > 0.99 ? 0.99 / peak : 1;                       // sin saturar: si se pasa, se baja todo parejo
  if (g < 1) for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  let a = 0, b = n;
  if (opts.range) { a = Math.max(0, Math.floor(opts.range.a / tempo * SR)); b = Math.min(n, Math.ceil(opts.range.b / tempo * SR)); }
  if (peak < 1e-4) throw new Error('La mezcla está en silencio (todo en mute o con volumen 0).');
  const wav = toWav16(L.subarray(a, b), R.subarray(a, b));
  if (data.readOnly) return { blob: wav instanceof Blob ? wav : new Blob([wav], { type: 'audio/wav' }), ext: 'wav', latencies: parts.map(p => +p.latency.toFixed(3)), peak: +peak.toFixed(3), reduced: g < 1 };   // en el celu no hay servidor para el MP3: se baja el WAV
  say('Convirtiendo a MP3…');
  const q = new URLSearchParams({ name: opts.name || 'mezcla', title: opts.title || '' });
  const res = await fetch('/api/export/mp3?' + q, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  if (!res.ok) throw new Error('No se pudo crear el MP3: ' + (await res.text()).slice(0, 200));
  return { blob: await res.blob(), latencies: parts.map(p => +p.latency.toFixed(3)), peak: +peak.toFixed(3), reduced: g < 1 };
}
