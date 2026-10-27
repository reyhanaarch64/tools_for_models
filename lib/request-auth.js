const credentials = require('../credential');
const { verifyFirebaseIdToken } = require('./firebase');
const { consumeAccessToken, ensureProfile, getCredentials, getUserEmail } = require('./user-store');

function bearer(req) {
  const value = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(value));
  return match ? match[1].trim() : null;
}

async function authenticateMcp(req) {
  const token = bearer(req);
  const staticToken = credentials.server && credentials.server.accessToken;
  if (token && staticToken && token === staticToken) return { mode: 'static', uid: null, credentials: {} };
  if (!token) return null;
  const record = await consumeAccessToken(token);
  if (!record) return null;
  const [userCreds, profileEmail] = await Promise.all([
    getCredentials(record.uid),
    record.email ? Promise.resolve(null) : getUserEmail(record.uid).catch(() => null),
  ]);
  return {
    mode: 'oauth',
    uid: record.uid,
    email: String(record.email || profileEmail || '').trim().toLowerCase() || null,
    credentials: userCreds,
    scope: record.scope || 'mcp',
  };
}

async function authenticateFirebaseRequest(req) {
  const token = bearer(req);
  if (!token) throw new Error('missing Firebase ID token');
  const decoded = await verifyFirebaseIdToken(token);
  await ensureProfile({ uid: decoded.uid, email: decoded.email, name: decoded.name, picture: decoded.picture });
  return decoded;
}

module.exports = { bearer, authenticateMcp, authenticateFirebaseRequest };
