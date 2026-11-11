import { Engine, STEM_LABELS, STEM_ORDER } from './engine.js';
import { keyName, chordList } from './chords.js';
import { exportMp3 } from './export.js';
import { setupLyrics } from './lyrics.js';
import { initPanels } from './ui.js';
import * as data from './data.js';

const STEM_COLORS = { vocals: '#ff6b9d', guitar: '#ffb74d', piano: '#4fc3f7', bass: '#5eead4', drums: '#ff8a65', other: '#b39ddb' };
initPanels(document.querySelector('#foldAll'));
if (data.readOnly) document.querySelector('#exportBtn').textContent = 'Exportar WAV';
const $ = s => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const showWarn = msg => { const w = $('#warn'); w.textContent = msg; w.classList.remove('hidden'); };
window.addEventListener('error', e => showWarn('Error: ' + e.message));
window.addEventListener('unhandledrejection', e => showWarn('Error: ' + (e.reason?.message || e.reason)));
const engine = new Engine();
window.__engine = engine;   // para depuración
let seeking = false, lyricsUI = null;
const wave = { stems: {}, mix: null };

async function init() {
  const song = await data.song(id);
  $('#title').textContent = song.title;
  lyricsUI = setupLyrics(engine, id, song.title, d => { hasLyrics = !!d?.synced; updateLive(); });
  document.title = song.title + ' · StemLab';
  let names;
  try {
    names = await engine.load(id, (d, n) => {
      $('#loadmsg').textContent = `Cargando stems (${d}/${n})…`;
      $('#loadbar').style.width = (d / n * 100) + '%';
    });
  } catch (e) { $('#loadmsg').textContent = 'Error: ' + e.message; return; }
  // análisis previo (BPM, tonalidad, compases): si no existe, el click y el BPM quedan deshabilitados
  let analysis = null;
  try { analysis = await data.analysis(id); } catch {}
  engine.setAnalysis(analysis);
  setupAnalysis(analysis);
  names.sort((a, b) => STEM_ORDER.indexOf(a) - STEM_ORDER.indexOf(b));
  $('#stems').innerHTML = names.map(n => {
    const full = STEM_LABELS[n] || n, short = full.split(' (')[0];
    return `<div class="lane" data-n="${n}" style="--c:${STEM_COLORS[n] || '#b39ddb'}">
      <div class="lh" title="${full}"><i></i><span>${short}</span></div>
      <div class="lw"><canvas class="wv base"></canvas><canvas class="wv fill"></canvas><div class="playhead"></div></div>
      <div class="lc"><input type="range" min="0" max="1.5" step="0.01" value="1" data-vol aria-label="Volumen de ${short}">
        <button class="m" data-mute title="Silenciar ${short}">M</button><button class="s" data-solo title="Solo ${short}">S</button></div></div>`;
  }).join('');
  computeWaves(names);
  $('#loading').classList.add('hidden'); $('#player').classList.remove('hidden'); $('#dock').classList.remove('hidden');
  drawWaves(); watchResize();
  $('#time').textContent = `0:00 / ${fmt(engine.duration)}`;
  tick();
}

$('#stems').addEventListener('input', e => {
  if (e.target.matches('[data-vol]')) engine.setVolume(e.target.closest('.lane').dataset.n, +e.target.value);
});
$('#stems').addEventListener('click', e => {
  const row = e.target.closest('.lane'); if (!row) return;
  const n = row.dataset.n;
  if (e.target.matches('[data-mute]')) { const v = !engine.stems[n].muted; engine.setMuted(n, v); e.target.classList.toggle('on', v); }
  if (e.target.matches('[data-solo]')) { const v = !engine.stems[n].solo; engine.setSolo(n, v); e.target.classList.toggle('on', v); }
  const anySolo = Object.values(engine.stems).some(s => s.solo);
  document.querySelectorAll('.lane[data-n]').forEach(r => {
    const s = engine.stems[r.dataset.n];
    r.classList.toggle('dim', anySolo ? !s.solo : s.muted);
  });
});
function setTempoPct(p) {
  p = Math.max(40, Math.min(180, Math.round(p)));
  $('#tempo').value = p; $('#tempoVal').textContent = p + '%'; updateBpmNow(p);
  engine.setTempo(p / 100).catch(e => showWarn('No se pudo activar el cambio de tempo: ' + (e.message || e)));
}
$('#tempo').oninput = e => setTempoPct(+e.target.value);
$('#tempoDown').onclick = () => setTempoPct(+$('#tempo').value - 5);
$('#tempoUp').onclick = () => setTempoPct(+$('#tempo').value + 5);
$('#tempoReset').onclick = () => setTempoPct(100);
$('#master').oninput = e => engine.setMaster(+e.target.value);

let lastToggle = 0, lastUser = 0;
async function toggle() {
  const now = performance.now();
  if (now - lastToggle < 300) { engine._log('clic repetido ignorado'); return; }   // anti doble disparo
  lastToggle = lastUser = now;
  try { if (engine.playing) engine.pause(); else await engine.play(); }
  catch (e) { showWarn(e.message || String(e)); }
  $('#play').textContent = engine.playing ? '⏸' : '▶';
  if (engine.playing) {   // si en ~1,5 s no sale audio estando todo habilitado, avisar con datos
    setTimeout(() => {
      if (engine.playing && engine.expectSound() && engine.level() < 0.0005)
        showWarn('No se detecta audio saliendo. Datos: ' + Object.entries(engine.diagnostics()).map(([k, v]) => `${k}: ${v}`).join(' · ') + ' | Registro: ' + engine.log.slice(-8).join(' | '));
    }, 1500);
  }
}
$('#play').onclick = e => {
  e.currentTarget.blur(); toggle();
  setTimeout(() => { if (!engine.playing && engine._busy) showWarn('El audio tarda en arrancar. Registro: ' + engine.log.slice(-6).join(' | ')); }, 3000);
};
engine.onEnded = () => { lastUser = performance.now(); $('#play').textContent = '▶'; };
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.target.matches('input[type=range]')) { e.preventDefault(); toggle(); }
});

const seekEl = $('#seek');
seekEl.addEventListener('pointerdown', () => seeking = true);
seekEl.addEventListener('input', () => { $('#time').textContent = `${fmt(seekEl.value / 1000 * engine.duration)} / ${fmt(engine.duration)}`; });
seekEl.addEventListener('change', () => { engine.seek(seekEl.value / 1000 * engine.duration); seeking = false; });

let wasPlaying = false;
function tick() {
  engine.checkEnd();
  if (wasPlaying && !engine.playing && performance.now() - lastUser > 600 && engine.position < engine.duration - 0.2)
    showWarn('La reproducción se detuvo sola. Registro: ' + engine.log.slice(-8).join(' | '));
  wasPlaying = engine.playing;
  $('#play').textContent = engine.playing ? '⏸' : '▶';
  if (!seeking) {
    const p = engine.position;
    seekEl.value = engine.duration ? p / engine.duration * 1000 : 0;
    $('#time').textContent = `${fmt(p)} / ${fmt(engine.duration)}`;
  }
  updateChords(); lyricsUI?.update(); paintProgress();
  requestAnimationFrame(tick);
}
init();

// Diagnóstico: se muestra con la tecla D (útil si algo suena mal)
let diagOn = false;
document.addEventListener('keydown', e => { if (e.key === 'd' || e.key === 'D') { diagOn = !diagOn; $('#diag').style.display = diagOn ? '' : 'none'; } });
$('#diag').style.display = 'none';
setInterval(() => {
  if (!diagOn) return;
  $('#diag').textContent = Object.entries(engine.diagnostics()).map(([k, v]) => `${k}: ${v}`).join(' · ') + '\n' + engine.log.slice(-12).join('\n');
}, 500);

// ---- análisis, BPM, click ------------------------------------------------------------------
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let songBpm = 0;
function updateBpmNow(p) { if (songBpm) $('#bpmNow').textContent = `→ ${(songBpm * p / 100).toFixed(1)} BPM ahora`; }
function setupAnalysis(a) {
  const clickCtl = ['#clickVol', '#clickToggle', '#subdiv', '#countin', '#nudge'];
  if (!a) {
    $('#info').innerHTML = '<span class="chip">Sin análisis: no hay click ni acordes</span>';
    clickCtl.concat(['#bpmTarget']).forEach(s => $(s).disabled = true); return;
  }
  songBpm = a.bpm; songAnalysis = a; renderTranspose();
  $('#info').innerHTML = `<span class="chip acc">${a.bpm.toFixed(1)} BPM</span><span class="chip">${a.key.name}${a.key.mode === 'minor' ? ' menor' : ' mayor'}</span><span class="chip">${a.meter}/4</span>`;
  $('#bpmTarget').placeholder = Math.round(a.bpm); updateBpmNow(100);
}
$('#bpmTarget').addEventListener('change', e => {
  const v = +e.target.value; if (!songBpm || !v) return;
  setTempoPct(v / songBpm * 100);
});
$('#clickToggle').onclick = e => { const on = !engine.clickOn; engine.setClickOn(on); e.target.textContent = on ? 'Encendido' : 'Apagado'; e.target.classList.toggle('on', on); };
$('#clickVol').oninput = e => engine.setClickVol(+e.target.value);
$('#subdiv').onchange = e => engine.setSubdiv(+e.target.value);
$('#countin').onchange = e => engine.setCountIn(+e.target.value);
$('#nudge').onchange = e => engine.setClickNudge(+e.target.value || 0);

// ---- transposición (solo instrumentos melódicos) y cifrado -----------------------------------
let chLead = 0, semis = 0, chShift = 0, chSimple = false, songAnalysis = null, curChords = [], chIdx = -2, hasChords = false, hasLyrics = false;
try { chShift = Math.max(-12, Math.min(12, +localStorage.getItem('stemlab.chShift.' + id) || 0)); } catch {}
try { chSimple = localStorage.getItem('stemlab.chSimple') === '1'; } catch {}
function renderTranspose() {
  $('#chSimple').checked = chSimple;
  $('#semiVal').textContent = (semis > 0 ? '+' : '') + semis;
  const a = songAnalysis;
  $('#keyNow').textContent = a ? (semis ? `${keyName(a.key)} → ${keyName(a.key, semis)}` : `Tonalidad ${keyName(a.key)}`) : (semis ? 'Batería sin cambios' : '');
  if (a && a.chords && a.chords.length) {
    $('#chVal').textContent = (chShift > 0 ? '+' : '') + chShift;
    const tot = semis + chShift;
    $('#chKey').textContent = `Cifrado en ${keyName(a.key, tot)}` + (tot ? ` (la canción suena en ${keyName(a.key, semis)})` : '');
    $('#p-chords').classList.remove('hidden'); hasChords = true; updateLive(); chIdx = -2;
    $('#chordList').innerHTML = (curChords = chordList(a, semis + chShift, chSimple)).map((c, i) => `<span data-i="${i}" title="${fmt(c.start)}">${c.name}</span>`).join('');
  }
}
function setSemis(n) {
  semis = Math.max(-12, Math.min(12, n)); renderTranspose();
  engine.setSemitones(semis).catch(e => showWarn('No se pudo activar la transposición: ' + (e.message || e)));
}
$('#semiDown').onclick = () => setSemis(semis - 1);
$('#semiUp').onclick = () => setSemis(semis + 1);
$('#semiReset').onclick = () => setSemis(0);
// Los acordes se transponen aparte: no tocan el audio, solo el cifrado que ves (suma a la transposición del tono).
function setChShift(n) {
  chShift = Math.max(-12, Math.min(12, n)); renderTranspose();
  try { localStorage.setItem('stemlab.chShift.' + id, chShift); } catch {}
}
$('#chDown').onclick = () => setChShift(chShift - 1);
$('#chUp').onclick = () => setChShift(chShift + 1);
$('#chSimple').onchange = e => { chSimple = e.target.checked; try { localStorage.setItem('stemlab.chSimple', chSimple ? '1' : '0'); } catch {} renderTranspose(); };
try { chLead = +localStorage.getItem('stemlab.chLead') || 0; $('#chLead').value = chLead; } catch {}
$('#chLead').onchange = e => { chLead = Math.max(-1000, Math.min(1000, +e.target.value || 0)); e.target.value = chLead; chIdx = -2; try { localStorage.setItem('stemlab.chLead', chLead); } catch {} updateChords(); };
$('#chReset').onclick = () => setChShift(0);

// ---- acordes en pantalla (actual + próximos) --------------------------------------------------
function updateChords() {
  if (!curChords.length) return;
  const t = engine.audiblePosition + chLead / 1000;
  let lo = 0, hi = curChords.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (curChords[m].start <= t + 0.03) lo = m + 1; else hi = m; }
  const i = Math.max(0, lo - 1);
  if (i === chIdx) return;
  chIdx = i;
  $('#chCur').textContent = curChords[i].name;
  $('#chNext').innerHTML = curChords.slice(i + 1, i + 4).map(c => `<span>${c.name}</span>`).join('');
  const list = $('#chordList'); list.querySelector('.now')?.classList.remove('now');
  const el = list.querySelector(`[data-i="${i}"]`);
  if (el) { el.classList.add('now'); if (list.offsetParent) list.scrollTop = el.offsetTop - list.offsetTop - 40; }
}

// ---- loop A-B ---------------------------------------------------------------------------------
let lA = null, lB = null, lOn = false;
function snapTime(t) {
  if (!$('#snap').checked || !songAnalysis?.beats?.length) return t;
  const B = songAnalysis.beats; let best = B[0];
  for (const b of B) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
  return best;
}
function applyLoop() {
  if (lA != null && lB != null && lB - lA < 0.3) lB = null;
  lOn = lOn && lA != null && lB != null;
  engine.setLoop(lA, lB, lOn); renderLoop();
}
function renderLoop() {
  const on = engine.loopOn; lOn = on;
  $('#loopToggle').textContent = on ? 'Loop: sí' : 'Loop: no'; $('#loopToggle').classList.toggle('on', on);
  $('#loopA').classList.toggle('on', lA != null); $('#loopB').classList.toggle('on', lB != null);
  $('#exportLoop').disabled = !(lA != null && lB != null); if ($('#exportLoop').disabled) $('#exportLoop').checked = false;
  $('#loopInfo').textContent = lA == null ? '' : `A ${fmt(lA)}${lB != null ? ' · B ' + fmt(lB) : ''}`;
  const r = $('#loopRegion'), d = engine.duration;
  if (lA != null && lB != null && d) { r.classList.remove('hidden'); r.style.left = (lA / d * 100) + '%'; r.style.width = ((lB - lA) / d * 100) + '%'; }
  else r.classList.add('hidden');
}
$('#loopA').onclick = () => { lA = snapTime(engine.position); if (lB != null && lB - lA < 0.3) lB = null; lOn = false; applyLoop(); };
$('#loopB').onclick = () => {
  if (lA == null) lA = 0;
  const b = snapTime(engine.position); if (b - lA < 0.3) return;
  lB = b; lOn = true; applyLoop();
};
$('#loopToggle').onclick = () => { if (lA == null || lB == null) return; lOn = !engine.loopOn; applyLoop(); };
$('#loopClear').onclick = () => { lA = lB = null; lOn = false; applyLoop(); };
engine.onLoopChange = () => renderLoop();

// ---- exportar MP3 ------------------------------------------------------------------------------
let exporting = false;
$('#exportBtn').onclick = async () => {
  if (exporting) return;
  exporting = true; $('#exportBtn').disabled = true;
  const msg = t => $('#exportMsg').textContent = t;
  try {
    const wasPlaying = engine.playing; if (wasPlaying) engine.pause();
    const tempoPct = Math.round(engine.tempo * 100), muted = Object.entries(engine.stems).filter(([, s]) => s.muted).map(([n]) => STEM_LABELS[n]?.split(' ')[0] || n);
    const anySolo = Object.values(engine.stems).some(s => s.solo);
    const solos = Object.entries(engine.stems).filter(([, s]) => s.solo).map(([n]) => STEM_LABELS[n]?.split(' ')[0] || n);
    const tags = [];
    if (tempoPct !== 100) tags.push(tempoPct + '%');
    if (engine.semitones) tags.push((engine.semitones > 0 ? '+' : '') + engine.semitones + ' st');
    if (anySolo) tags.push('solo ' + solos.join('+')); else if (muted.length) tags.push('sin ' + muted.join(', '));
    const title = $('#title').textContent;
    const range = $('#exportLoop').checked && lA != null && lB != null ? { a: lA, b: lB } : null;
    const name = title + (tags.length ? ' (' + tags.join(', ') + ')' : '');
    const r = await exportMp3(engine, { name, title: name, range, onProgress: msg });
    const url = URL.createObjectURL(r.blob), a = document.createElement('a');
    a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, '') + '.' + (r.ext || 'mp3'); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    msg(`Listo: ${r.blob.size > 1048576 ? (r.blob.size / 1048576).toFixed(1) + ' MB' : Math.round(r.blob.size / 1024) + ' KB'}${r.reduced ? ' (se bajó el volumen para no saturar)' : ''}`);
    window.__lastExport = r;
  } catch (e) { msg(''); showWarn('No se pudo exportar: ' + (e.message || e)); }
  finally { exporting = false; $('#exportBtn').disabled = false; }
};

// ---- en vivo: qué se muestra según haya acordes y/o letra ---------------------------------------
function updateLive() {
  $('#chordNow').classList.toggle('hidden', !hasChords);
  $('#lyLive').classList.toggle('hidden', !hasLyrics);
  $('#liveHint').classList.toggle('hidden', hasChords || hasLyrics);
}

// ---- ondas ------------------------------------------------------------------------------------
const BUCKETS = 1400;
function peaksOf(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const out = new Float32Array(BUCKETS), step = L.length / BUCKETS;
  for (let b = 0; b < BUCKETS; b++) {
    let m = 0; const a = Math.floor(b * step), z = Math.floor((b + 1) * step);
    for (let i = a; i < z; i += 6) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}
function computeWaves(names) {
  const mix = new Float32Array(BUCKETS);
  for (const n of names) { const p = peaksOf(engine.stems[n].buffer); wave.stems[n] = p; for (let i = 0; i < BUCKETS; i++) mix[i] += p[i]; }
  wave.mix = mix;
}
function drawBars(cv, peaks, style) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.fillStyle = typeof style === 'function' ? style(g, w) : style;
  const bw = 3, gap = 2, n = Math.max(1, Math.floor(w / (bw + gap)));
  let top = 1e-6; for (const v of peaks) if (v > top) top = v;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * peaks.length / n), z = Math.max(a + 1, Math.floor((i + 1) * peaks.length / n));
    let m = 0; for (let k = a; k < z; k++) if (peaks[k] > m) m = peaks[k];
    const hh = Math.max(2, Math.pow(m / top, 0.75) * h * 0.94);
    g.fillRect(i * (bw + gap), (h - hh) / 2, bw, hh);
  }
}
function drawWaves() {
  document.querySelectorAll('.lane').forEach(l => {
    const p = wave.stems[l.dataset.n], c = getComputedStyle(l).getPropertyValue('--c').trim();
    if (!p) return;
    l.querySelectorAll('canvas').forEach(cv => drawBars(cv, p, c));
  });
  if (wave.mix) {
    drawBars($('#waveBase'), wave.mix, '#4a4863');
    drawBars($('#waveFill'), wave.mix, (g, w) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#8b6cff'); gr.addColorStop(1, '#c25bff'); return gr; });
  }
}
let rz = 0;
function watchResize() {
  const redraw = () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(drawWaves); };
  const ro = new ResizeObserver(redraw);
  ro.observe($('#stems')); ro.observe(document.querySelector('.seekwrap'));
  $('#p-stems').addEventListener('toggle', redraw);
}
let lastFrac = -1;
function paintProgress() {
  const d = engine.duration; if (!d) return;
  const f = Math.min(1, Math.max(0, engine.position / d));
  if (Math.abs(f - lastFrac) < 0.0002) return;
  lastFrac = f;
  const clip = `inset(0 ${(1 - f) * 100}% 0 0)`, left = (f * 100) + '%';
  $('#waveFill').style.clipPath = clip; $('#playhead').style.left = left;
  document.querySelectorAll('.lane').forEach(l => { l.querySelector('.fill').style.clipPath = clip; l.querySelector('.playhead').style.left = left; });
}
// clic o arrastre sobre la onda de un instrumento = ir a ese momento
let dragLane = false;
const seekFromLane = e => {
  const lw = e.target.closest?.('.lw') || document.querySelector('.lw'), r = lw.getBoundingClientRect();
  engine.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * engine.duration);
};
$('#stems').addEventListener('pointerdown', e => { if (e.target.closest('.lw')) { dragLane = true; e.target.closest('.lw').setPointerCapture?.(e.pointerId); seekFromLane(e); } });
$('#stems').addEventListener('pointermove', e => { if (dragLane && e.target.closest('.lw')) seekFromLane(e); });
window.addEventListener('pointerup', () => { dragLane = false; });
