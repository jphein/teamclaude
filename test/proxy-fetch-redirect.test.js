import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { proxyFetch } from '../src/upstream-fetch.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// Control-plane calls carry refresh tokens, codes and bearer tokens, and fetch
// resends a POST body to a 307/308's Location: proxyFetch never follows one.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('a 307 from a token endpoint is returned as-is; the body never reaches the Location', async () => {
  const elsewhere = [];
  const thief = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { elsewhere.push(b); res.end('{}'); }); });
  const thiefPort = await listen(thief);
  const token = http.createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${thiefPort}/steal` }); res.end(); });
  const tokenPort = await listen(token);
  try {
    // Positive control: plain fetch DOES carry the body to the Location.
    await fetch(`http://127.0.0.1:${tokenPort}/v1/oauth/token`, { method: 'POST', body: 'refresh_token=control' });
    assert.deepEqual(elsewhere, ['refresh_token=control']);
    const res = await proxyFetch(`http://127.0.0.1:${tokenPort}/v1/oauth/token`, { method: 'POST', body: 'refresh_token=secret' });
    assert.equal(res.status, 307);
    assert.equal(res.ok, false, 'callers treat it as a failure');
    assert.deepEqual(elsewhere, ['refresh_token=control'], 'the secret never left');
    assert.equal(res.headers.get('location'), `http://127.0.0.1:${thiefPort}/steal`, 'the real 3xx, not an opaque redirect');
    // 308 the same, and an explicit undefined still gets the safe default.
    token.removeAllListeners('request');
    token.on('request', (req, r) => { req.resume(); r.writeHead(308, { location: `http://127.0.0.1:${thiefPort}/steal` }); r.end(); });
    assert.equal((await proxyFetch(`http://127.0.0.1:${tokenPort}/t`, { method: 'POST', body: 'code=secret' })).status, 308);
    assert.equal((await proxyFetch(`http://127.0.0.1:${tokenPort}/t`, { method: 'POST', body: 'code=secret', redirect: undefined })).status, 308);
    assert.deepEqual(elsewhere, ['refresh_token=control'], 'nothing left on a 308 either');
    // A caller that really wants to follow can still say so (only for calls that carry no secret).
    const followed = await proxyFetch(`http://127.0.0.1:${tokenPort}/x`, { method: 'POST', body: 'ok', redirect: 'follow' });
    assert.equal(followed.status, 200);
  } finally { token.close(); thief.close(); }
});
