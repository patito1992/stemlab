// Nombres de notas y acordes transpuestos. El análisis guarda cada acorde como raíz (0-11) + calidad,
// así que transponer es sumar semitonos y volver a escribir el nombre con # o b según la tonalidad nueva.
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SUFFIX = { maj: '', min: 'm', 7: '7', m7: 'm7', maj7: 'maj7', N: '' };
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1]);          // F, Bb, Eb, Ab, Db

export const mod12 = n => ((n % 12) + 12) % 12;
// ¿La tonalidad (tónica 0-11, modo) se escribe con bemoles?
export function usesFlats(tonic, mode) {
  return FLAT_MAJORS.has(mode === 'minor' ? mod12(tonic + 3) : mod12(tonic));
}
export const noteName = (pc, flats) => (flats ? FLAT : SHARP)[mod12(pc)];
export function keyName(key, semis = 0) {
  const t = mod12(key.tonic + semis);
  return noteName(t, usesFlats(t, key.mode)) + (key.mode === 'minor' ? 'm' : '');
}
const SIMPLE = { maj: 'maj', min: 'min', 7: 'maj', m7: 'min', maj7: 'maj', N: 'N' };   // sin séptimas: tríadas
export function chordName(ch, semis, flats, simple = false) {
  if (ch.root < 0 || ch.q === 'N') return '–';
  const q = simple ? (SIMPLE[ch.q] ?? ch.q) : ch.q;
  return noteName(ch.root + semis, flats) + (SUFFIX[q] ?? '');
}
// Lista de acordes transpuesta, sin repetir el mismo acorde dos veces seguidas.
export function chordList(analysis, semis, simple = false) {
  const t = mod12(analysis.key.tonic + semis), flats = usesFlats(t, analysis.key.mode), out = [];
  for (const c of analysis.chords) {
    const name = chordName(c, semis, flats, simple);
    if (out.length && out[out.length - 1].name === name) continue;
    out.push({ start: c.start, name });
  }
  return out;
}
