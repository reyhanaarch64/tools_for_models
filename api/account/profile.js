const { authenticateFirebaseRequest } = require('../../lib/request-auth');
const { getAdmin } = require('../../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const user = await authenticateFirebaseRequest(req);
    const { db } = getAdmin();
    const ref = db.ref(`users/${user.uid}/profile`);
    if (req.method === 'GET') {
      const snap = await ref.once('value');
      return res.end(JSON.stringify(snap.exists() ? snap.val() : {}));
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      const body = req.body || await readJson(req);
      const update = {};
      if (body.displayName !== undefined) update.displayName = String(body.displayName).slice(0, 120);
      if (body.photoURL !== undefined) update.photoURL = String(body.photoURL).slice(0, 1000);
      update.updatedAt = Date.now();
      await ref.update(update);
      return res.end(JSON.stringify({ saved: true }));
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  } catch (error) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: error.message }));
  }
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
