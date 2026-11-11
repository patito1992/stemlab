// Panel de letra: busca/transcribe/pega la letra y la sigue en pantalla mientras suena.
import * as data_ from './data.js';
const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const f1 = n => n.toFixed(1).replace('.', ',');

export function setupLyrics(engine, songId, title, onChange = () => {}) {
  let data = null, idx = -2, poll = null;
  const msg = t => $('#lyMsg').textContent = t || '';
  const busy = on => ['#lySearch', '#lyWhisper', '#lyPaste', '#lySave', '#lyAlign'].forEach(s => $(s).disabled = on);
  $('#lyQuery').value = title;

  function render() {
    idx = -2;
    const L = data?.lines || [];
    $('#lyList').classList.toggle('synced', !!data?.synced);
    $('#lyList').innerHTML = L.map((l, i) => `<div data-i="${i}"${l.ai ? ' class="ai" title="Parte que no está en la letra original: la escribió la IA, puede tener errores"' : ''}>${esc(l.text) || '♪'}</div>`).join('');
    $('#lyTools').classList.toggle('hidden', !data);
    $('#lyAlign').classList.toggle('hidden', !data); $('#lyAlign').classList.toggle('primary', !!data?.needs_align);
    $('#lyOff').textContent = data ? f1(data.offset || 0) + ' s' : '';
    if (data?.needs_align) msg('Esta letra parece ser de otra versión del tema (de estudio, de otro grupo o en vivo): los tiempos y hasta las partes pueden ser distintos. Tocá "Adaptar a esta versión" y la app escucha el audio y arma la letra tal como se canta acá, usando la original como guía.');
    else if (data) msg(data.synced ? `Fuente: ${data.match || data.source}${data.source === 'whisper' ? '. Puede tener errores, revisala.' : ''}${data.source === 'adapted' && data.lines.some(l => l.ai) ? '. Las líneas en cursiva no están en la letra original: las escribió la IA y pueden tener errores.' : ''}`
      : 'Letra sin tiempos: se muestra acá pero no sigue la música. Pegala con tiempos [mm:ss.xx] para sincronizarla.');
    else msg('Todavía no hay letra para este tema. Buscala, transcribila o pegala.');
    showLive('', '', '');
    onChange(data);
  }
  async function load() {
    try { data = await data_.lyrics(songId); } catch { data = null; }
    render();
  }

  const showLive = (a, b, c) => { $('#lyNow').textContent = a; $('#lyN1').textContent = b; $('#lyN2').textContent = c; };
  const txt = L => L ? (L.text || '♪') : '';
  // seguimiento durante la reproducción (lo llama player.js en cada cuadro)
  function update() {
    if (!data?.synced) return;
    const L = data.lines, t = engine.audiblePosition - (data.offset || 0) + 0.05;
    let lo = 0, hi = L.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].t <= t) lo = m + 1; else hi = m; }
    const i = lo - 1;
    if (i === idx) return;
    idx = i;
    showLive(i >= 0 ? txt(L[i]) : '', txt(L[i + 1]), txt(L[i + 2]));
    const list = $('#lyList'); list.querySelector('.now')?.classList.remove('now');
    list.querySelectorAll('.past').forEach(e => e.classList.remove('past'));
    for (let k = 0; k < i; k++) list.children[k]?.classList.add('past');
    const el = list.children[i];
    if (el) { el.classList.add('now'); if (list.offsetParent) list.scrollTop = el.offsetTop - list.offsetTop - 60; }
  }

  $('#lyList').addEventListener('click', e => {
    const el = e.target.closest('[data-i]'); if (!el || !data?.synced) return;
    engine.seek(Math.max(0, data.lines[+el.dataset.i].t + (data.offset || 0)));
  });
  $('#lySearch').onclick = async () => {
    busy(true); msg('Buscando en LRCLIB…');
    try {
      const r = await fetch(`/api/songs/${songId}/lyrics/search`, { method: 'POST', body: new URLSearchParams({ query: $('#lyQuery').value }) });
      if (!r.ok) throw new Error((await r.json()).detail || 'Error');
      data = await r.json(); render();
    } catch (e) { msg(e.message || String(e)); }
    busy(false);
  };
  function watchJob() {
    clearInterval(poll);
    poll = setInterval(async () => {
      const s = await (await fetch(`/api/songs/${songId}/lyrics/status`)).json();
      if (s.state === 'running') { msg(`${Math.round(s.frac * 100)}% · ${s.msg}`); busy(true); return; }
      clearInterval(poll); busy(false);
      if (s.state === 'done') { await load(); } else if (s.state === 'error') msg('Error: ' + s.msg);
    }, 1500);
  }
  $('#lyWhisper').onclick = async () => {
    if (data && !confirm('Ya hay una letra. ¿Reemplazarla por la transcripción con IA?')) return;
    msg('Empezando… (en tu PC puede tardar varios minutos; la primera vez descarga el modelo)'); busy(true);
    await fetch(`/api/songs/${songId}/lyrics/transcribe`, { method: 'POST' }); watchJob();
  };
  $('#lyAlign').onclick = async () => {
    if (!confirm('La app va a escuchar la voz y armar la letra como se canta en esta versión, usando la actual como guía (reemplaza la letra y sus tiempos). En tu PC puede tardar varios minutos; la primera vez descarga el modelo de IA. ¿Seguir?')) return;
    msg('Empezando…'); busy(true);
    const r = await fetch(`/api/songs/${songId}/lyrics/align`, { method: 'POST' });
    if (!r.ok) { msg((await r.json()).detail || 'Error'); busy(false); return; }
    watchJob();
  };
  $('#lyPaste').onclick = () => $('#lyPasteBox').classList.toggle('hidden');
  $('#lySave').onclick = async () => {
    const text = $('#lyText').value.trim(); if (!text) return;
    const r = await fetch(`/api/songs/${songId}/lyrics/text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) { msg((await r.json()).detail || 'Error'); return; }
    data = await r.json(); $('#lyPasteBox').classList.add('hidden'); render();
  };
  async function setOffset(v) {
    if (!data) return; v = Math.round(v * 10) / 10;
    const d = await data_.setLyricsOffset(songId, v);
    if (d) { data = d; $('#lyOff').textContent = f1(data.offset) + ' s'; idx = -2; }
  }
  $('#lyMinus').onclick = () => setOffset((data?.offset || 0) - 0.1);
  $('#lyPlus').onclick = () => setOffset((data?.offset || 0) + 0.1);
  $('#lyDel').onclick = async () => {
    if (!confirm('¿Borrar la letra de este tema?')) return;
    await fetch(`/api/songs/${songId}/lyrics`, { method: 'DELETE' }); data = null; render(); msg('');
  };
  // si había una transcripción en curso (se recargó la página), seguirla
  if (!data_.readOnly) fetch(`/api/songs/${songId}/lyrics/status`).then(r => r.json()).then(s => { if (s.state === 'running') watchJob(); });
  load();
  return { update };
}
