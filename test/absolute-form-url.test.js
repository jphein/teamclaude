import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A plain-HTTP proxy client sends an absolute-form request line
// (`POST http://host:port/v1/messages HTTP/1.1`). Non-upstream targets are
// passthrough-forwarded, but when the target IS the upstream the request must
// be rewritten to origin-form before the `${upstream}${req.url}` concatenation —
// otherwise the two URLs fuse into a mangled host (api.anthropic.comhttps),
// DNS fails, and the account is wrongly marked errored.
test('absolute-form request for the upstream host is forwarded origin-form', async () => {
  let seenPath = null;
  const upstream = http.createServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'POST',
        path: `http://127.0.0.1:${upstreamPort}/v1/messages?beta=true`, // absolute-form, upstream host
        headers: { 'content-type': 'application/json' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'x', messages: [] }));
    });

    assert.equal(status, 200);
    assert.equal(seenPath, '/v1/messages?beta=true');   // origin-form reached upstream
    assert.equal(am.accounts[0].status, 'active');      // account not wrongly errored
  } finally {
    proxy.close();
    upstream.close();
  }
});
