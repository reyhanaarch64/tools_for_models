const { getAdmin } = require('./firebase');
const { encryptFor, decryptFor } = require('./crypto');

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;
const MAX_CONTENT = 512 * 1024;
const MAX_NOTE_ID = 80;
const STATUSES = new Set(['draft', 'published']);
const VISIBILITIES = new Set(['public', 'private']);

function normalizeNoteId(value) {
  const noteId = String(value || '').trim();
  if (!noteId) throw new Error('noteId is required');
  if (noteId.length > MAX_NOTE_ID) throw new Error(`noteId must be at most ${MAX_NOTE_ID} characters`);
  if (!/^[A-Za-z0-9_-]+$/.test(noteId)) {
    throw new Error('noteId may only contain letters, numbers, hyphen (-), and underscore (_) with no spaces');
  }
  return noteId;
}

function normalizeTitle(value) {
  const title = String(value == null ? '' : value).trim();
  if (!title) throw new Error('title is required');
  if (title.length > MAX_TITLE) throw new Error(`title must be at most ${MAX_TITLE} characters`);
  return title;
}

function normalizeDescription(value) {
  const description = String(value == null ? '' : value).trim();
  if (description.length > MAX_DESCRIPTION) throw new Error(`description must be at most ${MAX_DESCRIPTION} characters`);
  return description;
}

function normalizeContent(value) {
  const content = String(value == null ? '' : value);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) throw new Error(`content must be at most ${MAX_CONTENT} bytes`);
  return content;
}

function normalizeStatus(value, fallback = 'draft') {
  const status = String(value == null ? fallback : value).toLowerCase();
  if (!STATUSES.has(status)) throw new Error('status must be draft or published');
  return status;
}

function normalizeVisibility(value, fallback = 'private') {
  const visibility = String(value == null ? fallback : value).toLowerCase();
  if (!VISIBILITIES.has(visibility)) throw new Error('visibility must be public or private');
  return visibility;
}

function publicMeta(noteId, note) {
  return {
    noteId,
    title: note.title,
    description: note.description || '',
    status: note.status || 'draft',
    updatedAt: Number(note.updatedAt || 0),
  };
}

function dashboardMeta(noteId, note) {
  return {
    ...publicMeta(noteId, note),
    visibility: note.visibility || 'private',
    encrypted: note.encrypted !== false,
    createdAt: Number(note.createdAt || 0),
  };
}

function buildStoredContent(content, encrypted) {
  return encrypted ? encryptFor('notes', content) : content;
}

function readStoredContent(note) {
  if (note.encrypted === false) return String(note.content == null ? '' : note.content);
  return decryptFor('notes', note.content);
}

async function getNote(uid, noteId, { allowPrivate = false, withContent = false } = {}) {
  const id = normalizeNoteId(noteId);
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/notes/${id}`).once('value');
  if (!snap.exists()) throw new Error('note not found');
  const note = snap.val() || {};
  if (!allowPrivate && note.visibility !== 'public') throw new Error('note is private');
  const result = publicMeta(id, note);
  if (withContent) result.content = readStoredContent(note);
  return result;
}

async function listNotes(uid, { publicOnly = false } = {}) {
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/notes`).once('value');
  const raw = snap.exists() ? (snap.val() || {}) : {};
  return Object.entries(raw)
    .filter(([noteId]) => /^[A-Za-z0-9_-]{1,80}$/.test(noteId))
    .filter(([, note]) => !publicOnly || note?.visibility === 'public')
    .map(([noteId, note]) => publicOnly ? publicMeta(noteId, note || {}) : dashboardMeta(noteId, note || {}))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

async function saveNote(uid, input, existing = null) {
  const noteId = normalizeNoteId(input.noteId);
  const title = input.title === undefined && existing ? existing.title : normalizeTitle(input.title);
  const description = input.description === undefined && existing ? (existing.description || '') : normalizeDescription(input.description);
  const status = input.status === undefined && existing ? normalizeStatus(existing.status) : normalizeStatus(input.status);
  const visibility = input.visibility === undefined && existing ? normalizeVisibility(existing.visibility) : normalizeVisibility(input.visibility);
  const encrypted = input.encrypted === undefined ? (existing ? existing.encrypted !== false : true) : Boolean(input.encrypted);

  let content;
  if (input.content === undefined && existing) content = readStoredContent(existing);
  else content = normalizeContent(input.content);
  content = normalizeContent(content);

  const now = Date.now();
  const createdAt = existing ? Number(existing.createdAt || now) : now;
  const note = {
    title,
    description,
    status,
    visibility,
    encrypted,
    content: buildStoredContent(content, encrypted),
    createdAt,
    updatedAt: now,
  };

  const { db } = getAdmin();
  await db.ref(`users/${uid}/notes/${noteId}`).set(note);
  return { noteId, ...dashboardMeta(noteId, note) };
}

async function createNote(uid, input) {
  const noteId = normalizeNoteId(input?.noteId);
  const { db } = getAdmin();
  const existing = await db.ref(`users/${uid}/notes/${noteId}`).once('value');
  if (existing.exists()) throw new Error('noteId already exists');
  return saveNote(uid, { ...input, noteId }, null);
}

async function updateNote(uid, noteId, changes) {
  const id = normalizeNoteId(noteId);
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/notes/${id}`).once('value');
  if (!snap.exists()) throw new Error('note not found');
  const existing = snap.val() || {};
  return saveNote(uid, { ...changes, noteId: id }, existing);
}

async function appendNote(uid, noteId, append) {
  const id = normalizeNoteId(noteId);
  const text = normalizeContent(append);
  if (!text) throw new Error('append content is required');
  const { db } = getAdmin();
  const snap = await db.ref(`users/${uid}/notes/${id}`).once('value');
  if (!snap.exists()) throw new Error('note not found');
  const existing = snap.val() || {};
  const current = readStoredContent(existing);
  const separator = current && !current.endsWith('\n') ? '\n\n' : '';
  return updateNote(uid, id, { content: `${current}${separator}${text}` });
}

async function deleteNote(uid, noteId) {
  const id = normalizeNoteId(noteId);
  const { db } = getAdmin();
  const ref = db.ref(`users/${uid}/notes/${id}`);
  const snap = await ref.once('value');
  if (!snap.exists()) throw new Error('note not found');
  await ref.remove();
  return { deleted: true, noteId: id };
}

module.exports = {
  MAX_DESCRIPTION,
  MAX_CONTENT,
  listNotes,
  getNote,
  createNote,
  updateNote,
  appendNote,
  deleteNote,
};
