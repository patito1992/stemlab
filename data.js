// El reproductor pide sus datos acá. En la PC vienen del servidor; en la app del celu (data-mode="pwa") del almacenamiento del teléfono.
const pwa = document.documentElement.dataset.mode === 'pwa';
const impl = await import(pwa ? './data-pwa.js' : './data-server.js');
export const { song, stemNames, stemAudio, analysis, lyrics, setLyricsOffset, readOnly } = impl;
