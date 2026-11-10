import { chromium, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const routes = new Map();
for (const file of ['index.html', 'main.js', 'worker.js', 'music-sync-core.js'])
  routes.set(`/sdk/${file}`, resolve('artifacts', `v${version}`, 'browser', file));
for (const file of ['index.html', 'consumer.js']) routes.set(`/installed/${file}`, resolve('artifacts/consumer-browser', file));
const server = createServer((request, response) => {
  const file = routes.get(new URL(request.url, 'http://localhost').pathname);
  if (!file) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
    console.log(`${name}: launching SDK checks`);
    const browser = await engine.launch();
    console.log(`${name}: browser launched`);
    try {
      const page = await browser.newPage(); const errors = [], external = [];
      console.log(`${name}: page created`);
      page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      page.on('pageerror', error => { errors.push(error.message); console.error(`${name}: ${error.message}`); });
      page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
      await page.goto(`${origin}/sdk/index.html`); await page.click('#run');
      await page.waitForFunction(() => document.querySelector('#result').textContent.includes('"status"'));
      const result = JSON.parse(await page.textContent('#result'));
      assert.equal(result.status, 'accepted'); assert.ok(Math.abs(result.after + 14) <= 0.5);
      assert.equal(result.bytes, 96056);
      await page.goto(`${origin}/installed/index.html`);
      await page.waitForFunction(() => !!document.body.dataset.result);
      const installed = JSON.parse(await page.getAttribute('body', 'data-result'));
      assert.ok(Math.abs(installed.gain - 3) < 0.001); assert.equal(installed.bytes, 96056);
      assert.equal(installed.autoStatus, 'accepted');
      assert.equal(installed.perceptualVersion, 1);
      assert.equal(installed.objectiveAccepted, true);
      assert.equal(installed.colourStatus, 'accepted');
      assert.equal(installed.colourClipped, 0);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      console.log(`${name}: direct ESM, module Worker and installed-package bundle passed.`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
