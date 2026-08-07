import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createOAuthSession, parseAuthCodeInput } from '../src/oauth.js';

// ── parseAuthCodeInput ────────────────────────────────────────

test('parseAuthCodeInput accepts a raw authorization code', () => {
  assert.equal(parseAuthCodeInput('abc123', 'st'), 'abc123');
});

test('parseAuthCodeInput extracts the code from a pasted callback URL', () => {
  assert.equal(parseAuthCodeInput('http://localhost:1/callback?code=xyz&state=st', 'st'), 'xyz');
});

test('parseAuthCodeInput rejects a pasted URL whose state does not match', () => {
  assert.throws(
    () => parseAuthCodeInput('http://localhost:1/callback?code=xyz&state=WRONG', 'st'),
    /state mismatch/i,
  );
});

test('parseAuthCodeInput returns null for empty input', () => {
  assert.equal(parseAuthCodeInput('   ', 'st'), null);
  assert.equal(parseAuthCodeInput('', 'st'), null);
});

// ── createOAuthSession ────────────────────────────────────────

test('createOAuthSession builds a PKCE authorize URL with a live callback listener', async () => {
  const session = await createOAuthSession();
  try {
    const u = new URL(session.authUrl);
    assert.equal(u.origin, 'https://claude.ai');
    assert.equal(u.pathname, '/oauth/authorize');
    assert.equal(u.searchParams.get('code'), 'true');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('code_challenge'));
    assert.equal(u.searchParams.get('state'), session.state);
    const redirect = new URL(u.searchParams.get('redirect_uri'));
    assert.match(redirect.href, /^http:\/\/localhost:\d+\/callback$/);

    // Hitting the callback resolves codePromise with the authorization code.
    const res = await fetch(
      `http://127.0.0.1:${redirect.port}/callback?code=CODE9&state=${session.state}`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    assert.equal(await session.codePromise, 'CODE9');
  } finally {
    session.close();
  }
});

test('createOAuthSession rejects the callback on state mismatch', async () => {
  const session = await createOAuthSession();
  try {
    const redirect = new URL(new URL(session.authUrl).searchParams.get('redirect_uri'));
    // Attach the rejection handler before triggering the callback — real
    // callers (CLI race, reauth manager) subscribe at session creation.
    const rejected = assert.rejects(session.codePromise, /state mismatch/i);
    await fetch(`http://127.0.0.1:${redirect.port}/callback?code=X&state=nope`);
    await rejected;
  } finally {
    session.close();
  }
});

test('exchange() posts code + verifier + redirect_uri and returns normalized credentials', async () => {
  let body = null;
  const mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      body = JSON.parse(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
    });
  });
  const port = await new Promise(r => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));

  const session = await createOAuthSession({ tokenEndpoint: `http://127.0.0.1:${port}/token` });
  try {
    const creds = await session.exchange('THECODE');
    assert.equal(creds.accessToken, 'at');
    assert.equal(creds.refreshToken, 'rt');
    assert.ok(creds.expiresAt > Date.now());
    assert.equal(body.code, 'THECODE');
    assert.equal(body.grant_type, 'authorization_code');
    assert.ok(body.code_verifier);
    assert.match(body.redirect_uri, /^http:\/\/localhost:\d+\/callback$/);
  } finally {
    session.close();
    mock.close();
  }
});

test('exchange() surfaces a non-2xx token response as an error', async () => {
  const mock = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });
  const port = await new Promise(r => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));

  const session = await createOAuthSession({ tokenEndpoint: `http://127.0.0.1:${port}/token` });
  try {
    await assert.rejects(session.exchange('BAD'), /Token exchange failed \(400\)/);
  } finally {
    session.close();
    mock.close();
  }
});
