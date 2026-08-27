import fs from 'node:fs/promises';
import path from 'node:path';

const SOUNDS = [
  'button-hover.wav',
  'button-select.wav',
  'button-sidebar-hover.wav',
  'button-sidebar-select.wav',
  'default-hover.wav',
  'default-select.wav',
  'default-select-disabled.wav',
  'check-on.wav',
  'check-off.wav',
  'dialog-pop-in.wav',
  'dialog-pop-out.wav',
  'dialog-ok-select.wav',
  'dialog-cancel-select.wav',
  'dialog-dangerous-select.wav',
  'dialog-dangerous-tick.wav',
  'dropdown-open.wav',
  'dropdown-close.wav',
  'menu-open.wav',
  'menu-close.wav',
  'menu-sub-open.wav',
  'generic-error.wav',
  'notification-default.wav',
  'notification-error.wav',
  'notification-done.wav',
  'notch-tick.wav',
  'osd-change.wav',
  'osd-on.wav',
  'osd-off.wav',
  'overlay-big-pop-in.wav',
  'overlay-big-pop-out.wav',
  'cursor-tap.wav',
  'item-swap.wav',
];

const TARGET_DIR = path.join('assets', 'ui-sounds');
await fs.mkdir(TARGET_DIR, { recursive: true });

const BASE_URL = 'https://raw.githubusercontent.com/ppy/osu-resources/master/osu.Game.Resources/Samples/UI';

console.log(`Downloading ${SOUNDS.length} UI sound effects...`);
for (const sound of SOUNDS) {
  const url = `${BASE_URL}/${sound}`;
  const outPath = path.join(TARGET_DIR, sound);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to fetch ${sound}: ${res.status} ${res.statusText}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(outPath, buf);
    console.log(`✓ ${sound} (${buf.length} bytes)`);
  } catch (err) {
    console.error(`Error downloading ${sound}:`, err);
  }
}
console.log('Finished downloading UI sounds!');
