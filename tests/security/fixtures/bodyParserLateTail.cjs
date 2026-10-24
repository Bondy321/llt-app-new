'use strict';
// A crash regression must run in its own process: an uncaught decoder error
// fails that child rather than installing a handler that masks the vulnerability.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const consumer = createRequire(process.argv[2]);
const parser = consumer('body-parser');
let delayedTail;
const middleware = parser.json({ limit: '2kb' });
const server = http.createServer((req, res) => {
  const hash = crypto.createHash('sha256');
  req.pipe(hash);
  middleware(req, res, error => {
    if (error) { res.writeHead(error.status || 400); res.end('rejected'); return; }
    const respond = () => {
      res.setHeader('X-Raw-Sha256', hash.read().toString('hex'));
      res.end(JSON.stringify(req.body));
    };
    if (hash.writableFinished) respond(); else hash.once('finish', respond);
    if (delayedTail) { const send = delayedTail; delayedTail = null; send(); }
  });
});
const request = (body, encoding, splitTail = null) => new Promise((resolve, reject) => {
  const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length + (splitTail?.length || 0) };
  if (encoding) headers['Content-Encoding'] = encoding;
  const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', headers, agent: false }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, text, hash: res.headers['x-raw-sha256'] }));
  });
  req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('HTTP parser did not finish')));
  if (splitTail) { delayedTail = () => req.end(splitTail); req.write(body); } else req.end(body);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const json = Buffer.from('{"synthetic":true}');
    for (const [body, encoding] of [[json, null], [zlib.gzipSync(json), 'gzip'], [zlib.deflateSync(json), 'deflate']]) {
      const result = await request(body, encoding);
      assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.text), { synthetic: true });
    }
    const prefix = Buffer.concat([zlib.deflateSync(json), Buffer.from([0])]);
    const tail = Buffer.alloc(1024);
    const result = await request(prefix, 'deflate', tail);
    assert.equal(result.status, 200);
    assert.equal(result.hash, crypto.createHash('sha256').update(prefix).update(tail).digest('hex'));
    const gzipTail = Buffer.concat([zlib.gzipSync(json), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    assert.equal((await request(gzipTail, 'gzip')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await request(Buffer.from('{invalid'), null)).status, 400);
    assert.equal((await request(zlib.gzipSync(Buffer.from(JSON.stringify({ data: 'x'.repeat(4096) }))), 'gzip')).status, 413);
    assert.equal((await request(json, null)).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
