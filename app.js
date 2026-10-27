import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";
import { firebaseConfig } from './firebase-config.js';

function friendlyAuthError(e) {
  return (e && e.message) ? e.message : String(e);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);

function applyTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.body.dataset.theme = selected;
  try { localStorage.setItem('kernote-theme', selected); } catch (_) {}
  const meta = $('themeColorMeta');
  if (meta) meta.content = selected === 'dark' ? '#0b0d12' : '#f4f5f8';
  document.querySelectorAll('.theme-toggle').forEach(button => {
    const icon = button.querySelector('i');
    if (icon) icon.className = selected === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    button.title = selected === 'dark' ? 'aktifkan light mode' : 'aktifkan dark mode';
    button.setAttribute('aria-label', button.title);
  });
}

function toggleTheme() {
  applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
}

let initialTheme = 'light';
try { initialTheme = localStorage.getItem('kernote-theme') || 'light'; } catch (_) {}
applyTheme(initialTheme);
const authView = $('authView');
const dashboardView = $('dashboardView');
let currentUser = null;
let unsubscribeStats = null;
let authBusy = false;
let notesCache = [];
let currentNoteId = null;
let toolLimitCatalog = [];
let latestQuotaTools = {};
const unlimitedToolEmails = new Set(['rehanalok99.0@gmail.com', 'nurkhalifah0099@gmail.com', 'ryhnardianshh@gmail.com']);
let noteEditorBusy = false;
let noteViewMode = 'write';
let noteOriginalContent = '';

const oauthQuery = new URLSearchParams(location.search);
const pendingOAuth = oauthQuery.get('oauth') === '1' && oauthQuery.get('client_id') && oauthQuery.get('redirect_uri') && oauthQuery.get('code_challenge');
let oauthBusy = false;

function oauthParamsObject() {
  const out = {};
  for (const [key, value] of oauthQuery.entries()) if (key !== 'oauth') out[key] = value;
  return out;
}

function renderPendingOAuth() {
  const card = $('oauthApprovalCard');
  if (!card) return;
  if (!pendingOAuth) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const client = oauthQuery.get('client_name') || 'MCP client';
  const scope = oauthQuery.get('scope') || 'mcp';
  const text = $('oauthApprovalText');
  if (text) text.textContent = `${client} meminta akses ${scope} ke tool Kernote atas nama akun ini.`;
}

function oauthMessage(text, type='') {
  const el = $('oauthDashboardMessage');
  if (!el) return;
  el.textContent = text || '';
  el.className = `message ${type}`;
}

function setOAuthBusy(busy) {
  const allow = $('oauthDashboardAllow');
  const deny = $('oauthDashboardDeny');
  if (allow) {
    allow.disabled = busy;
    allow.textContent = busy ? 'mengirim ke Claude...' : 'izinkan & kembali ke Claude';
  }
  if (deny) deny.disabled = busy;
}

function returnToMcpClient(redirectUrl) {
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.location.assign(redirectUrl);
      window.close();
      setTimeout(() => {
        try { location.replace(redirectUrl); } catch (_) {}
      }, 1500);
      return;
    }
  } catch (_) {}
  location.replace(redirectUrl);
}

async function completeDashboardOAuth() {
  if (!pendingOAuth || !currentUser || oauthBusy) return;
  oauthBusy = true;
  setOAuthBusy(true);
  oauthMessage('memproses izin...');
  try {
    const firebaseIdToken = await currentUser.getIdToken(true);
    const body = { ...oauthParamsObject(), firebaseIdToken };
    const response = await fetch('/api/oauth-authorize-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(async () => ({ error: await response.text() }));
    if (!response.ok || !data.redirect) throw new Error(data.error_description || data.error || `authorization gagal (HTTP ${response.status})`);
    oauthMessage('izin berhasil. mengembalikan akses ke Claude...','ok');
    returnToMcpClient(data.redirect);
  } catch (error) {
    oauthMessage(error?.message || 'authorization gagal.', 'error');
    setOAuthBusy(false);
    oauthBusy = false;
  }
}

function denyDashboardOAuth() {
  if (!pendingOAuth || oauthBusy || !oauthQuery.get('redirect_uri')) return;
  const u = new URL(oauthQuery.get('redirect_uri'));
  u.searchParams.set('error', 'access_denied');
  const state = oauthQuery.get('state');
  if (state) u.searchParams.set('state', state);
  returnToMcpClient(u.toString());
}

if (pendingOAuth) {
  const hint = document.createElement('div');
  hint.className = 'message';
  hint.textContent = `MCP client meminta login sebelum kamu bisa mengizinkan akses (${oauthQuery.get('client_id') || 'MCP client'}).`;
  const authCard = document.querySelector('#authView .auth-card');
  const authMessage = $('authMessage');
  if (authCard && authMessage) authCard.insertBefore(hint, authMessage);
}

function message(el, text, type='') {
  if (!el) return;
  el.textContent = text || '';
  el.className = `message ${type}`;
}

function setBusy(button, busy, idleText) {
  if (!button) return;
  button.disabled = busy;
  button.dataset.idleText = button.dataset.idleText || idleText;
  button.textContent = busy ? 'memproses...' : button.dataset.idleText;
}

function api(path, options={}) {
  const headers = new Headers(options.headers || {});
  return currentUser.getIdToken().then(token => fetch(path, {
    ...options,
    headers: {
      ...Object.fromEntries(headers.entries()),
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }));
}

async function loadCredentials() {
  try {
    const data = await api('/api/account/credentials');
    $('githubStatus').textContent = data.github?.configured ? `terhubung · ${data.github.hint || ''}` : 'belum terhubung';
    $('gmailStatus').textContent = data.gmail?.configured ? `terhubung · ${data.gmail.email || ''}` : 'belum terhubung';
  } catch (_) {
    $('githubStatus').textContent = $('gmailStatus').textContent = 'gagal memuat';
  }
}

function renderStats(stats) {
  const total = Number(stats?.totalCalls || 0), success = Number(stats?.successCalls || 0), errors = Number(stats?.errorCalls || 0);
  $('totalCalls').textContent = total.toLocaleString('id-ID');
  $('successCalls').textContent = success.toLocaleString('id-ID');
  $('errorCalls').textContent = errors.toLocaleString('id-ID');
  const tools = stats?.tools || {};
  const entries = Object.entries(tools).sort((a,b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0));
  $('toolKinds').textContent = entries.length.toLocaleString('id-ID');
  const max = Math.max(...entries.map(x => Number(x[1]?.count || 0)), 1);
  $('usageList').innerHTML = entries.length ? entries.slice(0, 30).map(([name, value]) => {
    const count = Number(value?.count || 0);
    const when = value?.lastUsedAt ? new Date(Number(value.lastUsedAt)).toLocaleString('id-ID') : '-';
    return `<div class="usage-row"><div><div class="usage-name">${escapeHtml(name)}</div><div class="usage-bar"><i style="width:${Math.max(3, count/max*100)}%"></i></div></div><div class="usage-count">${count.toLocaleString('id-ID')} calls</div><div class="usage-time">${escapeHtml(when)}</div></div>`;
  }).join('') : '<div class="empty">belum ada pemakaian tool.</div>';

  if (Array.isArray(stats?.toolCatalog)) toolLimitCatalog = stats.toolCatalog;
  const quotaCounters = stats?.quotaTools && typeof stats.quotaTools === 'object' ? stats.quotaTools : {};
  const usageCounters = stats?.tools && typeof stats.tools === 'object' ? stats.tools : {};
  latestQuotaTools = {};
  for (const name of new Set([...Object.keys(usageCounters), ...Object.keys(quotaCounters)])) {
    const usedQuota = Number(quotaCounters[name]?.count || 0);
    const historicalUsage = Number(usageCounters[name]?.count || 0);
    latestQuotaTools[name] = { count: Math.max(0, usedQuota, historicalUsage) };
  }
  renderToolLimits(latestQuotaTools);
}

function renderToolLimits(quotaTools) {
  const list = $('toolLimitsList');
  if (!list) return;
  if (!toolLimitCatalog.length) {
    list.innerHTML = '<div class="empty">memuat data batas penggunaan...</div>';
    return;
  }
  const email = String(currentUser?.email || '').trim().toLowerCase();
  const unlimited = unlimitedToolEmails.has(email);
  const limit = 400;
  const filterInput = $('toolLimitFilter');
  const query = String(filterInput?.value || '').trim().toLowerCase();
  const counters = quotaTools || {};
  const rows = toolLimitCatalog.filter(name => !query || String(name).toLowerCase().includes(query)).map(name => {
    const entry = counters[name] || {};
    const used = Math.max(0, Number(entry.count) || 0);
    const remaining = Math.max(0, limit - used);
    const percent = unlimited ? 0 : Math.min(100, used / limit * 100);
    const status = unlimited ? 'tanpa batas' : (remaining === 0 ? 'habis' : `${remaining.toLocaleString('id-ID')} tersisa`);
    const usage = unlimited ? `${used.toLocaleString('id-ID')} pemanggilan` : `${used.toLocaleString('id-ID')} / ${limit}`;
    return `<div class="usage-row quota-usage-row"><div><div class="usage-name">${escapeHtml(name)}</div><div class="usage-bar"><i style="width:${Math.max(used ? 2 : 0, percent)}%"></i></div></div><div class="usage-count">${usage}</div><div class="usage-time">${status}</div></div>`;
  });
  const exhausted = Object.values(counters).filter(entry => Number(entry?.count || 0) >= limit).length;
  $('quotaSummary').textContent = unlimited
    ? `akun ini tidak memiliki batas pemanggilan per tool. ${toolLimitCatalog.length} tool tersedia.`
    : `maksimal ${limit} pemanggilan per tool. ${exhausted} tool sudah mencapai batas; sisa kuota diperbarui realtime.`;
  list.innerHTML = rows.length ? rows.join('') : '<div class="empty">tool tidak ditemukan.</div>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatNoteTime(timestamp) {
  return timestamp ? new Date(Number(timestamp)).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : 'belum diubah';
}

function noteBadge(note) {
  const access = note.visibility === 'public' ? 'AI access' : 'private';
  const encrypted = note.encrypted !== false ? 'encrypted' : 'plaintext';
  return `<span class="note-badge ${note.visibility === 'public' ? 'public' : 'private'}">${escapeHtml(access)}</span><span class="note-badge muted"><i class="fa-solid ${note.encrypted !== false ? 'fa-lock' : 'fa-lock-open'}" aria-hidden="true"></i> ${escapeHtml(encrypted)}</span>`;
}

function renderNotes() {
  const input = $('noteFilter');
  const filter = String(input ? input.value : '').trim().toLowerCase();
  const notes = notesCache.filter(note => !filter || `${note.noteId} ${note.title} ${note.description}`.toLowerCase().includes(filter));
  const count = $('notesCount');
  if (count) count.textContent = String(notesCache.length);
  const hint = $('notesListHint');
  if (hint) hint.textContent = `${notesCache.length} ${notesCache.length === 1 ? 'note' : 'notes'}`;
  const list = $('notesList');
  if (!list) return;
  list.innerHTML = notes.length ? notes.map(note => `
    <article class="note-library-card" data-note-id="${escapeHtml(note.noteId)}">
      <button class="note-card-open" data-action="preview" data-note-id="${escapeHtml(note.noteId)}" type="button" aria-label="buka ${escapeHtml(note.title || note.noteId)}">
        <div class="note-card-topline"><span class="note-type-icon"><i class="fa-brands fa-markdown" aria-hidden="true"></i></span><span class="note-card-updated">${escapeHtml(formatNoteTime(note.updatedAt))}</span></div>
        <h3>${escapeHtml(note.title || 'untitled')}</h3>
        <span class="note-library-id">${escapeHtml(note.noteId)}</span>
        <p>${escapeHtml(note.description || 'belum ada deskripsi')}</p>
        <div class="note-badges">${noteBadge(note)}</div>
      </button>
      <div class="note-card-footer"><span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${escapeHtml(formatNoteTime(note.updatedAt))}</span>
        <div class="note-card-actions">
          <button class="note-icon-btn" data-action="edit" data-note-id="${escapeHtml(note.noteId)}" type="button" title="edit note" aria-label="edit note"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button class="note-icon-btn" data-action="settings" data-note-id="${escapeHtml(note.noteId)}" type="button" title="pengaturan note" aria-label="pengaturan note"><i class="fa-solid fa-gear" aria-hidden="true"></i></button>
        </div>
      </div>
    </article>`).join('') : `<div class="notes-empty-state"><div class="empty-state-icon"><i class="fa-regular fa-file-lines" aria-hidden="true"></i></div><h3>${filter ? 'note tidak ditemukan' : 'belum ada catatan'}</h3><p>${filter ? 'coba kata pencarian lain.' : 'buat note pertama, lalu tulis tanpa gangguan di editor full-screen.'}</p>${filter ? '' : '<button class="ios-button primary" type="button" data-new-note><i class="fa-solid fa-plus" aria-hidden="true"></i><span>buat note pertama</span></button>'}</div>`;
  list.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const id = btn.dataset.noteId;
    if (btn.dataset.action === 'edit') openNote(id, 'write');
    else if (btn.dataset.action === 'settings') openNoteSettings(id);
    else openNote(id, 'preview');
  }));
  list.querySelector('[data-new-note]')?.addEventListener('click', resetNoteEditor);
}

function clearEditor() {
  currentNoteId = null;
  noteOriginalContent = '';
  $('editorMode').textContent = 'new note';
  $('editorHeading').textContent = 'untitled note';
  $('focusNoteId').textContent = 'belum disimpan';
  $('focusFooterNoteId').textContent = 'draft baru';
  $('noteContent').value = '';
  $('deleteNoteBtn').classList.add('hidden');
  $('noteSettingsQuickBtn').classList.add('hidden');
  updateContentCount();
  setEditorTab('write');
  message($('noteMessage'), '');
  renderNotes();
}

function resetNoteEditor() {
  clearEditor();
  switchSection('notes');
  showNoteFocus('write');
  $('noteContent').focus();
}

function fillNoteSettings(note) {
  const data = note || {};
  $('settingsNoteId').value = data.noteId || '';
  $('settingsNoteId').disabled = !!data.noteId;
  $('settingsNoteTitle').value = data.title || '';
  $('settingsNoteDescription').value = data.description || '';
  $('settingsNoteStatus').value = data.status || 'draft';
  $('settingsNoteVisibility').value = data.visibility || 'private';
  $('settingsNoteEncrypted').value = data.encrypted === false ? 'false' : 'true';
  $('settingsDescriptionCount').textContent = String($('settingsNoteDescription').value.length);
  $('noteSettingsMessage').textContent = '';
  $('noteSettingsMessage').className = 'message';
}

let settingsSaveContent = false;
let settingsTargetNoteId = null;

function openNoteSettings(noteId, forNew = false) {
  const note = noteId ? notesCache.find(item => item.noteId === noteId) : null;
  settingsTargetNoteId = noteId || null;
  settingsSaveContent = !!forNew;
  fillNoteSettings(note);
  const dialog = $('noteSettingsDialog');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else dialog?.setAttribute('open', '');
}

async function saveNoteSettings(closeAfter = true) {
  if (noteEditorBusy) return;
  const payload = {
    noteId: $('settingsNoteId').value.trim(),
    title: $('settingsNoteTitle').value.trim(),
    description: $('settingsNoteDescription').value.trim(),
    status: $('settingsNoteStatus').value,
    visibility: $('settingsNoteVisibility').value,
    encrypted: $('settingsNoteEncrypted').value === 'true'
  };
  if (!payload.noteId) return message($('noteSettingsMessage'), 'noteId wajib diisi.', 'error');
  if (!/^[A-Za-z0-9_-]+$/.test(payload.noteId)) return message($('noteSettingsMessage'), 'noteId hanya boleh berisi huruf, angka, - dan _.', 'error');
  if (!payload.title) return message($('noteSettingsMessage'), 'judul wajib diisi.', 'error');
  if (payload.description.length > 300) return message($('noteSettingsMessage'), 'deskripsi maksimal 300 karakter.', 'error');

  noteEditorBusy = true;
  setBusy($('saveNoteSettingsBtn'), true, 'simpan');
  message($('noteSettingsMessage'), 'menyimpan...');
  const targetId = settingsTargetNoteId || currentNoteId;
  const focusWasOpen = !$('noteFocusScreen').classList.contains('hidden');
  const focusedNoteIdBeforeSave = currentNoteId;
  try {
    let data;
    if (settingsSaveContent && targetId) {
      data = await api(`/api/account/notes?noteId=${encodeURIComponent(targetId)}`, { method:'PUT', body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        status: payload.status,
        visibility: payload.visibility,
        encrypted: payload.encrypted,
        content: $('noteContent').value
      }) });
    } else if (settingsSaveContent) {
      data = await api('/api/account/notes', { method:'POST', body: JSON.stringify({ ...payload, content: $('noteContent').value }) });
    } else {
      if (!targetId) throw new Error('note tidak ditemukan');
      data = await api(`/api/account/notes?noteId=${encodeURIComponent(targetId)}`, { method:'PUT', body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        status: payload.status,
        visibility: payload.visibility,
        encrypted: payload.encrypted
      }) });
    }
    if (settingsSaveContent) {
      currentNoteId = data.noteId;
      $('editorHeading').textContent = data.title || data.noteId;
      $('focusNoteId').textContent = data.noteId;
      $('focusFooterNoteId').textContent = data.noteId;
      noteOriginalContent = $('noteContent').value;
    } else if (focusWasOpen && focusedNoteIdBeforeSave === targetId) {
      $('editorHeading').textContent = data.title || data.noteId;
    }
    if (focusWasOpen && (settingsSaveContent || focusedNoteIdBeforeSave === targetId)) {
      $('deleteNoteBtn').classList.remove('hidden');
      $('noteSettingsQuickBtn').classList.remove('hidden');
    }
    await loadNotes();
    if (focusWasOpen) message($('noteMessage'), 'note tersimpan.', 'ok');
    if (closeAfter) $('noteSettingsDialog').close();
    if (focusWasOpen) updateFocusActions();
  } catch (e) {
    message($('noteSettingsMessage'), e.message, 'error');
  } finally {
    noteEditorBusy = false;
    setBusy($('saveNoteSettingsBtn'), false, 'simpan');
  }
}

async function loadNotes() {
  try {
    const data = await api('/api/account/notes');
    notesCache = Array.isArray(data.notes) ? data.notes : [];
    renderNotes();
  } catch (e) {
    notesCache = [];
    $('notesList').innerHTML = `<div class="notes-load-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>gagal memuat notes: ${escapeHtml(e.message)}</span></div>`;
  }
}

function syncEditorMeta(data) {
  currentNoteId = data.noteId;
  $('editorMode').textContent = 'editing note';
  $('editorHeading').textContent = data.title || data.noteId;
  $('focusNoteId').textContent = data.noteId;
  $('focusFooterNoteId').textContent = data.noteId;
  $('deleteNoteBtn').classList.remove('hidden');
  $('noteSettingsQuickBtn').classList.remove('hidden');
}

async function openNote(noteId, mode = 'write') {
  if (noteEditorBusy) return;
  noteEditorBusy = true;
  message($('noteMessage'), 'memuat note...');
  try {
    const data = await api(`/api/account/notes?noteId=${encodeURIComponent(noteId)}`);
    syncEditorMeta(data);
    $('noteContent').value = data.content || '';
    noteOriginalContent = $('noteContent').value;
    updateContentCount();
    switchSection('notes');
    showNoteFocus(mode === 'preview' ? 'preview' : 'write');
    message($('noteMessage'), '');
    renderNotes();
  } catch (e) {
    switchSection('notes');
    message($('authMessage'), `gagal membuka note: ${e.message}`, 'error');
  } finally {
    noteEditorBusy = false;
  }
}

function saveNote() {
  if (noteEditorBusy) return;
  const current = currentNoteId ? notesCache.find(item => item.noteId === currentNoteId) : null;
  fillNoteSettings(current || (currentNoteId ? { noteId: currentNoteId } : null));
  settingsTargetNoteId = currentNoteId;
  settingsSaveContent = true;
  const dialog = $('noteSettingsDialog');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  else dialog?.setAttribute('open', '');
}

async function deleteCurrentNote() {
  if (!currentNoteId || noteEditorBusy) return;
  if (!confirm(`hapus note "${currentNoteId}"?`)) return;
  noteEditorBusy = true;
  const deleteButton = $('deleteNoteBtn');
  const deleteButtonHtml = deleteButton.innerHTML;
  deleteButton.disabled = true;
  deleteButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>menghapus</span>';
  message($('noteMessage'), 'menghapus...');
  try {
    await api(`/api/account/notes?noteId=${encodeURIComponent(currentNoteId)}`, { method:'DELETE' });
    closeNoteFocus();
    clearEditor();
    await loadNotes();
  } catch (e) {
    message($('noteMessage'), e.message, 'error');
  } finally {
    noteEditorBusy = false;
    deleteButton.disabled = false;
    deleteButton.innerHTML = deleteButtonHtml;
  }
}

function setEditorTab(tab) {
  noteViewMode = tab === 'preview' ? 'preview' : 'write';
  $('noteContent').classList.toggle('hidden', noteViewMode === 'preview');
  $('notePreview').classList.toggle('hidden', noteViewMode !== 'preview');
  if (noteViewMode === 'preview') renderNotePreview();
  updateFocusActions();
}

function updateFocusActions() {
  const viewing = noteViewMode === 'preview';
  $('editorMode').textContent = currentNoteId ? (viewing ? 'reading note' : 'editing note') : 'new note';
  $('previewQuickBtn').innerHTML = viewing
    ? '<i class="fa-solid fa-pen" aria-hidden="true"></i><span>edit</span>'
    : '<i class="fa-solid fa-eye" aria-hidden="true"></i><span>preview</span>';
  $('previewQuickBtn').title = viewing ? 'edit note' : 'lihat preview';
  $('previewQuickBtn').setAttribute('aria-label', viewing ? 'edit note' : 'lihat preview');
  $('saveNoteBtn').classList.toggle('hidden', viewing && !!currentNoteId);
  $('noteSettingsQuickBtn').classList.toggle('hidden', !currentNoteId);
  $('deleteNoteBtn').classList.toggle('hidden', !currentNoteId || viewing);
  $('noteContent').readOnly = false;
}

function showNoteFocus(mode = 'write') {
  const screen = $('noteFocusScreen');
  screen.classList.remove('hidden');
  document.body.classList.add('note-focus-open');
  setEditorTab(mode);
  updateFocusActions();
  $('noteContent').scrollTop = 0;
  $('notePreview').scrollTop = 0;
}

function closeNoteFocus() {
  $('noteFocusScreen').classList.add('hidden');
  document.body.classList.remove('note-focus-open');
}

function backToNotes() {
  if ($('noteContent').value !== noteOriginalContent) {
    if (!confirm('perubahan belum disimpan. buang perubahan dan kembali ke daftar notes?')) return;
  }
  closeNoteFocus();
  switchSection('notes');
  loadNotes();
}

function renderNotePreview() {
  const markdown = $('noteContent').value || '*belum ada isi*';
  try {
    const parsed = window.marked?.parse ? window.marked.parse(markdown) : escapeHtml(markdown).replace(/\n/g, '<br>');
    $('notePreview').innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(parsed) : parsed;
  } catch (_) {
    $('notePreview').textContent = markdown;
  }
}

function updateContentCount() {
  const content = $('noteContent').value || '';
  const bytes = new TextEncoder().encode(content).length;
  $('contentCount').textContent = `${(bytes / 1024).toFixed(bytes > 1024 ? 1 : 0)} KB`;
}

function switchSection(name) {
  document.body.classList.toggle('notes-library-open', name === 'notes');
  document.querySelectorAll('.app-section').forEach(section => section.classList.toggle('hidden', section.id !== `section-${name}`));
  document.querySelectorAll('.nav-item[data-section]').forEach(btn => btn.classList.toggle('active', btn.dataset.section === name));
  const isNotes = name === 'notes';
  dashboardView.classList.toggle('notes-section-active', isNotes);
  if (!isNotes) closeNoteFocus();
  const labels = {
    overview: ['workspace', 'overview'],
    statistics: ['usage analytics', 'statistics'],
    notes: ['cloud markdown', 'notes'],
    integrations: ['per-user credentials', 'integrations'],
    account: ['firebase authentication', 'account']
  };
  const label = labels[name] || labels.overview;
  $('sectionEyebrow').textContent = label[0];
  $('sectionTitle').textContent = label[1];
  closeSidebar();
  if (isNotes) loadNotes();
}

function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebarBackdrop').classList.remove('hidden');
  document.body.classList.add('drawer-open');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebarBackdrop').classList.add('hidden');
  document.body.classList.remove('drawer-open');
}

async function showDashboard(user) {
  currentUser = user;
  authView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  $('logoutBtn').classList.add('hidden');
  const name = user.displayName || user.email?.split('@')[0] || 'akun';
  $('welcomeName').textContent = name;
  $('welcomeEmail').textContent = user.email || '';
  $('profileName').textContent = name;
  $('profileProvider').textContent = (user.providerData?.[0]?.providerId || 'firebase').replace('password','email/password');
  $('profileAccountEmail').textContent = user.email || '';
  $('profilePhoto').src = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=171d26&color=fff`;
  $('sidebarName').textContent = name;
  $('sidebarEmail').textContent = user.email || '';
  $('sidebarAvatarDot').textContent = name.charAt(0).toUpperCase();
  $('mcpEndpoint').textContent = `${location.origin}/mcp`;
  $('accountMcpEndpoint').textContent = `${location.origin}/mcp`;
  renderPendingOAuth();
  switchSection('overview');
  await Promise.all([loadCredentials(), loadNotes()]);
  if (unsubscribeStats) unsubscribeStats();
  unsubscribeStats = onValue(ref(db, `users/${user.uid}/stats`), snap => renderStats(snap.val() || {}), () => api('/api/account/stats').then(renderStats).catch(()=>{}));
  api('/api/account/stats').then(renderStats).catch(() => {});
}

async function ensurePersistence() { await setPersistence(auth, browserLocalPersistence); }

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (authBusy) return;
  authBusy = true;
  message($('authMessage'),'');
  setBusy($('authSubmit'), true, 'login');
  try {
    await ensurePersistence();
    await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
  } catch (e) {
    message($('authMessage'), friendlyError(e), 'error');
  } finally {
    authBusy = false;
    setBusy($('authSubmit'), false, 'login');
  }
});

$('resetPassword').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) return message($('authMessage'), 'isi email dulu, lalu tekan lupa password.', 'error');
  try {
    await sendPasswordResetEmail(auth, email);
    message($('authMessage'), 'kalau akun email/password tersedia untuk email itu, link reset sudah dikirim. cek inbox dan spam.', 'ok');
  } catch (e) {
    message($('authMessage'), friendlyAuthError(e), 'error');
  }
});

document.querySelectorAll('[data-connect]').forEach(btn => btn.addEventListener('click', () => openCredentialDialog(btn.dataset.connect)));
function openCredentialDialog(service) {
  const dialog = $('credentialDialog');
  $('credentialTitle').textContent = service === 'github' ? 'GitHub connection' : 'Gmail connection';
  $('credentialHelp').textContent = service === 'github' ? 'PAT akun ini disimpan terenkripsi di RTDB; token asli tidak ditampilkan kembali.' : 'Gmail app password akun ini disimpan terenkripsi di RTDB.';
  $('githubFields').classList.toggle('hidden', service !== 'github');
  $('gmailFields').classList.toggle('hidden', service !== 'gmail');
  $('credentialForm').dataset.service = service;
  $('githubToken').value = $('gmailUser').value = $('gmailPassword').value = '';
  message($('credentialMessage'),'');
  dialog.showModal();
}

$('credentialForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const service = $('credentialForm').dataset.service;
  const value = service === 'github' ? { token: $('githubToken').value.trim() } : { user: $('gmailUser').value.trim(), appPassword: $('gmailPassword').value.trim() };
  try {
    await api('/api/account/credentials', { method:'POST', body:JSON.stringify({service,value}) });
    message($('credentialMessage'),'credential tersimpan terenkripsi','ok');
    await loadCredentials();
    setTimeout(() => $('credentialDialog').close(), 500);
  } catch (err) {
    message($('credentialMessage'), err.message, 'error');
  }
});

document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', toggleTheme));
$('menuBtn').addEventListener('click', openSidebar);
$('sidebarClose').addEventListener('click', closeSidebar);
$('sidebarBackdrop').addEventListener('click', closeSidebar);
document.querySelectorAll('.nav-item[data-section]').forEach(btn => btn.addEventListener('click', () => switchSection(btn.dataset.section)));
document.querySelectorAll('[data-go-section]').forEach(btn => btn.addEventListener('click', () => switchSection(btn.dataset.goSection)));
$('sidebarLogout').addEventListener('click', () => signOut(auth));
$('accountLogout').addEventListener('click', () => signOut(auth));
$('refreshStats').addEventListener('click', () => { const button = $('refreshStats'); button.disabled = true; api('/api/account/stats').then(renderStats).catch(e => { const list = $('usageList'); if (list) list.innerHTML = `<div class="notes-load-error">${escapeHtml(e.message)}</div>`; }).finally(() => { button.disabled = false; }); });
$('toolLimitFilter').addEventListener('input', () => renderToolLimits(latestQuotaTools));
$('copyEndpoint').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('mcpEndpoint').textContent);
  $('copyEndpoint').textContent = 'copied';
  setTimeout(() => $('copyEndpoint').textContent='copy', 1200);
});
$('noteFilter').addEventListener('input', renderNotes);
$('notesHomeBtn').addEventListener('click', () => switchSection('overview'));
$('newNoteBtn').addEventListener('click', resetNoteEditor);
$('saveNoteSettingsBtn').addEventListener('click', () => saveNoteSettings(true));
$('settingsNoteDescription').addEventListener('input', () => { $('settingsDescriptionCount').textContent = String($('settingsNoteDescription').value.length); });
$('previewQuickBtn').addEventListener('click', () => setEditorTab(noteViewMode === 'preview' ? 'write' : 'preview'));
$('noteSettingsQuickBtn').addEventListener('click', () => { if (currentNoteId) openNoteSettings(currentNoteId); });
$('noteBackBtn').addEventListener('click', backToNotes);
$('refreshNotesBtn').addEventListener('click', loadNotes);
$('saveNoteBtn').addEventListener('click', saveNote);
$('deleteNoteBtn').addEventListener('click', deleteCurrentNote);
$('noteContent').addEventListener('input', () => { updateContentCount(); if (!$('notePreview').classList.contains('hidden')) renderNotePreview(); });
$('oauthDashboardAllow')?.addEventListener('click', completeDashboardOAuth);
$('oauthDashboardDeny')?.addEventListener('click', denyDashboardOAuth);

onAuthStateChanged(auth, user => {
  if (user) showDashboard(user);
  else {
    currentUser = null;
    closeNoteFocus();
    document.body.classList.remove('notes-library-open', 'note-focus-open');
    dashboardView.classList.remove('notes-section-active');
    authView.classList.remove('hidden');
    dashboardView.classList.add('hidden');
    if(unsubscribeStats){unsubscribeStats();unsubscribeStats=null;}
    closeSidebar();
  }
});

function friendlyError(e) {
  const code = e?.code || '';
  const map = {
    'auth/invalid-credential':'email atau password salah.',
    'auth/invalid-email':'format email tidak valid.',
    'auth/email-already-in-use':'email sudah terdaftar. gunakan halaman registrasi untuk akun baru, atau login dengan akun tersebut.',
    'auth/weak-password':'password terlalu lemah. gunakan minimal 6 karakter.',
    'auth/too-many-requests':'terlalu banyak percobaan. coba lagi beberapa saat.',
    'auth/operation-not-allowed':'provider login ini belum diaktifkan di Firebase Authentication.',
    'auth/unauthorized-domain':'domain website ini belum ditambahkan ke Authorized domains Firebase.',
    'auth/network-request-failed':'koneksi ke Firebase gagal. cek jaringan lalu coba lagi.',
    'auth/user-disabled':'akun ini dinonaktifkan di Firebase.',
    'auth/internal-error':'Firebase mengembalikan kesalahan internal. coba lagi.',
    'auth/web-storage-unsupported':'browser ini tidak mendukung penyimpanan yang dibutuhkan Firebase Auth. coba Chrome/Firefox terbaru.'
  };
  const base = map[code] || e?.message || 'terjadi kesalahan login.';
  return code ? `${base} [${code}]` : base;
}
