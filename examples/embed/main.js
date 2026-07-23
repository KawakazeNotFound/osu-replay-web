// Instead of importing the library and driving your own render/playback pipeline,
// you can frame replayviewer.com in an iframe at `?embed=1` and feed it a replay over postMessage
// See README.md for the message protocol.

const VIEWER_ORIGIN = 'https://www.replayviewer.com';

const iframe = document.getElementById('viewer');
const status = document.getElementById('status');
const button = document.getElementById('load');

let ready = false;

window.addEventListener('message', (e) => {
  if (e.origin !== VIEWER_ORIGIN) return;
  const msg = e.data;
  if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') return;

  if (msg.type === 'replayviewer:ready') {
    ready = true;
    status.textContent = 'viewer ready — press Load replay';
    button.disabled = false;
  } else if (msg.type === 'replayviewer:loaded') {
    status.textContent = 'loaded — use the viewer\'s own controls to play';
    button.disabled = false;
  } else if (msg.type === 'replayviewer:error') {
    status.textContent = 'error: ' + msg.message;
    button.disabled = false;
  }
});

button.addEventListener('click', async () => {
  if (!ready) return;
  button.disabled = true;
  try {
    status.textContent = 'loading assets…';
    const [osr, osz] = await Promise.all([
      fetch('./assets/replay.osr').then(r => {
        if (!r.ok) throw new Error('assets/replay.osr missing — see README.md');
        return r.arrayBuffer();
      }),
      fetch('./assets/map.osz').then(r => {
        if (!r.ok) throw new Error('assets/map.osz missing — see README.md');
        return r.arrayBuffer();
      }),
    ]);

    status.textContent = 'sending replay to the viewer…';
    // Transfer the buffers (no-copy)
    iframe.contentWindow.postMessage({ type: 'replayviewer:load', osr, osz }, VIEWER_ORIGIN, [osr, osz]);
  } catch (err) {
    console.error(err);
    status.textContent = String(err);
    button.disabled = false;
  }
});
