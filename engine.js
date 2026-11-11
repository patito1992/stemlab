// Motor de audio v5.
//  - El AudioContext se crea en el momento del primer clic en "play" (dentro del gesto del usuario), así el navegador
//    lo arranca ya activo; la decodificación de los stems usa un contexto offline aparte.
//  - Antes de programar el audio se espera a que el reloj del contexto esté corriendo de verdad.
//  - Los stems se mezclan en 2 buses (melódicos / rítmicos). Mientras no haya transposición se usa UN solo procesador
//    de tempo para todo; con tempo 100% y sin transposición el audio va directo (sin procesar).
//  - latencyHint 'playback': buffers más grandes = menos cortes.
import { SoundTouchNode } from './vendor/soundtouch-node.js';
import * as data from './data.js';

export const STEM_LABELS = {
  vocals: 'Voz', drums: 'Batería', bass: 'Bajo', guitar: 'Guitarra', piano: 'Teclado', other: 'Otros (vientos y resto)',
};
export const STEM_ORDER = ['vocals', 'guitar', 'piano', 'bass', 'drums', 'other'];
export const RHYTHMIC = new Set(['drums']);   // no se transponen (hito 6); el resto es melódico

// Ganancia efectiva de un stem: si hay algún solo activo, suenan solo los solos; si no, todos salvo los muteados.
export function effectiveGain(state, anySolo) {
  if (anySolo) return state.solo ? state.vol : 0;
  return state.muted ? 0 : state.vol;
}

const START_LEAD = 0.2;   // segundos de margen para programar el arranque
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Engine {
  constructor() {
    this.ctx = null; this.master = null; this.analyser = null;
    this.stems = {};            // nombre -> {buffer, vol, muted, solo, gain, src}
    this.buses = {};            // 'mel' | 'rhy' -> {in: GainNode, st: SoundTouchNode|null}
    this.duration = 0;
    this.playing = false;
    this.tempo = 1;             // 1 = original. El tono NO cambia.
    this.semitones = 0;         // transposición de los instrumentos melódicos (hito 6)
    this.masterVol = 1;
    this.analysis = null;       // {bpm, beats, meter, downbeat_phase, key, chords}
    this.clickOn = false; this.clickVol = 0.7; this.clickFreq = 1700; this.subdiv = 1; this.countIn = 0; this.clickNudge = 0;
    this._ci = 0; this._ck = 0; this._clickTimer = null; this.clickGain = null; this._clickBufs = null;
    this.loopA = null; this.loopB = null; this.loopOn = false; this._lc = 0;   // loop A-B
    this.onLoopChange = () => {};
    this._offset = 0;           // posición (s) del tema original en pausa
    this._anchorCtx = 0; this._anchorPos = 0;
    this._busy = false; this._wl = null; this._wlReady = false;
    this.onEnded = () => {};
    this.log = [];
  }
  _log(msg) {
    this.log.push(`${(performance.now() / 1000).toFixed(2)}s ${msg}`);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- carga (solo decodifica; no toca el audio del navegador) -----------------------------
  async load(songId, onProgress = () => {}) {
    const decoder = new OfflineAudioContext(2, 1, 44100);
    const stems = await data.stemNames(songId);
    if (!stems.length) throw new Error('Este tema todavía no tiene stems.');
    let done = 0;
    await Promise.all(stems.map(async name => {
      const buffer = await decoder.decodeAudioData(await data.stemAudio(songId, name));
      this.stems[name] = { buffer, vol: 1, muted: false, solo: false, gain: null, src: null };
      this.duration = Math.max(this.duration, buffer.duration);
      onProgress(++done, stems.length);
    }));
    this._log(`stems cargados (${stems.length}), duración ${this.duration.toFixed(1)} s`);
    return Object.keys(this.stems);
  }

  // ---- grafo de audio (se crea en el primer play) -------------------------------------------
  _initGraph() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    this._log(`AudioContext creado: estado ${this.ctx.state}, ${this.ctx.sampleRate} Hz`);
    this.ctx.onstatechange = () => {
      this._log(`audio: estado ${this.ctx.state}`);
      if (this.playing && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    };
    this.master = this.ctx.createGain(); this.master.gain.value = this.masterVol;
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    this.master.connect(this.analyser); this.master.connect(this.ctx.destination);
    this.clickGain = this.ctx.createGain(); this.clickGain.gain.value = this.clickVol; this.clickGain.connect(this.master);
    this._buildClickBufs();
    for (const k of ['mel', 'rhy']) this.buses[k] = { in: this.ctx.createGain(), st: null };
    for (const [name, s] of Object.entries(this.stems)) {
      s.gain = this.ctx.createGain();
      s.gain.connect(this.buses[RHYTHMIC.has(name) ? 'rhy' : 'mel'].in);
    }
    this._buildBuses();
    this._applyGains();
  }

  // ---- buses y procesadores de tempo/tono ----------------------------------------------------
  // El procesador (AudioWorklet) se carga SOLO cuando hace falta.
  get _needST() { return Math.abs(this.tempo - 1) > 0.001 || this.semitones !== 0; }
  get _useST() { return this._needST && this._wlReady; }
  async _ensureWorklet() {
    if (!this.ctx) return;
    if (!this._wl) this._wl = SoundTouchNode.register(this.ctx, './vendor/soundtouch-processor.js');
    try { await this._wl; this._wlReady = true; } catch (err) { this._wl = null; throw err; }
  }

  _buildBuses() {   // crea procesadores NUEVOS (sin restos de audio anterior) y cablea según el modo
    if (!this.ctx) return;
    const shared = this.semitones === 0;      // sin transposición: ambos buses comparten un único procesador
    for (const bus of Object.values(this.buses)) {
      bus.in.disconnect();
      if (bus.st) { bus.st.disconnect(); bus.st = null; }
    }
    if (!this._useST) {
      for (const bus of Object.values(this.buses)) bus.in.connect(this.master);
      return;
    }
    const mel = this.buses.mel, rhy = this.buses.rhy;
    mel.st = new SoundTouchNode({ context: this.ctx });
    mel.in.connect(mel.st); mel.st.connect(this.master);
    if (shared) rhy.in.connect(mel.st);
    else { rhy.st = new SoundTouchNode({ context: this.ctx }); rhy.in.connect(rhy.st); rhy.st.connect(this.master); }
    this._applyParams();
  }
  _applyParams() {
    const { mel, rhy } = this.buses;
    if (mel.st) { mel.st.playbackRate.value = this.tempo; mel.st.pitchSemitones.value = this.semitones; }
    if (rhy.st) { rhy.st.playbackRate.value = this.tempo; rhy.st.pitchSemitones.value = 0; }
  }

  _applyGains() {
    if (!this.ctx) return;
    const anySolo = Object.values(this.stems).some(s => s.solo);
    for (const s of Object.values(this.stems)) s.gain.gain.value = effectiveGain(s, anySolo);
  }
  setVolume(name, v) { this.stems[name].vol = v; this._applyGains(); }
  setMuted(name, m) { this.stems[name].muted = m; this._applyGains(); }
  setSolo(name, m) { this.stems[name].solo = m; this._applyGains(); }
  setMaster(v) { this.masterVol = v; if (this.master) this.master.gain.value = v; }

  // ---- transporte -----------------------------------------------------------------------------
  get position() {
    if (!this.playing) return this._offset;
    const dt = Math.max(0, this.ctx.currentTime - this._anchorCtx);
    let p = Math.min(this._anchorPos + dt * this.tempo, this.duration);
    const L = this._loop();
    if (L && p >= L.b) p = L.a + ((p - L.a) % (L.b - L.a));
    return p;
  }
  get audiblePosition() {   // lo que realmente se está escuchando (descuenta la latencia del procesador y de la salida)
    const lag = (this._useST ? 0.11 : 0) + (this.ctx && this.ctx.outputLatency ? this.ctx.outputLatency : 0);
    return Math.max(0, this.position - lag * this.tempo);
  }
  _loop() {   // {a,b} si el loop está activo y es válido
    return (this.loopOn && this.loopA != null && this.loopB != null && this.loopB - this.loopA >= 0.3)
      ? { a: this.loopA, b: this.loopB } : null;
  }
  // a, b en segundos del tema original (null = sin marcar). Con 'on' el tramo se repite sin cortes.
  setLoop(a, b, on) {
    const p = this.playing ? this.position : this._offset;
    this.loopA = a; this.loopB = b;
    this.loopOn = !!on && a != null && b != null && b - a >= 0.3;
    const L = this._loop(); const t = L && p >= L.b ? L.a : p;
    if (this.playing) this.seek(t); else this._offset = t;
  }

  _startSources(offset, whenAt) {
    const when = whenAt ?? this.ctx.currentTime + START_LEAD;
    for (const [name, s] of Object.entries(this.stems)) {
      const src = this.ctx.createBufferSource();
      src.buffer = s.buffer; src.playbackRate.value = this.tempo;
      const L = this._loop(); if (L) { src.loop = true; src.loopStart = L.a; src.loopEnd = L.b; }
      src.connect(s.gain); src.start(when, offset);
      src.onended = () => this._log(`fuente '${name}' terminó (pos ${this.position.toFixed(2)})`);
      s.src = src;
    }
    this._anchorCtx = when; this._anchorPos = offset; this._lc = 0;
    this._resetClickPointer(offset); this._startClickTimer();
    this._log(`arranque en ${offset.toFixed(2)}s, tempo ${this.tempo}, modo ${this._useST ? 'procesado' : 'directo'}`);
  }
  _stopSources() {
    this._stopClickTimer();
    for (const s of Object.values(this.stems)) {
      if (s.src) { s.src.onended = null; try { s.src.stop(); } catch {} s.src.disconnect(); s.src = null; }
    }
  }
  async _clockReady() {   // espera a que el reloj del contexto esté realmente avanzando
    const c = this.ctx, t0 = c.currentTime, w0 = performance.now();
    while (c.currentTime <= t0 + 0.01 && performance.now() - w0 < 1500) await sleep(15);
    this._log(`reloj listo tras ${Math.round(performance.now() - w0)} ms (t=${c.currentTime.toFixed(3)})`);
  }

  async play() {
    if (this.playing || this._busy) return;      // evita arranques dobles
    this._busy = true; this._log('play pedido');
    try {
      if (!this.ctx) this._initGraph();           // dentro del gesto del usuario
      const w0 = performance.now();
      await Promise.race([this.ctx.resume(), sleep(2500)]);
      this._log(`resume: estado ${this.ctx.state} en ${Math.round(performance.now() - w0)} ms`);
      if (this.ctx.state !== 'running')
        throw new Error(`El navegador no activó el audio (estado: ${this.ctx.state}). Hacé clic de nuevo en play.`);
      await this._clockReady();
      if (this._needST && !this._wlReady) { await this._ensureWorklet(); this._buildBuses(); }
      if (this._offset >= this.duration - 0.05) this._offset = 0;
      { const L = this._loop(); if (L && this._offset >= L.b) this._offset = L.a; }
      const when0 = this.ctx.currentTime + START_LEAD;
      const musicAt = this._scheduleCountIn(this._offset, when0);
      this._startSources(this._offset, musicAt);
      this.playing = true;
    } finally { this._busy = false; }
  }
  checkEnd() {   // fin del tema: se detecta por posición
    if (this.playing && this.position >= this.duration - 0.05) { this._log('fin del tema'); this.pause(); this._offset = 0; this.onEnded(); }
  }
  pause() {
    if (!this.playing) return;
    this._log('pausa pedida desde: ' + (new Error().stack.split('\n')[2] || '?').trim().slice(0, 90));
    this._offset = this.position;
    this._stopSources();
    this.playing = false;
    this._buildBuses();          // deja procesadores limpios y listos para el próximo play
  }
  seek(t) {
    t = Math.max(0, Math.min(t, this.duration));
    const L = this._loop();
    if (L && t >= L.b) { this.loopOn = false; this.onLoopChange(); }   // saltar más allá del tramo apaga el loop
    if (this.playing) { this._stopSources(); this._buildBuses(); this._startSources(t); }
    else this._offset = t;
  }
  _restartHere() { if (this.playing) this.seek(this.position); }

  async setTempo(r) {
    r = Math.max(0.25, Math.min(r, 2));
    if (Math.abs(r - 1) > 0.001 && this.ctx && !this._wlReady) await this._ensureWorklet();
    const modeBefore = this._useST;
    if (this.playing) { this._anchorPos = this.position; this._anchorCtx = this.ctx.currentTime; }
    this.tempo = r; this._lc = 0;
    if (!this.ctx) return;                       // todavía sin audio: se aplica en el primer play
    if (this._useST !== modeBefore) {            // entra o sale del modo "procesado": se recablea limpio
      if (this.playing) this._restartHere(); else this._buildBuses();
      return;
    }
    for (const s of Object.values(this.stems)) if (s.src) s.src.playbackRate.value = r;
    this._applyParams();
  }

  // Transposición: solo los stems melódicos (todos menos la batería). La batería pasa por su propio procesador sin cambio de tono.
  async setSemitones(n) {
    n = Math.max(-12, Math.min(12, Math.round(n)));
    if (n !== 0 && this.ctx && !this._wlReady) await this._ensureWorklet();
    const was = this.semitones, modeBefore = this._useST;
    if (this.playing) { this._anchorPos = this.position; this._anchorCtx = this.ctx.currentTime; }
    this.semitones = n; this._lc = 0;
    if (!this.ctx) return;
    if ((was === 0) !== (n === 0) || this._useST !== modeBefore) {   // cambia el cableado (1 o 2 procesadores)
      if (this.playing) this._restartHere(); else this._buildBuses();
      return;
    }
    this._applyParams();
  }

  // ---- click, pre-conteo y subdivisiones ------------------------------------------------------
  setAnalysis(a) { this.analysis = a; }
  get hasBeats() { return !!(this.analysis && this.analysis.beats && this.analysis.beats.length > 4); }
  setClickOn(b) { this.clickOn = b; }
  setClickVol(v) { this.clickVol = v; if (this.clickGain) this.clickGain.gain.value = v; }
  setClickFreq(f) { this.clickFreq = f; if (this.ctx) this._buildClickBufs(); }   // tono del acento; el resto guarda las mismas proporciones
  _buildClickBufs() {
    const f = this.clickFreq;
    this._clickBufs = { accent: this._makeClick(f, 1.0), beat: this._makeClick(f * 0.68, 0.8), sub: this._makeClick(f * 0.48, 0.5) };
  }
  setSubdiv(n) { this.subdiv = n; this._ck = 0; }
  setCountIn(bars) { this.countIn = bars; }
  setClickNudge(ms) { this.clickNudge = ms / 1000; }

  _makeClick(freq, amp) {
    const sr = this.ctx.sampleRate, n = Math.floor(sr * 0.045), buf = this.ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * freq * i / sr) * Math.exp(-i / (sr * 0.008));
    return buf;
  }
  _playClick(when, type) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._clickBufs[type]; src.connect(this.clickGain); src.start(when);
    return src;
  }
  _clickDelay() { return (this._useST ? 0.11 : 0) + this.clickNudge; }   // el procesador de tempo retrasa ~110 ms el audio
  _beatIndexAt(t) {
    const B = this.analysis.beats; let lo = 0, hi = B.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (B[m] < t - 0.02) lo = m + 1; else hi = m; }
    return lo;
  }
  _clickEvent(i, k) {
    const a = this.analysis, B = a.beats, meter = a.meter || 4, ph = a.downbeat_phase || 0;
    const period = i + 1 < B.length ? B[i + 1] - B[i] : B[i] - B[i - 1];
    const t = B[i] + period * k / this.subdiv;
    const type = k ? 'sub' : ((((i - ph) % meter) + meter) % meter === 0 ? 'accent' : 'beat');
    return { t, type };
  }
  _resetClickPointer(offset) { if (this.hasBeats) { this._ci = this._beatIndexAt(offset); this._ck = 0; } }
  _startClickTimer() { this._stopClickTimer(); this._clickTimer = setInterval(() => this._clickTick(), 25); }
  _stopClickTimer() { if (this._clickTimer) { clearInterval(this._clickTimer); this._clickTimer = null; } }
  _clickTick() {
    if (!this.playing || !this.clickOn || !this.hasBeats) return;
    const B = this.analysis.beats, horizon = this.ctx.currentTime + 0.3, L = this._loop();
    let guard = 0;
    while (this._ci < B.length) {
      let ev = this._clickEvent(this._ci, this._ck);
      if (L && ev.t >= L.b - 0.001) {                  // llegó al final del tramo: sigue desde A (un ciclo más)
        this._ci = this._beatIndexAt(L.a); this._ck = 0; this._lc++;
        if (++guard > 2 || this._ci >= B.length) break;
        continue;
      }
      const when = this._anchorCtx + ((ev.t - this._anchorPos) + (L ? this._lc * (L.b - L.a) : 0)) / this.tempo + this._clickDelay();
      if (when > horizon) break;
      if (when >= this.ctx.currentTime) this._playClick(when, ev.type);
      if (++this._ck >= this.subdiv) { this._ck = 0; this._ci++; }
    }
  }
  _scheduleCountIn(offset, when0) {   // devuelve el instante en que arranca la música
    if (!this.countIn || !this.hasBeats) return when0;
    const B = this.analysis.beats, i = Math.min(this._beatIndexAt(offset), B.length - 2);
    const period = (B[i + 1] - B[i]) / this.tempo, meter = this.analysis.meter || 4, n = this.countIn * meter;
    const sd = Math.max(1, this.subdiv | 0), d = this._clickDelay();
    for (let j = 0; j < n; j++) {
      this._playClick(when0 + d + j * period, j % meter === 0 ? 'accent' : 'beat');
      for (let k = 1; k < sd; k++) this._playClick(when0 + d + (j + k / sd) * period, 'sub');   // mismas subdivisiones que el click
    }
    // el primer pulso de la música (B[i]) tiene que caer justo donde sería el click n+1 del pre-conteo
    const gap = (B[i] - offset) / this.tempo;
    this._log(`pre-conteo: ${n} tiempos x${sd}, pulso de entrada a ${gap.toFixed(3)} s`);
    return when0 + n * period - gap;
  }

  // ---- diagnóstico -----------------------------------------------------------------------------
  expectSound() {   // ¿debería estar saliendo audio? (false si todo está en mute / volumen 0)
    const anySolo = Object.values(this.stems).some(s => s.solo);
    return Object.values(this.stems).some(s => effectiveGain(s, anySolo) > 0.01) && this.masterVol > 0.01;
  }
  level() {   // nivel de salida 0..1
    if (!this.analyser) return 0;
    const a = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(a);
    let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m;
  }
  diagnostics() {
    const c = this.ctx; if (!c) return { estado: 'sin iniciar (se crea al dar play)' };
    const ps = c.playoutStats;
    return {
      estado: c.state, frecuencia: c.sampleRate, latenciaBase: +(c.baseLatency || 0).toFixed(3),
      latenciaSalida: +(c.outputLatency || 0).toFixed(3), modo: this._useST ? 'procesado' : 'directo',
      tempo: this.tempo, nivel: +this.level().toFixed(3), cortes: ps ? ps.underrunEvents : 'n/d',
    };
  }
}
