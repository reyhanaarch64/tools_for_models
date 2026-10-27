const { URL } = require('node:url');
const { getClient, createAuthorizationCode, issueToken, consumeAuthorizationCode, consumeRefreshToken, validateRedirectUri } = require('./user-store');
const { verifyFirebaseIdToken } = require('./firebase');
const { pkceChallenge } = require('./crypto');
const { assertAllowedTarget } = require('./utils');

function getBaseUrl(req) {
  const proto = (req.headers && (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'])) || 'https';
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost:3000';
  return `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}`;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function fetchClientMetadata(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('client metadata document could not be fetched');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 64 * 1024) throw new Error('client metadata document is too large');
    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('client metadata document is too large');
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 64 * 1024) {
        await reader.cancel();
        throw new Error('client metadata document is too large');
      }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('client metadata request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveClient(clientId, redirectUri) {
  if (!clientId || !redirectUri) throw new Error('client_id and redirect_uri are required');
  validateRedirectUri(redirectUri);
  if (/^https:\/\//i.test(clientId)) {
    await assertAllowedTarget(clientId);
    const metadata = await fetchClientMetadata(clientId);
    if (metadata.client_id !== clientId) throw new Error('client metadata client_id mismatch');
    if (!Array.isArray(metadata.redirect_uris)) throw new Error('client metadata redirect_uris must be an array');
    const safeRedirectUris = metadata.redirect_uris.map(validateRedirectUri);
    if (!safeRedirectUris.includes(redirectUri)) throw new Error('redirect_uri is not registered for this client');
    return { clientId, clientName: String(metadata.client_name || 'MCP Client').slice(0, 200), redirectUris: safeRedirectUris, source: 'cimd' };
  }
  const client = await getClient(clientId);
  if (!client) throw new Error('unknown client_id');
  if (!Array.isArray(client.redirectUris)) throw new Error('client redirect_uris are invalid');
  const safeRedirectUris = client.redirectUris.map(validateRedirectUri);
  if (!safeRedirectUris.includes(redirectUri)) throw new Error('redirect_uri is not registered for this client');
  return { ...client, source: 'dcr' };
}

function oauthError(res, status, error, description, redirectUri, state, base) {
  if (redirectUri) {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    u.searchParams.set('iss', base);
    res.statusCode = 302;
    res.setHeader('Location', u.toString());
    return res.end();
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error, error_description: description }));
}

async function startAuthorization(req, res) {
  const base = getBaseUrl(req);
  const q = req.query || Object.fromEntries(new URL(req.url, base).searchParams.entries());
  const responseType = q.response_type;
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  const state = q.state;
  const scope = q.scope || 'mcp';
  const challenge = q.code_challenge;
  const challengeMethod = q.code_challenge_method || 'S256';

  try {
    if (responseType !== 'code') throw new Error('only response_type=code is supported');
    if (!challenge || challengeMethod !== 'S256') throw new Error('PKCE S256 is required');
    const client = await resolveClient(clientId, redirectUri);

    const authParams = new URLSearchParams({
      client_id: clientId,
      client_name: client.clientName || 'MCP client',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state: state || '',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    res.statusCode = 302;
    res.setHeader('Location', `/?oauth=1&${authParams.toString()}`);
    res.end();
  } catch (error) {
    oauthError(res, 400, 'invalid_request', error.message, null, state, base);
  }
}

async function completeAuthorization(params, firebaseIdToken, res, req) {
  const base = getBaseUrl(req);
  const user = await verifyFirebaseIdToken(firebaseIdToken);
  const client = await resolveClient(params.client_id, params.redirect_uri);
  const code = await createAuthorizationCode({
    uid: user.uid,
    email: user.email || null,
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: 'S256',
    scope: params.scope || 'mcp',
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);
  redirect.searchParams.set('iss', base);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ authorized: true, redirect: redirect.toString() }));
}

async function tokenExchange(req, res) {
  const body = req.body || await readForm(req);
  const grantType = body.grant_type;
  try {
    if (grantType === 'authorization_code') {
      const record = await consumeAuthorizationCode(body.code);
      if (!record) throw new Error('invalid or already-used authorization code');
      if (record.expiresAt <= Date.now()) throw new Error('authorization code expired');
      if (String(body.client_id) !== String(record.clientId)) throw new Error('client_id mismatch');
      if (String(body.redirect_uri) !== String(record.redirectUri)) throw new Error('redirect_uri mismatch');
      if (!body.code_verifier || pkceChallenge(body.code_verifier) !== record.codeChallenge) throw new Error('PKCE verification failed');
      const tokens = await issueToken(record.uid, record.clientId, record.scope, record.email);
      return writeTokenResponse(res, tokens, record.scope);
    }

    if (grantType === 'refresh_token') {
      const record = await consumeRefreshToken(body.refresh_token);
      if (!record) throw new Error('invalid or expired refresh token');
      if (String(body.client_id) !== String(record.clientId)) throw new Error('client_id mismatch');
      const tokens = await issueToken(record.uid, record.clientId, record.scope, record.email);
      return writeTokenResponse(res, tokens, record.scope);
    }

    throw new Error('unsupported grant_type');
  } catch (error) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: error.message }));
  }
}

function writeTokenResponse(res, tokens, scope) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.statusCode = 200;
  res.end(JSON.stringify({
    token_type: 'Bearer',
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: tokens.expiresIn,
    scope: scope || 'mcp',
  }));
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return Object.fromEntries(params.entries());
}

async function authorizeComplete(req, res) {
  if (req.method !== 'POST') return oauthError(res, 405, 'method_not_allowed', 'POST required');
  try {
    const body = req.body || await readJson(req);
    if (!body.firebaseIdToken) throw new Error('missing firebaseIdToken');
    return await completeAuthorization(body, body.firebaseIdToken, res, req);
  } catch (error) {
    return oauthError(res, 400, 'access_denied', error.message);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

module.exports = { getBaseUrl, startAuthorization, authorizeComplete, tokenExchange, htmlEscape };
