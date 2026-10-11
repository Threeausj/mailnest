// Regenerate committed PNGs from the editable SVGs using the existing Playwright
// Chromium installation: node scripts/generate-icons.mjs
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const publicPath = fileURLToPath(new URL('../web/public/', import.meta.url));
const icon = await readFile(`${publicPath}icon-blue-v2.svg`, 'utf8');
const badge = await readFile(`${publicPath}notification-badge-v2.svg`, 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, svg] of [
    ['icon-blue-192-v2.png', 192, icon],
    ['icon-blue-512-v2.png', 512, icon],
    ['icon-blue-maskable-512-v2.png', 512, icon.replaceAll('rx="44"', 'rx="0"')],
    ['notification-badge-v2.png', 96, badge],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await page.locator('img').evaluate(image => image.decode());
    await page.screenshot({ path: `${publicPath}${name}`, omitBackground: true });
  }
} finally { await browser.close(); }

// Older bookmarks or previously installed application shells may use these URLs.
await writeFile(`${publicPath}icon.svg`, icon);
await copyFile(`${publicPath}icon-blue-192-v2.png`, `${publicPath}icon-192.png`);
await copyFile(`${publicPath}icon-blue-512-v2.png`, `${publicPath}icon-512.png`);
