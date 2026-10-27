import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { firebaseConfig } from './firebase-config.js';

function friendlyAuthError(e) {
  const code = e && e.code ? e.code : '';
  return (e && e.message) ? e.message : String(e);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const params = new URLSearchParams(location.search);
const form = document.getElementById('oauthAuthForm');
const msg = document.getElementById('oauthMessage');
const clientName = document.getElementById('oauthClientName');
const state = Object.fromEntries(params.entries());
clientName.textContent = `${state.client_name || 'MCP client'} meminta akses ${state.scope || 'mcp'} ke Kernote-Node-beta.`;

function show(text, kind='') { msg.textContent=text; msg.className=`message ${kind}`; }
function friendlyError(e) {
  const map = {
    'auth/invalid-credential':'email atau password salah.',
    'auth/operation-not-allowed':'provider login belum diaktifkan di Firebase Authentication.',
    'auth/unauthorized-domain':'domain OAuth belum masuk Authorized domains Firebase.',
    'auth/network-request-failed':'koneksi ke Firebase gagal.',
    'auth/web-storage-unsupported':'browser ini tidak mendukung penyimpanan Firebase Auth yang dibutuhkan.'
  };
  return `${map[e?.code] || e?.message || 'login gagal.'}${e?.code ? ` [${e.code}]` : ''}`;
}
let pendingUser = null;
function showConsent(user) {
  pendingUser = user;
  document.getElementById('oauthLoginState').classList.add('hidden');
  document.getElementById('oauthConsent').classList.remove('hidden');
  document.getElementById('oauthConsentText').textContent = `${state.client_name || 'MCP client'} akan memakai tool Kernote-Node-beta atas nama akun ${user.email || ''}.`;
}
async function complete() {
  if (!pendingUser) return;
  try {
    const firebaseIdToken = await pendingUser.getIdToken(true);
    const response = await fetch('/api/oauth-authorize-complete', {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({...state, firebaseIdToken})
    });
    const data = await response.json().catch(()=>({}));
    if (!response.ok || !data.redirect) throw new Error(data.error_description||data.error||'authorization failed');
    document.getElementById('oauthConsent').classList.add('hidden');
    document.getElementById('oauthSuccess').classList.remove('hidden');
    location.href = data.redirect;
  } catch (e) { show(e.message || 'authorization gagal','error'); }
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  show('memproses login...');
  try {
    await setPersistence(auth, browserLocalPersistence);
    const result = await signInWithEmailAndPassword(auth, document.getElementById('oauthEmail').value.trim(), document.getElementById('oauthPassword').value);
    showConsent(result.user);
  } catch (e) { show(friendlyError(e),'error'); }
});

document.getElementById('oauthAllow').addEventListener('click', complete);
document.getElementById('oauthDeny').addEventListener('click', () => {
  if (state.redirect_uri) {
    const u=new URL(state.redirect_uri);
    u.searchParams.set('error','access_denied');
    if(state.state) u.searchParams.set('state',state.state);
    location.href=u.toString();
  }
});
onAuthStateChanged(auth, () => {});
