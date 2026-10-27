const { authenticateFirebaseRequest } = require('../../lib/request-auth');
const { listNotes, getNote, createNote, updateNote, deleteNote } = require('../../lib/notes');

module.exports = async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const user = await authenticateFirebaseRequest(req);
    const url = new URL(req.url, 'https://kernote.local');
    const noteId = url.searchParams.get('noteId');

    if (req.method === 'GET') {
      if (noteId) return res.end(JSON.stringify(await getNote(user.uid, noteId, { allowPrivate: true, withContent: true })));
      return res.end(JSON.stringify({ notes: await listNotes(user.uid, { publicOnly: false }) }));
    }

    const body = req.body || await readJson(req);
    if (req.method === 'POST') {
      return res.end(JSON.stringify(await createNote(user.uid, body)));
    }
    if (req.method === 'PUT') {
      if (!noteId) throw new Error('noteId is required');
      return res.end(JSON.stringify(await updateNote(user.uid, noteId, body || {})));
    }
    if (req.method === 'DELETE') {
      if (!noteId) throw new Error('noteId is required');
      return res.end(JSON.stringify(await deleteNote(user.uid, noteId)));
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    res.statusCode = message === 'missing Firebase ID token' ? 401 : 400;
    return res.end(JSON.stringify({ error: message }));
  }
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}
