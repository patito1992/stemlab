// Paneles plegables: cada uno recuerda si lo dejaste abierto o cerrado (en este navegador).
const KEY = 'stemlab.panels';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

export function initPanels(foldBtn) {
  const saved = read(), panels = [...document.querySelectorAll('details.panel[id]')];
  for (const p of panels) {
    if (p.id in saved) p.open = !!saved[p.id];
    p.addEventListener('toggle', () => { const s = read(); s[p.id] = p.open; write(s); syncBtn(); });
  }
  const syncBtn = () => { if (foldBtn) foldBtn.textContent = panels.some(p => p.open && !p.classList.contains('hidden')) ? 'Plegar todo' : 'Abrir todo'; };
  if (foldBtn) foldBtn.onclick = () => {
    const open = !panels.some(p => p.open && !p.classList.contains('hidden'));
    panels.forEach(p => { p.open = open; });
  };
  syncBtn();
}
