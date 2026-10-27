try {
  const fa = require('firebase-admin/app');
  console.log('firebase-admin/app: OK', typeof fa.initializeApp, typeof fa.getApps, typeof fa.cert);
  const jr = require('jwks-rsa/package.json');
  console.log('jwks-rsa:', jr.version);
  const jose = require('jwks-rsa/node_modules/jose/package.json');
  console.log('nested jose used by jwks-rsa:', jose.version);
  require('firebase-admin/auth');
  console.log('firebase-admin/auth: OK');
} catch (e) {
  console.error('dependency check failed:', e && e.stack ? e.stack : e);
  process.exit(1);
}
