const { getAdmin } = require('./firebase');
const { encrypt, decrypt, hashSecret, randomSecret } = require('./crypto');
const net = require('node:net');
const { URL } = require('node:url');

const CREDENTIAL_NAMES = ['github', 'gmail', 'services'];
const TOOL_CALL_LIMIT = 400;
const UNLIMITED_TOOL_EMAILS = new Set([
  'rehanalok99.0@gmail.com',
  'nurkhalifah0099@gmail.com',
  'ryhnardianshh@gmail.com',
]);

function validateRedirectUri(input) {
  const value = String(input == null ? '' : input).trim();
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('redirect_uri must be a valid URI without control characters');
  }
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('redirect_uri is not a valid absolute URI'); }
  const protocol = parsed.protocol.toLowerCase();
  const denied = new Set(['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'mailto:', 'tel:', 'sms:', 'ftp:', 'about:', 'chrome:', 'chrome-extension:', 'devtools:', 'intent:']);
  if (denied.has(protocol)) throw new Error(`redirect_uri scheme is not allowed: ${protocol}`);
  if (parsed.username || parsed.password) throw new Error('redirect_uri must not include embedded credentials');
  if (protocol === 'http:') {
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    if (!(hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1' || net.isIP(hostname) === 4 && hostname.startsWith('127.'))) {
      throw new Error('HTTP redirect_uri is allowed only for loopback callbacks; use HTTPS for remote callbacks');
    }
  } else if (protocol === 'https:') {
    if (!parsed.hostname) throw new Error('HTTPS redirect_uri requires a hostname');
  }
  return value;
}

function cleanKey(value) {
  return String(value).replace(/[.#$\[\]/]/g, '_').slice(0, 120);
}

async function getUser(uid) {
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function ensureProfile(user) {
  const { db } = getAdmin();
  const ref = db.ref(`users/${user.uid}/profile`);
  const snap = await ref.once('value');
  if (!snap.exists()) {
    await ref.set({
      email: user.email || null,
      displayName: user.name || null,
      photoURL: user.picture || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

async function getEncryptedCredentials(uid) {
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/credentials`).once('value');
  return snap.exists() ? (snap.val() || {}) : {};
}

async function getCredentials(uid) {
  const raw = await getEncryptedCredentials(uid);
  const out = {};
  for (const name of CREDENTIAL_NAMES) {
    if (raw[name]) {
      try { out[name] = decrypt(raw[name]); } catch (_) { /* keep malformed record isolated */ }
    }
  }
  return out;
}

function maskSecret(secret) {
  if (!secret) return null;
  const s = String(secret);
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 2)}••••${s.slice(-4)}`;
}

async function getCredentialStatus(uid) {
  const raw = await getEncryptedCredentials(uid);
  let github = null;
  let gmail = null;
  if (raw.github) {
    let value = null;
    try { value = decrypt(raw.github); } catch (_) {}
    github = { configured: !!value?.token, updatedAt: raw.github.updatedAt || null, hint: maskSecret(value?.token) };
  }
  if (raw.gmail) {
    let value = null;
    try { value = decrypt(raw.gmail); } catch (_) {}
    gmail = { configured: !!value?.user && !!value?.appPassword, updatedAt: raw.gmail.updatedAt || null, email: value?.user || null };
  }
  return { github, gmail, servicesConfigured: Object.keys(raw.services || {}).length > 0 };
}

async function saveCredential(uid, service, value) {
  if (!CREDENTIAL_NAMES.includes(service)) throw new Error('unsupported credential service');
  if (!value || typeof value !== 'object') throw new Error('credential value must be an object');
  if (service === 'github' && (!value.token || String(value.token).length < 8)) throw new Error('GitHub token is invalid');
  if (service === 'gmail' && (!value.user || !value.appPassword)) throw new Error('Gmail email and app password are required');
  const { db } = getAdmin();
  const encrypted = encrypt(value);
  encrypted.updatedAt = Date.now();
  await db.ref(`users/${uid}/credentials/${service}`).set(encrypted);
  return { saved: true, service, updatedAt: encrypted.updatedAt };
}

async function removeCredential(uid, service) {
  if (!CREDENTIAL_NAMES.includes(service)) throw new Error('unsupported credential service');
  const { db } = getAdmin();
  await db.ref(`users/${uid}/credentials/${service}`).remove();
  return { removed: true, service };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isUnlimitedToolAccount(email) {
  return UNLIMITED_TOOL_EMAILS.has(normalizeEmail(email));
}

async function getUserEmail(uid) {
  if (!uid) return null;
  // Use Firebase Auth as the authority. The RTDB profile is user-writable and
  // must never be trusted to grant an unlimited-usage exception.
  try {
    const { auth } = getAdmin();
    const account = await auth.getUser(uid);
    return account && account.email ? String(account.email).trim() : null;
  } catch (_) {
    return null;
  }
}

async function reserveToolUsage(uid, email, toolName) {
  if (!uid) return { allowed: true, unlimited: true, count: 0, limit: null, remaining: null };
  const { db } = getAdmin();
  const safeName = cleanKey(toolName);
  const unlimited = isUnlimitedToolAccount(email);
  const ref = db.ref(`users/${uid}/stats/quotaTools/${safeName}/count`);
  let legacyCount = 0;
  const currentQuota = await ref.once('value');
  if (!currentQuota.exists()) {
    const legacyUsage = await db.ref(`users/${uid}/stats/tools/${safeName}/count`).once('value');
    legacyCount = Math.max(0, Math.floor(Number(legacyUsage.val()) || 0));
  }
  let observedCount = legacyCount;
  let reservationApproved = false;
  const transaction = await ref.transaction(current => {
    const count = current === null || current === undefined
      ? legacyCount
      : Math.max(0, Math.floor(Number(current) || 0));
    observedCount = count;
    if (!unlimited && count >= TOOL_CALL_LIMIT) {
      reservationApproved = false;
      return count;
    }
    reservationApproved = true;
    return count + 1;
  }, undefined, false);

  if (!transaction.committed) {
    const count = Math.max(0, Math.floor(Number(transaction.snapshot && transaction.snapshot.val()) || observedCount));
    return {
      allowed: unlimited || count < TOOL_CALL_LIMIT,
      unlimited,
      count,
      limit: unlimited ? null : TOOL_CALL_LIMIT,
      remaining: unlimited ? null : Math.max(0, TOOL_CALL_LIMIT - count),
    };
  }

  const count = Math.max(0, Math.floor(Number(transaction.snapshot && transaction.snapshot.val()) || 0));
  return {
    allowed: unlimited || reservationApproved,
    unlimited,
    count,
    limit: unlimited ? null : TOOL_CALL_LIMIT,
    remaining: unlimited ? null : Math.max(0, TOOL_CALL_LIMIT - count),
  };
}

function buildToolUsageSummary(stats, email, toolNames, filterName) {
  const snapshot = stats || {};
  const unlimited = isUnlimitedToolAccount(email);
  const quotaTools = snapshot.quotaTools || {};
  const usageTools = snapshot.tools || {};
  const filter = String(filterName || '').trim().toLowerCase();
  const names = (Array.isArray(toolNames) ? toolNames : Object.keys(usageTools))
    .filter(name => !filter || String(name).toLowerCase() === filter)
    .filter((name, index, all) => all.indexOf(name) === index);
  const tools = names.map(name => {
    const key = cleanKey(name);
    const quotaCount = Math.max(0, Math.floor(Number(quotaTools[key] && quotaTools[key].count) || 0));
    const historicalCount = Math.max(0, Math.floor(Number(usageTools[key] && usageTools[key].count) || 0));
    const used = Math.max(quotaCount, historicalCount);
    const usage = usageTools[key] || {};
    return {
      name,
      used,
      limit: unlimited ? null : TOOL_CALL_LIMIT,
      remaining: unlimited ? null : Math.max(0, TOOL_CALL_LIMIT - used),
      unlimited,
      exhausted: !unlimited && used >= TOOL_CALL_LIMIT,
      successfulCalls: Math.max(0, Math.floor(Number(usage.success) || 0)),
      lastUsedAt: Number(usage.lastUsedAt) || null,
      lastDurationMs: Math.max(0, Number(usage.lastDurationMs) || 0),
    };
  });
  return {
    limitPerTool: unlimited ? null : TOOL_CALL_LIMIT,
    unlimited,
    totalCalls: Math.max(0, Math.floor(Number(snapshot.totalCalls) || 0)),
    successfulCalls: Math.max(0, Math.floor(Number(snapshot.successCalls) || 0)),
    errorCalls: Math.max(0, Math.floor(Number(snapshot.errorCalls) || 0)),
    toolCount: tools.length,
    exhaustedTools: tools.filter(tool => tool.exhausted).length,
    tools,
  };
}

async function getToolUsageSummary(uid, email, toolNames, filterName) {
  const stats = await getStats(uid);
  return buildToolUsageSummary(stats, email, toolNames, filterName);
}

async function recordToolUsage(uid, toolName, success, durationMs) {
  if (!uid) return;
  const { db, admin } = getAdmin();
  const now = Date.now();
  const safeName = cleanKey(toolName);
  const day = new Date(now).toISOString().slice(0, 10);
  const update = {};
  update[`users/${uid}/stats/totalCalls`] = admin.database.ServerValue.increment(1);
  update[`users/${uid}/stats/successCalls`] = admin.database.ServerValue.increment(success ? 1 : 0);
  update[`users/${uid}/stats/errorCalls`] = admin.database.ServerValue.increment(success ? 0 : 1);
  update[`users/${uid}/stats/tools/${safeName}/count`] = admin.database.ServerValue.increment(1);
  update[`users/${uid}/stats/tools/${safeName}/success`] = admin.database.ServerValue.increment(success ? 1 : 0);
  update[`users/${uid}/stats/tools/${safeName}/lastUsedAt`] = now;
  update[`users/${uid}/stats/tools/${safeName}/lastDurationMs`] = Math.max(0, Number(durationMs) || 0);
  update[`users/${uid}/stats/days/${day}`] = admin.database.ServerValue.increment(1);
  await db.ref().update(update);
}

async function getStats(uid) {
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/stats`).once('value');
  return snap.exists() ? snap.val() : { totalCalls: 0, successCalls: 0, errorCalls: 0, tools: {}, quotaTools: {}, days: {} };
}

async function registerClient(metadata) {
  if (!metadata || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length < 1) throw new Error('redirect_uris is required');
  const redirectUris = metadata.redirect_uris.map(validateRedirectUri).filter((value, index, all) => all.indexOf(value) === index).slice(0, 20);
  if (!redirectUris.length) throw new Error('at least one valid redirect_uri is required');
  const id = `pikirkan_${randomSecret(18)}`;
  const { db } = getAdmin();
  await db.ref(`oauth/clients/${id}`).set({
    clientId: id,
    clientName: String(metadata.client_name || 'MCP Client').slice(0, 200),
    redirectUris,
    grantTypes: metadata.grant_types || ['authorization_code', 'refresh_token'],
    responseTypes: metadata.response_types || ['code'],
    tokenEndpointAuthMethod: metadata.token_endpoint_auth_method || 'none',
    createdAt: Date.now(),
  });
  return id;
}

async function getClient(clientId) {
  const { db } = getAdmin();
  const snap = await db.ref(`oauth/clients/${cleanKey(clientId)}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function createAuthorizationCode(record) {
  const { db } = getAdmin();
  const code = randomSecret(36);
  const hash = hashSecret(code);
  await db.ref(`oauth/codes/${hash}`).set({ ...record, createdAt: Date.now() });
  return code;
}

async function consumeAuthorizationCode(code) {
  if (!code) return null;
  const { db } = getAdmin();
  const ref = db.ref(`oauth/codes/${hashSecret(code)}`);
  let claimed = null;
  const transaction = await ref.transaction(current => {
    claimed = null;
    if (!current || current.consumedAt || !current.expiresAt || current.expiresAt <= Date.now()) return null;
    claimed = { ...current };
    return { ...current, consumedAt: Date.now() };
  });
  if (!transaction.committed || !claimed) return null;
  await ref.remove();
  return claimed;
}

async function issueToken(uid, clientId, scope, email) {
  const { db } = getAdmin();
  const accessToken = randomSecret(48);
  const refreshToken = randomSecret(48);
  const now = Date.now();
  await db.ref(`oauth/tokens/${hashSecret(accessToken)}`).set({
    uid, email: normalizeEmail(email) || null, clientId, scope: scope || 'mcp', type: 'access', createdAt: now, expiresAt: now + 60 * 60 * 1000,
  });
  await db.ref(`oauth/refreshTokens/${hashSecret(refreshToken)}`).set({
    uid, email: normalizeEmail(email) || null, clientId, scope: scope || 'mcp', createdAt: now, expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  });
  return { accessToken, refreshToken, expiresIn: 3600 };
}

async function consumeAccessToken(token) {
  if (!token) return null;
  const { db } = getAdmin();
  const snap = await db.ref(`oauth/tokens/${hashSecret(token)}`).once('value');
  if (!snap.exists()) return null;
  const value = snap.val();
  if (!value.expiresAt || value.expiresAt <= Date.now()) return null;
  return value;
}

async function consumeRefreshToken(refreshToken) {
  if (!refreshToken) return null;
  const { db } = getAdmin();
  const ref = db.ref(`oauth/refreshTokens/${hashSecret(refreshToken)}`);
  let claimed = null;
  const transaction = await ref.transaction(current => {
    claimed = null;
    if (!current || current.consumedAt || !current.expiresAt || current.expiresAt <= Date.now()) return null;
    claimed = { ...current };
    return { ...current, consumedAt: Date.now() };
  });
  if (!transaction.committed || !claimed) return null;
  await ref.remove();
  return claimed;
}

module.exports = {
  getUser, ensureProfile, getCredentials, getEncryptedCredentials, getCredentialStatus,
  saveCredential, removeCredential, recordToolUsage, getStats, reserveToolUsage,
  getUserEmail, isUnlimitedToolAccount, buildToolUsageSummary, getToolUsageSummary,
  TOOL_CALL_LIMIT,
  registerClient, getClient, createAuthorizationCode, consumeAuthorizationCode, validateRedirectUri,
  issueToken, consumeAccessToken, consumeRefreshToken,
};
