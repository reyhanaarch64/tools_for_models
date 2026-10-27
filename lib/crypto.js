const crypto = require('node:crypto');
const credentials = require('../credential');

function getMasterKey() {
  const raw = credentials.security && credentials.security.credentialEncryptionKey;
  if (!raw) throw new Error('server encryption key is not configured; set security.credentialEncryptionKey in the backend configuration');
  const value = String(raw).trim();
  let key;
  try { key = Buffer.from(value, 'base64'); } catch (_) { key = null; }
  if (!key || key.length !== 32) {
    try { key = Buffer.from(value, 'hex'); } catch (_) { key = null; }
  }
  if (!key || key.length !== 32) throw new Error('credentialEncryptionKey must be exactly 32 bytes in base64 or hex');
  return key;
}

function deriveKey(purpose) {
  const master = getMasterKey();
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(`pikirkan:${String(purpose)}`), 32));
}

function encryptWithKey(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptWithKey(key, record) {
  if (!record || record.alg !== 'AES-256-GCM' || record.v !== 1) throw new Error('unsupported encrypted record format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function encrypt(value) {
  return encryptWithKey(deriveKey('credentials'), value);
}

function decrypt(record) {
  return decryptWithKey(deriveKey('credentials'), record);
}

function encryptFor(purpose, value) {
  return encryptWithKey(deriveKey(purpose), value);
}

function decryptFor(purpose, record) {
  return decryptWithKey(deriveKey(purpose), record);
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest().toString('base64url');
}

module.exports = { encrypt, decrypt, encryptFor, decryptFor, hashSecret, randomSecret, pkceChallenge };
