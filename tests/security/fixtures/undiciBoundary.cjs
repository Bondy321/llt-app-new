'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const http = require('node:http');
const path = require('node:path');
const consumerPath = process.argv[2];
const mode = process.argv[3];
const consumerRequire = createRequire(consumerPath);
const undici = consumerRequire('undici');
const stage = value => { if (mode === 'consumer') process.stderr.write(`consumer phase: ${value}\n`); };
// Local synthetic traffic must never inherit a developer's external proxy.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[key];
let expectedCallback;
const server = http.createServer((req, res) => {
  stage(`local response ${req.url}`);
  if (req.url === '/bad-encoding') {
    res.writeHead(200, { 'Content-Encoding': 'gzip, gzip, gzip, gzip, gzip, gzip', 'Content-Length': '100' });
    res.flushHeaders();
    // Give fetch time to reject its encoding limit before the orphaned body errors.
    setTimeout(() => res.socket?.destroy(), 25);
  } else if (req.url === '/html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Synthetic compatibility</title><p id="ok">ready</p>');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ synthetic: true }));
  }
});

async function consumerCheck(url) {
  stage('loading consumer');
  if (consumerPath.includes('firebase-tools')) {
    const { Client } = consumerRequire('./lib/apiv2.js');
    stage('loaded Firebase Client');
    const client = new Client({ urlPrefix: url, auth: false });
    // compress:false is the CLI's real package-Undici request path.
    const result = await client.get('/ok', { compress: false, retries: 0, timeout: 2000 });
    assert.deepEqual(result.body, { synthetic: true });
    stage('Firebase response consumed');
  } else if (consumerPath.includes('node-gyp')) {
    const { download } = consumerRequire('./lib/download.js');
    const result = await download({ version: 'synthetic', opts: {} }, `${url}/ok`);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(await result.text()), { synthetic: true });
  } else {
    const { JSDOM } = require(path.dirname(consumerPath));
    stage('loaded jsdom');
    const dispatcher = new undici.Agent();
    try {
      const dom = await JSDOM.fromURL(`${url}/html`, { resources: { dispatcher } });
      stage('jsdom response parsed');
      try { assert.equal(dom.window.document.querySelector('#ok').textContent, 'ready'); }
      finally { dom.window.close(); }
    } finally { await dispatcher.close(); }
    stage('jsdom window and owned dispatcher closed');
  }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    if (mode === 'encoding-crash') {
      await assert.rejects(undici.fetch(`${url}/bad-encoding`, { signal: AbortSignal.timeout(2000) }));
      await new Promise(resolve => setTimeout(resolve, 150));
      const healthy = await undici.fetch(`${url}/ok`, { signal: AbortSignal.timeout(2000) });
      assert.deepEqual(await healthy.json(), { synthetic: true });
    } else if (mode === 'tls-callback') {
      const checkServerIdentity = () => new Error('synthetic pin rejection');
      const agent = new undici.Agent({ tls: { checkServerIdentity }, factory(origin, options) {
        expectedCallback = options.tls?.checkServerIdentity;
        return new undici.Pool(origin, options);
      } });
      try {
        const result = await undici.request(`${url}/ok`, { dispatcher: agent });
        assert.deepEqual(await result.body.json(), { synthetic: true });
        assert.equal(expectedCallback, checkServerIdentity,
          'Agent must preserve the exact TLS verifier at the per-origin pool boundary');
      } finally { await agent.close(); }
    } else { await consumerCheck(url); }
  } finally {
    stage('closing server');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    stage('closing global dispatcher');
    await undici.getGlobalDispatcher().close();
    stage('resources closed');
  }
})().then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
