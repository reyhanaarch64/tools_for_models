const { authenticateFirebaseRequest } = require('../../lib/request-auth');
const { getCredentialStatus, saveCredential, removeCredential } = require('../../lib/user-store');

module.exports = async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const user = await authenticateFirebaseRequest(req);
    if (req.method === 'GET') {
      return res.end(JSON.stringify(await getCredentialStatus(user.uid)));
    }
    if (req.method === 'POST') {
      const body = req.body || await readJson(req);
      const result = await saveCredential(user.uid, String(body.service || ''), body.value);
      return res.end(JSON.stringify(result));
    }
    if (req.method === 'DELETE') {
      const body = req.body || await readJson(req);
      const result = await removeCredential(user.uid, String(body.service || ''));
      return res.end(JSON.stringify(result));
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  } catch (error) {
    res.statusCode = error.message === 'missing Firebase ID token' ? 401 : 400;
    return res.end(JSON.stringify({ error: error.message }));
  }
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
