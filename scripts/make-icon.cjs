// Renders the VideoCut logo to build/icon.png (512 px), used for the window and the .exe.
// Run with: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 32 32">
<rect x="1" y="1" width="30" height="30" rx="9" fill="#e5532f"/>
<path d="M11 8.5 L24 16 L11 23.5 Z" fill="white"/>
<path d="M7 24 L25 7" stroke="#e5532f" stroke-width="3.2" stroke-linecap="round"/>
<path d="M7 24 L25 7" stroke="white" stroke-width="1.2" stroke-linecap="round" opacity=".9"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
