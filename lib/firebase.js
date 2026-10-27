const credentials = require('../credential');

let cached = null;

function getFirebaseConfig() {
  const cfg = credentials.firebase || {};
  return {
    databaseURL: cfg.databaseURL || process.env.FIREBASE_DATABASE_URL,
    webApiKey: cfg.webApiKey || process.env.FIREBASE_WEB_API_KEY,
  };
}

function normalizeServiceAccount(input) {
  if (!input) return null;

  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }

  if (!value || typeof value !== 'object') return null;

  const projectId = value.projectId || value.project_id || '';
  const clientEmail = value.clientEmail || value.client_email || '';
  let privateKey = value.privateKey || value.private_key || '';

  if (privateKey) {
    privateKey = String(privateKey)
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\n/g, '\n');
  }

  if (!projectId || !clientEmail || !privateKey) return null;

  return {
    projectId: String(projectId),
    clientEmail: String(clientEmail),
    privateKey,
  };
}

function getConfiguredServiceAccount() {
  const cfg = credentials.firebase || {};

  const fromConfig = normalizeServiceAccount(cfg.serviceAccount);
  if (fromConfig) return fromConfig;

  const fromJson = normalizeServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (fromJson) return fromJson;

  const fromEnv = normalizeServiceAccount({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
  });
  if (fromEnv) return fromEnv;

  return null;
}

function getAdmin() {
  if (cached) return cached;

  let initializeApp;
  let getApps;
  let cert;
  let app;
  let getAuth;
  let getDatabase;

  try {
    const appSdk = require('firebase-admin/app');
    const authSdk = require('firebase-admin/auth');
    const dbSdk = require('firebase-admin/database');
    initializeApp = appSdk.initializeApp;
    getApps = appSdk.getApps;
    cert = appSdk.cert;
    getAuth = authSdk.getAuth;
    getDatabase = dbSdk.getDatabase;
    if (typeof initializeApp !== 'function' || typeof getApps !== 'function' || typeof cert !== 'function' || typeof getAuth !== 'function' || typeof getDatabase !== 'function') {
      throw new Error('Firebase Admin modular exports are incomplete');
    }
  } catch (error) {
    const detail = error && error.message ? ': ' + error.message : '';
    throw new Error('Firebase Admin SDK cannot be loaded. Make sure npm installed firebase-admin 14.x and deploy from the folder containing package.json.' + detail);
  }

  const cfg = credentials.firebase || {};
  const databaseURL = cfg.databaseURL || process.env.FIREBASE_DATABASE_URL;

  if (!databaseURL) {
    throw new Error('Firebase Realtime Database URL is not configured. Fill firebase.databaseURL in credential.js or FIREBASE_DATABASE_URL.');
  }

  const apps = getApps();
  if (apps.length) {
    app = apps[0];
  } else {
    const serviceAccount = getConfiguredServiceAccount();
    if (!serviceAccount) {
      throw new Error('Firebase Admin service account is not configured. Fill firebase.serviceAccount in credential.js or FIREBASE_SERVICE_ACCOUNT_JSON.');
    }

    app = initializeApp({
      credential: cert(serviceAccount),
      databaseURL,
    });
  }

  const auth = getAuth(app);
  const db = getDatabase(app);

  // Backward-compatible shape for existing code in this project.
  const admin = {
    database: {
      ServerValue: {
        increment(delta) {
          return { '.sv': { increment: Number(delta) || 0 } };
        },
      },
    },
  };

  cached = { admin, app, auth, db };
  return cached;
}

async function verifyFirebaseIdToken(idToken) {
  if (!idToken) throw new Error('missing Firebase ID token');
  const { auth } = getAdmin();
  return auth.verifyIdToken(idToken, true);
}

async function getUserRecord(uid) {
  const { auth } = getAdmin();
  return auth.getUser(uid);
}

module.exports = {
  getAdmin,
  getFirebaseConfig,
  getConfiguredServiceAccount,
  normalizeServiceAccount,
  verifyFirebaseIdToken,
  getUserRecord,
};
