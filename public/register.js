import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const $ = id => document.getElementById(id);

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = selected;
  try { localStorage.setItem('kernote-theme', selected); } catch (_) {}
  const meta = $('themeColorMeta');
  if (meta) meta.content = selected === 'dark' ? '#0b0d12' : '#f4f5f8';
  const button = $('themeTogglePublic');
  if (button) {
    const icon = button.querySelector('i');
    if (icon) icon.className = selected === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    button.title = selected === 'dark' ? 'aktifkan light mode' : 'aktifkan dark mode';
    button.setAttribute('aria-label', button.title);
  }
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('kernote-theme') || 'light'; } catch (_) {}
applyTheme(savedTheme);
$('themeTogglePublic').addEventListener('click', () => applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));

function message(text, type='') {
  $('registerMessage').textContent = text || '';
  $('registerMessage').className = `message ${type}`;
}

function friendlyError(e) {
  const code = e?.code || '';
  const map = {
    'auth/invalid-email':'format email tidak valid.',
    'auth/email-already-in-use':'email sudah terdaftar. kembali ke halaman login.',
    'auth/weak-password':'password terlalu lemah. gunakan minimal 6 karakter.',
    'auth/operation-not-allowed':'login email/password belum diaktifkan di Firebase Authentication.',
    'auth/network-request-failed':'koneksi ke Firebase gagal. cek jaringan lalu coba lagi.',
    'auth/too-many-requests':'terlalu banyak percobaan. coba lagi beberapa saat.',
    'auth/internal-error':'Firebase mengembalikan kesalahan internal. coba lagi.'
  };
  const base = map[code] || e?.message || 'registrasi gagal.';
  return code ? `${base} [${code}]` : base;
}

$('registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('registerEmail').value.trim();
  const password = $('registerPassword').value;
  const confirm = $('registerPasswordConfirm').value;
  const button = $('registerSubmit');

  if (password !== confirm) {
    message('password dan ulangi password tidak sama.', 'error');
    return;
  }

  button.disabled = true;
  button.textContent = 'membuat akun...';
  message('');

  try {
    await setPersistence(auth, browserLocalPersistence);
    await createUserWithEmailAndPassword(auth, email, password);
    message('akun berhasil dibuat. mengarahkan ke dashboard...', 'ok');
    setTimeout(() => { location.href = '/'; }, 500);
  } catch (e) {
    message(friendlyError(e), 'error');
    button.disabled = false;
    button.textContent = 'buat akun';
  }
});
