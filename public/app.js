const state = { user: null, page: 'documents', docs: [], truncated: false, search: '', searchMode: 'auto', from: '', to: '', type: '', year: '', party: '', timer: null };
const categoryOptions = ['عام', 'إداري', 'مالي', 'قانوني', 'فني', 'موارد بشرية', 'صيانة', 'أخرى'];
const permissionGroups = [
  { title: 'الكتب والمعاملات', items: [
    ['documents.view', 'عرض الكتب والبحث والطباعة والتنزيل'],
    ['documents.create', 'إضافة الكتب والمسح الضوئي'],
    ['documents.edit', 'تعديل بيانات الكتب'],
    ['documents.delete', 'نقل الكتب إلى سلة المحذوفات'],
    ['documents.relate', 'إضافة وإزالة ربط الكتب'],
    ['documents.followup', 'إضافة متابعة للمعاملات'],
    ['reports.export', 'تصدير تقارير Excel']
  ] },
  { title: 'النسخ الاحتياطي والإدارة', items: [
    ['backup.create', 'نسخ الأرشيف والحسابات احتياطياً، ونسخ Excel والصور'],
    ['backup.restore', 'استرجاع الأرشيف والحسابات من نسخة احتياطية'],
    ['trash.manage', 'استرجاع المحذوفات وحذفها نهائياً'],
    ['audit.view', 'عرض سجل الحركة'],
    ['users.manage', 'إدارة حسابات المستخدمين ومنح الصلاحيات']
  ] }
];
const allPermissionKeys = permissionGroups.flatMap(group => group.items.map(([key]) => key));
const legacyStaffPermissions = ['documents.view', 'documents.create', 'documents.edit', 'documents.relate', 'documents.followup', 'reports.export'];
const documentDependentPermissions = ['documents.create', 'documents.edit', 'documents.delete', 'documents.relate', 'documents.followup', 'reports.export', 'trash.manage'];
function userPermissionKeys(user = state.user) {
  if (!user) return [];
  if (user.role === 'admin') return allPermissionKeys;
  return Array.isArray(user.permissions) ? user.permissions.filter(key => allPermissionKeys.includes(key)) : legacyStaffPermissions;
}
function can(permission) { return userPermissionKeys().includes(permission); }
function canOpenPage(page) {
  if (page === 'new') return can('documents.create');
  if (page === 'users') return can('users.manage');
  if (page === 'audit') return can('audit.view');
  if (page === 'trash') return can('trash.manage');
  if (page === 'backup') return can('backup.create') || can('backup.restore');
  return can('documents.view');
}
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const content = $('#content');
const IDLE_LOCK_MS = 20 * 60 * 1000;
let idleLockTimer = null;
const DOCUMENT_REFRESH_MS = 15 * 1000;
let documentRefreshTimer = null;
let documentRefreshGeneration = 0;
let documentLoadPromise = null;
let documentLoadQueued = false;

function isDocumentListVisible() {
  return Boolean(state.user && can('documents.view') && state.page === 'documents' && !document.hidden && !$('#app').classList.contains('hidden') && $('#docs-result'));
}
function canRefreshDocuments() {
  const active = document.activeElement;
  return documentRefreshTimer !== null && isDocumentListVisible() && !$('#modal-root').childElementCount && !state.timer && !active?.matches('input, textarea, select') && !active?.isContentEditable;
}
function stopDocumentRefresh() {
  documentRefreshGeneration += 1;
  clearInterval(documentRefreshTimer); documentRefreshTimer = null;
  clearTimeout(state.timer); state.timer = null;
  documentLoadQueued = false;
}
function startDocumentRefresh() {
  if (documentRefreshTimer !== null) return;
  documentRefreshTimer = setInterval(() => loadDocuments({ background: true }), DOCUMENT_REFRESH_MS);
}
window.addEventListener('focus', () => loadDocuments({ background: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadDocuments({ background: true }); });

function stopIdleLock() { clearTimeout(idleLockTimer); idleLockTimer = null; }
function resetIdleLock() {
  stopIdleLock();
  if (!state.user) return;
  idleLockTimer = setTimeout(() => {
    showToast('راح تنقفل الجلسة بعد دقيقة بسبب عدم الاستخدام.', 'error');
    idleLockTimer = setTimeout(lockAfterIdle, 60 * 1000);
  }, IDLE_LOCK_MS - 60 * 1000);
}
async function lockAfterIdle() {
  if (!state.user) return;
  stopIdleLock();
  stopDocumentRefresh();
  state.user = null;
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
  closeModal();
  content.innerHTML = '';
  $('#app').classList.add('hidden');
  renderLogin(false, 'تم قفل الجلسة تلقائياً. سجّل الدخول للمتابعة.');
}
for (const eventName of ['pointerdown', 'keydown', 'input', 'scroll', 'wheel', 'touchstart']) {
  document.addEventListener(eventName, resetIdleLock, { passive: true });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function initials(name = '') { return [...name.trim()][0] || 'م'; }
function dateLabel(value) {
  if (!value) return '—';
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('ar-IQ', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}
function fileSize(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function typeName(type) { return ({ incoming: 'كتب واردنا', external_incoming: 'وارد خارجي', outgoing: 'كتاب صادر', transaction: 'معاملة' })[type] || type; }
function typeBadge(type) { return `<span class="type-badge type-${escapeHtml(type)}">${typeName(type)}</span>`; }
function statusName(status) { return ({ new: 'جديدة', in_progress: 'قيد الإنجاز', completed: 'منجزة' })[status] || 'جديدة'; }
function statusBadge(status) { return `<span class="status-badge status-${escapeHtml(status || 'new')}">${statusName(status)}</span>`; }
function showToast(message, kind = 'success') {
  const toast = document.createElement('div'); toast.className = `toast ${kind}`; toast.textContent = message;
  $('#toast-root').append(toast); setTimeout(() => toast.remove(), 3600);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null; stopIdleLock(); closeModal(); content.innerHTML = ''; $('#app').classList.add('hidden'); renderLogin(false, 'انتهت الجلسة. سجّل الدخول للمتابعة.');
    }
    throw new Error(data.error || 'تعذر إكمال الطلب.');
  }
  return data;
}
function setUser(user) {
  state.user = user;
  state.page = 'documents';
  resetIdleLock();
  startDocumentRefresh();
  $('#user-name').textContent = user.full_name;
  $('#user-role').textContent = user.role === 'admin' ? 'مدير النظام' : 'صلاحيات محددة';
  $('#user-avatar').textContent = initials(user.full_name);
  $('#top-avatar').textContent = initials(user.full_name);
  $$('.nav-item[data-page]').forEach(el => el.classList.toggle('hidden', !canOpenPage(el.dataset.page)));
  const hasManagement = ['users', 'audit', 'trash', 'backup'].some(canOpenPage);
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !hasManagement));
}
function field(label, name, { type = 'text', value = '', required = false, placeholder = '', max = '', full = false, help = '', options = null, accept = '' } = {}) {
  let control;
  if (options) control = `<select id="f-${name}" name="${name}" ${required ? 'required' : ''}>${options.map(o => `<option value="${escapeHtml(o.value)}" ${value === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
  else if (type === 'textarea') control = `<textarea id="f-${name}" name="${name}" ${required ? 'required' : ''} ${max ? `maxlength="${max}"` : ''} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`;
  else control = `<input id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''} ${max ? `maxlength="${max}"` : ''} ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ''} ${accept ? `accept="${accept}"` : ''}>`;
  return `<div class="field ${full ? 'full' : ''}"><label for="f-${name}">${escapeHtml(label)}${required ? ' <span class="req">*</span>' : ''}</label>${control}${help ? `<small class="help">${escapeHtml(help)}</small>` : ''}</div>`;
}
function modal(title, subtitle, body, actions = '') {
  disposeAllFilePreviews();
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header class="modal-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-close-modal type="button" aria-label="إغلاق">×</button></header><div class="modal-body">${body}${actions}</div></section></div>`;
  $('.modal-backdrop').addEventListener('click', e => { if (e.target.dataset.closeModal !== undefined) closeModal(); });
  $('.modal-close').focus();
}
function closeModal() {
  disposeAllFilePreviews();
  window.scannedArchiveFile = null; window.scannedPages = []; window.scannedDeviceId = '';
  window.scannedArchiveFile = null;
  window.archiveFileSelectionToken = (window.archiveFileSelectionToken || 0) + 1;
  window.archiveFilesPreparing = false;
  window.relationPreviewToken = (window.relationPreviewToken || 0) + 1;
  window.savedViewerToken = (window.savedViewerToken || 0) + 1;
  $('#modal-root').innerHTML = '';
}
const SAVED_USERNAMES_KEY = 'arsheefna.saved-usernames';
function getSavedUsernames() {
  try {
    const values = JSON.parse(localStorage.getItem(SAVED_USERNAMES_KEY) || '[]');
    return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].slice(0, 20) : [];
  } catch { return []; }
}
function rememberUsername(username) {
  const value = String(username || '').trim();
  if (!value || value.length > 50) return;
  const values = getSavedUsernames().filter(item => item.toLocaleLowerCase() !== value.toLocaleLowerCase());
  try { localStorage.setItem(SAVED_USERNAMES_KEY, JSON.stringify([value, ...values].slice(0, 20))); } catch {}
  if (window.archiveLogin?.rememberUsername) return window.archiveLogin.rememberUsername(value).catch(() => {});
  return Promise.resolve();
}
async function prepareLoginForm(restoreSavedCredentials) {
  const username = $('#f-username');
  const datalist = $('#saved-usernames');
  const remember = $('#remember-password');
  const status = $('#credential-status');
  username.autocomplete = 'username';
  username.setAttribute('list', 'saved-usernames');
  let remembered = getSavedUsernames();
  if (window.archiveLogin?.getUsernames) {
    try {
      const result = await window.archiveLogin.getUsernames();
      if (Array.isArray(result?.usernames)) remembered = result.usernames;
    } catch {}
  }
  datalist.innerHTML = remembered.map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
  $('#f-password').autocomplete = 'current-password';
  if (!window.archiveLogin) {
    remember.disabled = true;
    status.textContent = 'حفظ كلمة المرور متاح عند فتح نسخة سطح المكتب.';
    return;
  }
  try {
    const saved = await window.archiveLogin.get();
    if (!saved?.available) {
      remember.disabled = true;
      status.textContent = 'الحفظ الآمن لكلمة المرور غير متاح على هذا الجهاز.';
      return;
    }
    remember.checked = Boolean(saved.credentials);
    if (saved.credentials && restoreSavedCredentials) {
      username.value = saved.credentials.username || '';
      $('#f-password').value = saved.credentials.password || '';
    }
    status.textContent = 'اختياري: تُحفظ كلمة المرور مشفّرة على هذا الجهاز.';
  } catch {
    remember.disabled = true;
    status.textContent = 'تعذر تشغيل الحفظ الآمن لكلمة المرور.';
  }
  remember.addEventListener('change', async () => {
    if (remember.checked) return;
    try { await window.archiveLogin.clear(); status.textContent = 'تم حذف كلمة المرور المحفوظة.'; }
    catch { status.textContent = 'تعذر حذف كلمة المرور المحفوظة.'; }
  });
}
function renderLogin(setup = false, message = '') {
  disposeAllFilePreviews();
  stopDocumentRefresh();
  $('#app').classList.add('hidden');
  const root = $('#modal-root');
  if (setup) {
    root.innerHTML = `<main class="login-screen"><section class="login-card"><div class="login-brand"><div class="brand-mark">أ</div><div><strong>أرشيفنا</strong><span>الأرشفة الإلكترونية</span></div></div><p class="eyebrow">الإعداد الأول على هذا اللابتوب</p><h1>إنشاء حسابك المحلي</h1><p class="intro">أنشئ حساباً خاصاً بك لحماية الأرشيف. احفظ كلمة المرور بمكان آمن؛ لا يمكن استعادتها من النظام.</p><div class="setup-mark"></div><form id="setup-form"><div class="form-grid">${field('الاسم الكامل','full_name',{required:true,max:120,full:true,placeholder:'مثال: أحمد محمد'})}${field('اسم المستخدم','username',{required:true,max:50,placeholder:'مثال: ahmed'})}${field('كلمة المرور','password',{type:'password',required:true,max:200,help:'6 أحرف على الأقل.'})}</div><div class="login-alert ${message ? 'show' : ''}">${escapeHtml(message)}</div><button class="button button-primary login-submit" type="submit">إنشاء الحساب وبدء الاستخدام</button></form><div class="login-foot">أرشيف محلي · محفوظ على هذا اللابتوب</div></section></main>`;
    $('#setup-form').addEventListener('submit', submitSetup);
    return;
  }
  stopIdleLock();
  root.innerHTML = `<main class="login-screen"><section class="login-card"><div class="login-brand"><div class="brand-mark">أ</div><div><strong>أرشيفنا</strong><span>الأرشفة الإلكترونية</span></div></div><h1>أهلاً بعودتك</h1><p class="intro">سجّل الدخول للوصول إلى كتبك ومعاملاتك الرسمية المحفوظة على هذا اللابتوب.</p><form id="login-form">${field('اسم المستخدم','username',{required:true,placeholder:'أدخل اسم المستخدم'})}<datalist id="saved-usernames"></datalist>${field('كلمة المرور','password',{type:'password',required:true,placeholder:'أدخل كلمة المرور'})}<label class="remember-password"><input id="remember-password" type="checkbox"><span>حفظ كلمة المرور على هذا الجهاز</span></label><small id="credential-status" class="credential-status">اختياري</small><div class="login-alert ${message ? 'show' : ''}">${escapeHtml(message)}</div><button class="button button-primary login-submit" type="submit">تسجيل الدخول <span>←</span></button></form><div class="login-foot">أرشيف محلي · تُقفل الجلسة بعد 20 دقيقة من عدم الاستخدام</div></section></main>`;
  $('#login-form').addEventListener('submit', submitLogin);
  prepareLoginForm(!message);
}
async function submitSetup(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true;
  try {
    await api('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) });
    rememberUsername(form.get('username'));
    const me = await api('/api/me'); $('#modal-root').innerHTML = ''; $('#app').classList.remove('hidden'); setUser(me.user); await renderPage(); showToast('تم إعداد الأرشيف المحلي على هذا اللابتوب.');
  } catch (error) { renderLogin(true, error.message); }
}
async function submitLogin(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget); const submit = $('button[type=submit]', event.currentTarget); submit.disabled = true;
  try {
    const credentials = { username: String(form.get('username') || '').trim(), password: String(form.get('password') || '') };
    const shouldRemember = $('#remember-password').checked;
    await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
    rememberUsername(credentials.username);
    let credentialSaveError = false;
    if (window.archiveLogin) {
      try {
        if (shouldRemember) await window.archiveLogin.save(credentials);
        else await window.archiveLogin.clear();
      } catch { credentialSaveError = shouldRemember; }
    }
    const me = await api('/api/me'); $('#modal-root').innerHTML = ''; $('#app').classList.remove('hidden'); setUser(me.user); await renderPage();
    if (credentialSaveError) showToast('تم الدخول، لكن تعذر حفظ كلمة المرور على هذا الجهاز.', 'error');
  } catch (error) { renderLogin(false, error.message); }
}
async function boot() {
  $('#today-label').textContent = new Intl.DateTimeFormat('ar-IQ', { dateStyle: 'medium' }).format(new Date());
  try {
    const status = await api('/api/setup-status');
    if (status.needsSetup) { renderLogin(true); return; }
    const me = await api('/api/me'); setUser(me.user); $('#modal-root').innerHTML = ''; $('#app').classList.remove('hidden'); await renderPage();
  } catch { renderLogin(false); }
}

function pageName(page) { return ({ documents: 'كل الوثائق', users: 'المستخدمون', new: 'إضافة وثيقة', reminders: 'مواعيد المتابعة', audit: 'سجل الحركة', trash: 'سلة المحذوفات', backup: 'نسخ احتياطي واستعادة' })[page] || 'كل الوثائق'; }
async function renderPage() {
  if (!canOpenPage(state.page)) state.page = 'documents';
  $('#page-crumb').textContent = pageName(state.page);
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === state.page));
  $('#sidebar').classList.remove('open');
  if (state.page === 'users') return renderUsers();
  if (state.page === 'audit') return renderAudit();
  if (state.page === 'trash') return renderTrash();
  if (state.page === 'reminders') return renderReminders();
  if (state.page === 'backup') return renderBackup();
  if (state.page === 'new') { state.page = 'documents'; await renderPage(); return openDocumentModal(); }
  return renderDocuments();
}
async function renderDocuments() {
  if (!can('documents.view')) { state.docs = []; content.innerHTML = '<div class="page-head"><div><h1>أرشيفنا</h1><p class="page-subtitle">ما عندك صلاحية لعرض الكتب. تگدر تستخدم الخيارات المسموحة لحسابك من القائمة.</p></div></div>'; return; }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">إدارة المراسلات والسجلات</p><h1>كل الوثائق</h1><p class="page-subtitle">تظهر آخر 10 كتب حسب وقت أرشفتها. البحث والفلاتر يشملان الأرشيف كله.</p></div><div class="section-toolbar"><button class="button button-quiet" id="print-report" type="button">طباعة تقرير</button><button class="button button-quiet" id="export-excel" type="button">تصدير Excel</button><button class="button button-primary" id="add-document"><span>＋</span> إضافة وثيقة</button></div></div>
    <div class="stats-grid" id="stats-grid"></div>
    <section class="panel"><div class="panel-header"><div><h2 class="panel-title">سجل الوثائق</h2><div class="panel-hint">الأرقام تبحث أولاً برقم الكتاب المطابق؛ غيّر نطاق البحث إذا تريد البحث بباقي الحقول.</div></div><span class="section-toolbar"><button class="button button-quiet button-small" id="reset-filters" type="button">مسح الفلاتر</button><button class="button button-quiet button-small" id="refresh-docs">↻ تحديث</button></span></div>
      <div class="section-toolbar"><button class="button button-quiet button-small" data-type-preset="outgoing" type="button">الكتب الصادرة</button><button class="button button-quiet button-small" data-type-preset="external_incoming" type="button">الوارد الخارجي</button><button class="button button-quiet button-small" data-type-preset="incoming" type="button">كتب واردنا</button></div><div class="filter-bar"><label class="search-box"><span class="search-icon">⌕</span><input id="search-input" type="search" placeholder="رقم الكتاب أو رقم الأرشيف أو الموضوع…" value="${escapeHtml(state.search)}"></label><select id="search-mode-filter" aria-label="نطاق البحث"><option value="auto">تلقائي: رقم الكتاب أولاً</option><option value="number-exact">رقم الكتاب بالضبط</option><option value="all">كل الحقول</option></select><input id="party-filter" type="search" aria-label="تصفية حسب الجهة" placeholder="الجهة المرسلة أو المستلمة" value="${escapeHtml(state.party)}"><input id="year-filter" type="number" min="1900" max="2200" aria-label="السنة" placeholder="السنة" value="${escapeHtml(state.year)}"><select id="type-filter"><option value="">كل الأنواع</option><option value="incoming">كتب واردنا</option><option value="external_incoming">وارد خارجي</option><option value="outgoing">كتاب صادر</option></select><label class="date-filter-label">من <input type="date" id="from-filter" aria-label="من تاريخ"></label><label class="date-filter-label">إلى <input type="date" id="to-filter" aria-label="إلى تاريخ"></label></div>
      <div id="docs-result"></div></section>
     <div class="callout">تُحفظ الملفات الأصلية على هذا اللابتوب مع بياناتها. عند إضافة الوثيقة، اكتب العنوان والرقم والتاريخ بدقة لتسهيل البحث.</div>`;
  $('#add-document').addEventListener('click', () => openDocumentModal());
  $('#add-document').classList.toggle('hidden', !can('documents.create'));
  $('#export-excel').classList.toggle('hidden', !can('reports.export'));
  $('#print-report').addEventListener('click', printReport);
  $('#export-excel').addEventListener('click', exportExcel);
  $('#refresh-docs').addEventListener('click', () => loadDocuments());
  $('#reset-filters').addEventListener('click', () => { Object.assign(state, { search: '', searchMode: 'auto', from: '', to: '', type: '', year: '', party: '' }); renderDocuments(); });
  $('#search-input').addEventListener('input', e => { state.search = e.target.value; scheduleLoad(); });
  $('#search-mode-filter').value = state.searchMode;
  $('#search-mode-filter').addEventListener('change', e => { state.searchMode = e.target.value; loadDocuments(); });
  $('#party-filter').addEventListener('input', e => { state.party = e.target.value; scheduleLoad(); });
  $('#year-filter').addEventListener('input', e => { state.year = e.target.value.slice(0, 4); e.target.value = state.year; scheduleLoad(); });
  $('#type-filter').value = state.type;
  $('#from-filter').value = state.from;
  $('#to-filter').value = state.to;
  $('#type-filter').addEventListener('change', e => { state.type = e.target.value; loadDocuments(); });
  $('#from-filter').addEventListener('change', e => { state.from = e.target.value; loadDocuments(); });
  $('#to-filter').addEventListener('change', e => { state.to = e.target.value; loadDocuments(); });
  await loadDocuments();
}
function hasDocumentFilters() {
  return [state.search, state.from, state.to, state.type, state.party].some(value => String(value || '').trim()) || /^\d{4}$/.test(state.year);
}
function documentListParams() {
  const params = currentFilterParams();
  if (!hasDocumentFilters()) params.set('recent', '1');
  return params;
}
function scheduleLoad() { clearTimeout(state.timer); state.timer = setTimeout(() => { state.timer = null; loadDocuments(); }, 250); }
async function loadDocuments({ background = false } = {}) {
  if (!isDocumentListVisible() || (background && !canRefreshDocuments())) return;
  if (documentLoadPromise) {
    if (!background) documentLoadQueued = true;
    return documentLoadPromise;
  }
  documentLoadPromise = (async () => {
    let passive = background;
    do {
      documentLoadQueued = false;
      const target = $('#docs-result'); const user = state.user;
      const generation = documentRefreshGeneration;
      const params = documentListParams().toString();
      const canApply = () => generation === documentRefreshGeneration && isDocumentListVisible() && state.user === user && $('#docs-result') === target && documentListParams().toString() === params && (!passive || canRefreshDocuments());
      try {
        const result = await api(`/api/documents?${params}`);
        if (canApply()) {
          state.docs = result.documents; state.truncated = result.truncated;
          renderDocsTable(result.documents, result.truncated);
          await loadStats(canApply, passive);
        }
      } catch (error) { if (!passive && canApply()) showToast(error.message, 'error'); }
      passive = false;
    } while (documentLoadQueued && isDocumentListVisible());
  })().finally(() => { documentLoadPromise = null; documentLoadQueued = false; });
  return documentLoadPromise;
}
function reportFilters() {
  return [
    state.search && `بحث: ${state.search}`, state.search && state.searchMode !== 'auto' && `نطاق البحث: ${state.searchMode === 'number-exact' ? 'رقم الكتاب بالضبط' : 'كل الحقول'}`, state.party && `الجهة: ${state.party}`, state.year && `السنة: ${state.year}`,
    state.type && `النوع: ${typeName(state.type)}`, state.from && `من: ${state.from}`, state.to && `إلى: ${state.to}`
  ].filter(Boolean).join(' · ') || 'كل الوثائق';
}
async function printReport() {
  if (!can('documents.view')) return;
  let reportDocs; let reportTruncated;
  try {
    const result = await api(`/api/documents?${currentFilterParams()}`);
    reportDocs = result.documents; reportTruncated = result.truncated;
  } catch (error) { showToast(error.message, 'error'); return; }
  if (!reportDocs.length) { showToast('ماكو نتائج حتى نطبعها.', 'error'); return; }
  $('#print-report-root')?.remove();
  const rows = reportDocs.map((doc, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(doc.archive_no || '—')}</td><td>${escapeHtml(doc.title)}</td><td>${escapeHtml(doc.doc_number)}</td><td>${dateLabel(doc.doc_date)}</td><td>${typeName(doc.doc_type)}</td><td>${escapeHtml(doc.sender || '—')}</td><td>${escapeHtml(doc.recipient || '—')}</td></tr>`).join('');
  const root = document.createElement('section'); root.id = 'print-report-root'; root.dir = 'rtl';
  root.innerHTML = `<h1>تقرير أرشيفنا</h1><p>${escapeHtml(reportFilters())}</p><p>عدد النتائج: ${reportDocs.length.toLocaleString('ar-IQ')}${reportTruncated ? ' — هذه أول 500 نتيجة؛ ضيّق الفلاتر لطباعة البقية.' : ''}</p><table><thead><tr><th>#</th><th>رقم الأرشيف</th><th>العنوان / الموضوع</th><th>الرقم</th><th>التاريخ</th><th>النوع</th><th>الجهة المرسلة</th><th>الجهة المستلمة</th></tr></thead><tbody>${rows}</tbody></table><footer>تاريخ الطباعة: ${new Intl.DateTimeFormat('ar-IQ', { dateStyle: 'medium' }).format(new Date())}</footer>`;
  document.body.append(root);
  window.addEventListener('afterprint', () => root.remove(), { once: true });
  window.print(); setTimeout(() => root.remove(), 15000);
}
async function exportExcel() {
  if (!can('reports.export')) { showToast('ما عندك صلاحية لتصدير التقارير.', 'error'); return; }
  const button = $('#export-excel'); if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/export.xlsx?${currentFilterParams()}`, { credentials: 'same-origin' });
    if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || 'تعذر تصدير ملف Excel.'); }
    const file = await response.blob(); const url = URL.createObjectURL(file); const link = document.createElement('a');
    link.href = url; link.download = `تقرير-أرشيفنا-${new Date().toISOString().slice(0, 10)}.xlsx`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000); showToast('تم تجهيز تقرير Excel حسب الفلاتر الحالية.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { if (button?.isConnected) button.disabled = false; }
}
const excelExportMonthNames = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
function excelExportPeriodMarkup() {
  return `<section class="excel-export-period" aria-labelledby="excel-export-period-title"><h3 id="excel-export-period-title">تحديد فترة نسخة Excel وملفات الكتب</h3><label class="excel-export-year-label" for="excel-export-year">السنة</label><select id="excel-export-year"><option value="">كل السنوات — الأرشيف كامل</option></select><fieldset id="excel-export-months" disabled><legend>الأشهر — تگدر تختار أكثر من شهر</legend><label class="excel-export-month"><input id="excel-export-all-months" type="checkbox" checked>كل الأشهر</label><div class="excel-export-month-grid">${excelExportMonthNames.map((name, index) => `<label class="excel-export-month"><input type="checkbox" data-excel-export-month value="${index + 1}" checked>${index + 1} — ${name}</label>`).join('')}</div></fieldset><small>الاختيار حسب تاريخ الكتاب، وينطبق على Excel وملف صور الكتب ZIP معاً. استخدم نفس الاختيار عند تنزيل الملفين.</small><p id="excel-export-period-summary" role="status">كل السنوات وكل الأشهر</p></section>`;
}
function readExcelExportPeriod() {
  const year = $('#excel-export-year').value;
  if (!year) return { year: '', months: [] };
  const months = $$('[data-excel-export-month]:checked').map(input => Number(input.value));
  if (!months.length) throw new Error('اختار شهراً واحداً على الأقل أو فعّل «كل الأشهر».');
  return { year, months };
}
function setupExcelExportPeriodControls() {
  const year = $('#excel-export-year'); const months = $('#excel-export-months');
  const all = $('#excel-export-all-months'); const inputs = $$('[data-excel-export-month]');
  const summary = $('#excel-export-period-summary');
  const update = () => {
    months.disabled = !year.value;
    const selected = inputs.filter(input => input.checked);
    all.checked = selected.length === 12; all.indeterminate = selected.length > 0 && selected.length < 12;
    summary.textContent = !year.value ? 'كل السنوات وكل الأشهر' : selected.length === 12 ? `سنة ${year.value} — كل الأشهر` : selected.length ? `سنة ${year.value} — ${selected.map(input => excelExportMonthNames[Number(input.value) - 1]).join('، ')}` : 'اختار شهراً واحداً على الأقل.';
  };
  year.addEventListener('change', update);
  all.addEventListener('change', () => { inputs.forEach(input => { input.checked = all.checked; }); update(); });
  inputs.forEach(input => input.addEventListener('change', update));
  api('/api/backup/excel-periods').then(result => {
    if (!year.isConnected) return;
    const years = result.years.filter(value => /^[1-9]\d{3}$/.test(String(value)));
    year.innerHTML = `<option value="">كل السنوات — الأرشيف كامل</option>${years.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
    update();
  }).catch(() => { if (summary.isConnected) summary.textContent = 'تعذر تحميل قائمة السنوات. حدّث الصفحة للمحاولة مرة ثانية؛ تصدير الأرشيف الكامل متاح.'; });
  update();
}
function renderBackup() {
  if (!canOpenPage('backup')) { state.page = 'documents'; return renderDocuments(); }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">حماية بياناتك</p><h1>نسخ احتياطي واستعادة</h1><p class="page-subtitle">احتفظ بنسخة تشمل الكتب المرفقة والحسابات، وتحقق منها قبل الاستعادة.</p></div></div><div class="panel backup-status-card" id="auto-backup-status">جارٍ قراءة حالة النسخ التلقائي…</div><div class="backup-grid"><section class="panel backup-card"><div class="backup-icon">↓</div><h2>إنشاء نسخة احتياطية</h2><p>ينزّل ملفاً واحداً يحتوي على بيانات الأرشيف وكل الملفات المرفقة. خزّنه بفلاش أو بمكان آمن.</p><button class="button button-primary" id="download-backup" type="button">تنزيل نسخة احتياطية كاملة</button><button class="button button-quiet" id="download-auto-backup" type="button">تنزيل آخر نسخة تلقائية</button><button class="button button-quiet" id="download-safety-backup" type="button" disabled>تنزيل نسخة ما قبل الاستعادة</button><button class="button button-quiet" id="download-excel-backup" type="button">تنزيل ملف Excel</button><button class="button button-quiet" id="download-excel-images" type="button">تنزيل ملف صور الكتب ZIP</button><small class="backup-excel-note">نزّل ملف Excel وملف صور الكتب كل واحد بزر. كلك يمين على «صور الكتب.zip» واختر «استخراج الكل» بمكان ملف Excel؛ راح ينشأ مجلد «صور الكتب» وتعمل الروابط. ZIP يحتوي الملفات الأصلية كاملة، بما فيها كل صفحات PDF.</small></section><section class="panel backup-card"><div class="backup-icon restore-icon">↥</div><h2>استعادة نسخة احتياطية</h2><p>افحص النسخة أولاً. قبل الاستبدال، ينشئ البرنامج تلقائياً نسخة أمان من الأرشيف الحالي.</p><label class="backup-file-label" for="backup-file">اختيار ملف النسخة</label><input id="backup-file" type="file" accept=".arshbackup,.zip,application/zip"><div id="backup-file-name" class="backup-file-name">لم يتم اختيار ملف</div><button class="button button-quiet" id="verify-backup" type="button" disabled>فحص النسخة المختارة</button><div id="backup-validation" class="backup-validation" aria-live="polite">اختر ملف نسخة أرشيفنا ثم افحصه.</div><button class="button button-danger" id="restore-backup" type="button" disabled>استعادة النسخة</button></section></div><div class="callout backup-callout">ينشئ البرنامج نسخة تلقائية مؤرخة كل يوم ويحتفظ بآخر 3 نسخ، ويحذف الأقدم تلقائياً. قبل الاستعادة يفحص سلامة قاعدة البيانات ووجود ملفات الكتب، ويحفظ نسخة من الأرشيف الحالي. احتفظ أيضاً بنسخة خارج اللابتوب.</div>`;
  content.insertAdjacentHTML('beforeend', `<section class="panel external-backup-panel"><div><p class="eyebrow">نسخة خارج اللابتوب</p><h2>نسخ احتياطي إلى قرص خارجي</h2><p>اختار فلاش USB أو قرصاً خارجياً. البرنامج ينشئ داخله مجلد «أرشيفنا-نسخ-احتياطية» ويحدّث آخر 3 نسخ يومية تلقائياً عند اتصال القرص.</p><div id="external-backup-status" class="external-backup-status" aria-live="polite">جارٍ قراءة حالة القرص الخارجي…</div></div><div class="external-backup-actions"><button class="button button-primary" id="choose-external-backup" type="button">اختيار قرص خارجي</button><button class="button button-quiet" id="sync-external-backup" type="button" disabled>مزامنة النسخة الآن</button></div></section>`);
  $('#download-excel-backup').insertAdjacentHTML('beforebegin', excelExportPeriodMarkup());
  const backupCards = $$('.backup-grid > .backup-card');
  backupCards[0].classList.toggle('hidden', !can('backup.create'));
  backupCards[1].classList.toggle('hidden', !can('backup.restore'));
  $('.external-backup-panel').classList.toggle('hidden', !can('backup.create'));
  if (can('backup.create')) setupExcelExportPeriodControls();
  const statusTarget = $('#auto-backup-status');
  api('/api/backup-status').then(status => {
    if (!statusTarget.isConnected) return;
  const lastDate = status.latestDate || status.latest?.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    const safetyDateKey = status.safetyLatest?.match(/(\d{8})-(\d{6})/)?.[1];
    const safetyDate = safetyDateKey ? `${safetyDateKey.slice(0, 4)}-${safetyDateKey.slice(4, 6)}-${safetyDateKey.slice(6, 8)}` : '';
    statusTarget.innerHTML = `<div class="backup-status-copy"><strong>النسخ اليومي التلقائي مفعّل</strong><span>${lastDate ? `آخر نسخة: ${dateLabel(lastDate)}` : 'تُنشأ أول نسخة تلقائياً عند تشغيل البرنامج بعد إعداد الحساب.'} · المحفوظ: ${Number(status.count).toLocaleString('ar-IQ')} من ${status.keep}</span><span>${status.safetyLatest ? `نسخ الأمان قبل الاستعادة: ${Number(status.safetyCount).toLocaleString('ar-IQ')} · آخر نسخة بتاريخ ${safetyDate || 'متاح'}` : 'نسخة ما قبل الاستعادة تظهر هنا بعد أول استعادة.'}</span>${status.error ? `<span class="backup-error">${escapeHtml(status.error)}</span>` : ''}<span id="backup-verify-result" aria-live="polite"></span></div><button class="button button-quiet button-small" id="verify-auto-backup" type="button" ${status.latest ? '' : 'disabled'}>فحص آخر نسخة تلقائية</button>`;
    $('#download-safety-backup').disabled = !status.safetyLatest;
    $('#verify-auto-backup').classList.toggle('hidden', !can('backup.create'));
    $('#verify-auto-backup').addEventListener('click', async event => {
      if (!can('backup.create')) return;
      const button = event.currentTarget; const originalText = button.textContent; button.disabled = true; button.textContent = 'جارٍ الفحص…';
      try {
        const result = await api('/api/backup/automatic/verify');
        $('#backup-verify-result').textContent = `النسخة سليمة: ${Number(result.documentCount).toLocaleString('ar-IQ')} وثيقة و${Number(result.fileCount).toLocaleString('ar-IQ')} ملف.`;
      } catch (error) { $('#backup-verify-result').textContent = error.message; }
      finally { button.disabled = false; button.textContent = originalText; }
    });
  }).catch(error => { statusTarget.textContent = error.message; });
  const externalStatusTarget = $('#external-backup-status'); const externalSyncButton = $('#sync-external-backup');
  async function loadExternalBackupStatus() {
    if (!can('backup.create')) return null;
    try {
      const external = await api('/api/backup/external/status');
      externalSyncButton.disabled = !external.configured || !external.available;
      const latestText = external.latestDate ? `آخر نسخة خارجية: ${dateLabel(external.latestDate)} · ${Number(external.count).toLocaleString('ar-IQ')} من 3` : (external.available && external.configured ? 'القرص متصل، ولم تتم مزامنة نسخة عليه بعد.' : '');
      const locationText = external.directory ? `مكان الحفظ: ${external.directory}` : '';
      const mainText = !external.configured ? 'ما محدد قرص خارجي بعد.' : external.available ? 'القرص الخارجي متصل.' : 'القرص الخارجي غير متصل أو المسار يحتاج تغييراً.';
      externalStatusTarget.innerHTML = `<strong>${escapeHtml(mainText)}</strong>${latestText ? `<span>${escapeHtml(latestText)}</span>` : ''}${locationText ? `<span>${escapeHtml(locationText)}</span>` : ''}${external.error ? `<span class="backup-error">${escapeHtml(external.error)}</span>` : ''}`;
      return external;
    } catch (error) {
      externalSyncButton.disabled = true; externalStatusTarget.textContent = error.message; return null;
    }
  }
  if (can('backup.create')) loadExternalBackupStatus();
  $('#choose-external-backup').addEventListener('click', async event => {
    if (!can('backup.create')) return;
    const button = event.currentTarget; button.disabled = true;
    try {
      if (!window.archiveBackup?.chooseExternalFolder) throw new Error('اختيار المجلد الخارجي متوفر من نسخة سطح المكتب فقط.');
      const selected = await window.archiveBackup.chooseExternalFolder();
      if (selected?.canceled) return;
      const external = await loadExternalBackupStatus();
      if (external?.available) {
        const sync = await api('/api/backup/external/sync', { method: 'POST' });
        showToast(`تم تحديث النسخة الخارجية (${Number(sync.copied).toLocaleString('ar-IQ')} ملف).`);
      } else showToast('تم حفظ المكان؛ تحقق من توصيل القرص واختيار قرص خارجي مختلف عن قرص البرنامج.', 'error');
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; await loadExternalBackupStatus(); }
  });
  externalSyncButton.addEventListener('click', async () => {
    if (!can('backup.create')) return;
    externalSyncButton.disabled = true;
    try {
      const result = await api('/api/backup/external/sync', { method: 'POST' });
      showToast(`تم تحديث النسخة الخارجية (${Number(result.copied).toLocaleString('ar-IQ')} ملف).`);
    } catch (error) { showToast(error.message, 'error'); }
    finally { await loadExternalBackupStatus(); }
  });
  const picker = $('#backup-file'); const verify = $('#verify-backup'); const restore = $('#restore-backup'); const validation = $('#backup-validation');
  const downloadBackup = async (event, path, fileName, successMessage) => {
    if (!can('backup.create')) return;
    const button = event.currentTarget; button.disabled = true;
    try {
      const response = await fetch(path, { credentials: 'same-origin' });
      if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || 'تعذر تنزيل النسخة الاحتياطية.'); }
      const file = await response.blob(); const url = URL.createObjectURL(file); const link = document.createElement('a');
      link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000); showToast(successMessage);
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
  };
  $('#download-backup').addEventListener('click', event => downloadBackup(event, '/api/backup', `أرشيفنا-${new Date().toISOString().slice(0, 10)}.arshbackup`, 'تم تنزيل النسخة الاحتياطية.'));
  $('#download-auto-backup').addEventListener('click', event => downloadBackup(event, '/api/backup/automatic/latest', `أرشيفنا-نسخة-تلقائية-${new Date().toISOString().slice(0, 10)}.arshbackup`, 'تم تنزيل آخر نسخة تلقائية.'));
  $('#download-safety-backup').addEventListener('click', event => downloadBackup(event, '/api/backup/safety/latest', `أرشيفنا-ما-قبل-الاستعادة-${new Date().toISOString().slice(0, 10)}.arshbackup`, 'تم تنزيل نسخة الأمان السابقة.'));
  let excelExportBusy = false;
  const downloadExcelBackupFile = async (event, output) => {
    if (!can('backup.create')) return;
    if (excelExportBusy) return;
    const button = event.currentTarget; const originalText = button.textContent;
    const exportButtons = [$('#download-excel-backup'), $('#download-excel-images')];
    const yearControl = $('#excel-export-year'); const monthsControl = $('#excel-export-months');
    try {
      const period = readExcelExportPeriod();
      excelExportBusy = true;
      exportButtons.forEach(item => { item.disabled = true; }); yearControl.disabled = true; monthsControl.disabled = true;
      button.textContent = output === 'excel' ? 'جارٍ إنشاء ملف Excel…' : 'جارٍ إنشاء ملف الصور…';
      const response = await fetch('/api/backup.xlsx', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ output, ...period }) });
      if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || 'تعذر إنشاء نسخة Excel.'); }
      const count = Number(response.headers.get('x-archive-file-count') || 0); const file = await response.blob(); const url = URL.createObjectURL(file); const link = document.createElement('a');
      const periodSuffix = period.year ? `-${period.year}-${period.months.map(month => String(month).padStart(2, '0')).join('-')}` : '';
      link.href = url; link.download = output === 'excel' ? `أرشيفنا-بيانات-الكتب${periodSuffix}-${new Date().toISOString().slice(0, 10)}.xlsx` : 'صور الكتب.zip'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      showToast(output === 'excel' ? `تم تنزيل Excel وفيه روابط ${count.toLocaleString('ar-IQ')} ملف. نزّل ملف صور الكتب ZIP أيضاً.` : `تم تنزيل «صور الكتب.zip» (${count.toLocaleString('ar-IQ')} ملف كامل). استخرجه بجانب Excel.`);
    } catch (error) { showToast(error.message, 'error'); }
    finally {
      excelExportBusy = false;
      if (button.isConnected) {
        button.textContent = originalText;
        exportButtons.forEach(item => { item.disabled = false; }); yearControl.disabled = false; monthsControl.disabled = !yearControl.value;
      }
    }
  };
  $('#download-excel-backup').addEventListener('click', event => downloadExcelBackupFile(event, 'excel'));
  $('#download-excel-images').addEventListener('click', event => downloadExcelBackupFile(event, 'images'));
  let verifiedFile = null; let verifiedInfo = null;
  picker.addEventListener('change', () => {
    const file = picker.files[0]; verifiedFile = null; verifiedInfo = null;
    $('#backup-file-name').textContent = file ? `${file.name} · ${fileSize(file.size)}` : 'لم يتم اختيار ملف';
    validation.textContent = file ? 'افحص الملف للتأكد من سلامة البيانات وملفات الكتب.' : 'اختر ملف نسخة أرشيفنا ثم افحصه.';
    verify.disabled = !file; restore.disabled = true;
  });
  verify.addEventListener('click', async () => {
    if (!can('backup.restore')) return;
    const file = picker.files[0]; if (!file) return;
    verify.disabled = true; restore.disabled = true; validation.textContent = 'جارٍ فحص قاعدة البيانات وملفات الكتب…';
    try {
      const result = await api('/api/backup/verify-upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      verifiedFile = file; verifiedInfo = result;
      const date = result.createdAt ? dateLabel(result.createdAt.slice(0, 10)) : 'غير محدد';
      validation.textContent = `النسخة سليمة — تاريخها ${date}، وتحتوي ${Number(result.documentCount).toLocaleString('ar-IQ')} وثيقة و${Number(result.fileCount).toLocaleString('ar-IQ')} ملف.`;
      restore.disabled = false;
    } catch (error) { validation.textContent = error.message; verify.disabled = false; }
  });
  restore.addEventListener('click', async () => {
    if (!can('backup.restore')) return;
    const file = picker.files[0]; if (!file || verifiedFile !== file || !verifiedInfo) return;
    if (!confirm(`راح تستبدل الأرشيف الحالي بالنسخة «${file.name}» التي تحتوي ${verifiedInfo.documentCount} وثيقة. البرنامج راح يحفظ نسخة أمان من الأرشيف الحالي قبل الاستبدال. تكمل؟`)) return;
    restore.disabled = true; verify.disabled = true;
    try {
      const response = await fetch('/api/restore', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
      let data = {}; try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.error || 'تعذرت استعادة النسخة.');
      state.user = null; showToast('تمت الاستعادة وحُفظت نسخة أمان من الأرشيف السابق.'); renderLogin(false, 'تمت الاستعادة. سجّل الدخول ببيانات النسخة المستعادة.');
    } catch (error) { showToast(error.message, 'error'); verify.disabled = false; restore.disabled = false; }
  });
}
function currentFilterParams() {
  return new URLSearchParams({ q: state.search, searchMode: state.searchMode, from: state.from, to: state.to, type: state.type, year: state.year, party: state.party });
}
async function loadStats(canApply = () => true, background = false) {
  const target = $('#stats-grid'); const user = state.user; if (!target) return;
  const isCurrent = () => state.user === user && $('#stats-grid') === target && canApply();
  try {
    const s = await api('/api/summary');
    if (!isCurrent()) return;
    target.innerHTML = `<article class="stat-card"><div><span class="stat-label">إجمالي الوثائق</span><strong>${Number(s.total).toLocaleString('ar-IQ')}</strong><small>وثيقة محفوظة</small></div><span class="stat-icon">▤</span></article><article class="stat-card"><div><span class="stat-label">كتب واردنا</span><strong>${Number(s.byType.incoming || 0).toLocaleString('ar-IQ')}</strong><small>كتب مسجلة</small></div><span class="stat-icon">↓</span></article><article class="stat-card"><div><span class="stat-label">الكتب الصادرة</span><strong>${Number(s.byType.outgoing || 0).toLocaleString('ar-IQ')}</strong><small>كتب مسجلة</small></div><span class="stat-icon">↑</span></article><article class="stat-card"><div><span class="stat-label">الوارد الخارجي</span><strong>${Number(s.byType.external_incoming || 0).toLocaleString('ar-IQ')}</strong><small>كتب مسجلة</small></div><span class="stat-icon">◷</span></article>`;
  } catch { if (!background && isCurrent()) target.innerHTML = ''; }
}
async function renderReminders() {
  if (!can('documents.view')) { state.page = 'documents'; return renderDocuments(); }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">متابعة المعاملات الرسمية</p><h1>مواعيد المتابعة</h1><p class="page-subtitle">الكتب التي اقترب موعد متابعتها أو تأخرت، وما زالت غير منجزة.</p></div><button class="button button-quiet" id="refresh-reminders" type="button">↻ تحديث</button></div><div id="reminders-result"></div>`;
  $('#refresh-reminders').addEventListener('click', renderReminders);
  const target = $('#reminders-result');
  try {
    const result = await api('/api/reminders');
    const renderRows = rows => rows.length ? `<div class="table-wrap"><table class="reminder-table"><thead><tr><th>عنوان الوثيقة</th><th>الرقم</th><th>تاريخ الكتاب</th><th>موعد المتابعة</th><th>إجراء</th></tr></thead><tbody>${rows.map(doc => `<tr><td><strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.department || 'بدون قسم')}</small></td><td><span class="doc-number">${escapeHtml(doc.doc_number)}</span></td><td>${dateLabel(doc.doc_date)}</td><td>${dateLabel(doc.due_date)}</td><td><button class="button button-quiet button-small" data-reminder-edit="${escapeHtml(doc.id)}" type="button">${can('documents.edit') ? 'تعديل / إنجاز' : 'عرض الملف'}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state compact-empty"><strong>ماكو معاملات بهذا القسم</strong></div>`;
    target.innerHTML = `<section class="panel reminder-panel"><div class="panel-header"><div><h2 class="panel-title">متأخرة</h2><div class="panel-hint">موعدها فات وما زالت غير منجزة</div></div><span class="reminder-count overdue-count">${result.overdue.length.toLocaleString('ar-IQ')}</span></div>${renderRows(result.overdue)}</section><section class="panel reminder-panel"><div class="panel-header"><div><h2 class="panel-title">خلال الأيام السبعة القادمة</h2><div class="panel-hint">من اليوم إلى نهاية الأسبوع القادم</div></div><span class="reminder-count">${result.upcoming.length.toLocaleString('ar-IQ')}</span></div>${renderRows(result.upcoming)}</section>`;
    $$('[data-reminder-edit]', target).forEach(button => button.addEventListener('click', () => {
      const doc = [...result.overdue, ...result.upcoming].find(item => item.id === button.dataset.reminderEdit);
      if (doc) openViewAndEditModal(doc);
    }));
  } catch (error) { target.innerHTML = `<div class="callout">${escapeHtml(error.message)}</div>`; }
}
function renderDocsTable(docs, truncated) {
  const target = $('#docs-result'); if (!target) return;
  if (!docs.length) {
    const hasFilters = hasDocumentFilters();
    const emptyHint = !hasFilters ? 'أضف أول كتاب أو معاملة حتى يظهر السجل.' : state.searchMode === 'number-exact' ? 'ما لقينا رقم كتاب مطابق تماماً. جرّب «تلقائي» أو «كل الحقول» إذا تريد نتائج أوسع.' : 'جرّب تخفف شروط البحث أو تغيّر نطاق البحث.';
    target.innerHTML = `<div class="empty-state"><div class="empty-graphic">▤</div><strong>ماكو وثائق هنا حالياً</strong><p>${emptyHint}</p></div>`; return;
  }
  const rows = docs.map(d => `<tr><td><div class="doc-title-cell"><span class="file-icon">${escapeHtml((d.file_original.split('.').pop() || 'FILE').slice(0,4).toUpperCase())}</span><div><div class="doc-name" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</div><div class="doc-sub"><b class="archive-number">${escapeHtml(d.archive_no || '—')}</b> · ${escapeHtml(d.department || 'بدون قسم')}${d.due_date ? ` · متابعة ${dateLabel(d.due_date)}` : ''}${d.related_count ? ` · مرتبط بـ ${Number(d.related_count).toLocaleString('ar-IQ')} كتاب` : ''}</div></div></div></td><td><span class="doc-number">${escapeHtml(d.doc_number)}</span></td><td>${dateLabel(d.doc_date)}</td><td>${typeBadge(d.doc_type)}</td><td><div class="party-cell"><span>من: ${escapeHtml(d.sender || '—')}</span><span>إلى: ${escapeHtml(d.recipient || '—')}</span></div></td><td><div class="row-actions"><button class="button button-primary button-small" data-view-edit="${escapeHtml(d.id)}" type="button">${can('documents.edit') ? 'عرض وتعديل' : 'عرض الملف'}</button><button class="button button-quiet button-small${Number(d.related_count) > 0 ? ' relation-action-linked' : ''}"${Number(d.related_count) > 0 ? ' title="هذا الكتاب مربوط بكتب أخرى"' : ''} data-relations="${escapeHtml(d.id)}" type="button"><span class="relation-action-label">ربط الكتب</span>${Number(d.related_count) > 0 ? ` (${Number(d.related_count).toLocaleString('ar-IQ')})` : ''}</button><button class="button button-quiet button-small" data-activity="${escapeHtml(d.id)}" type="button">سجل المتابعة</button>${can('documents.delete') ? `<button class="button button-quiet button-small" data-trash-doc="${escapeHtml(d.id)}" type="button">نقل إلى السلة</button>` : ''}</div></td></tr>`).join('');
  target.innerHTML = `<div class="table-wrap"><table class="docs-table"><thead><tr><th>عنوان / موضوع</th><th>الرقم</th><th>التاريخ</th><th>النوع</th><th>الجهات</th><th>إجراء</th></tr></thead><tbody>${rows}</tbody></table></div><div class="table-foot"><span>${docs.length.toLocaleString('ar-IQ')} وثيقة${truncated ? ' — النتائج محدودة بـ500، استخدم الفلاتر لتضييق البحث' : ''}</span><span>رقم الأرشيف المتسلسل ظاهر تحت عنوان كل وثيقة. «عرض وتعديل» يعرض الملف والبيانات والطباعة والتنزيل والحفظ.</span></div>`;
  $$('[data-view-edit]', target).forEach(button => button.addEventListener('click', () => openViewAndEditModal(state.docs.find(d => d.id === button.dataset.viewEdit))));
  $$('[data-relations]', target).forEach(button => button.addEventListener('click', () => openRelationsModal(state.docs.find(d => d.id === button.dataset.relations))));

  $$('[data-activity]', target).forEach(button => button.addEventListener('click', () => openDocumentActivityModal(state.docs.find(d => d.id === button.dataset.activity))));
  $$('[data-trash-doc]', target).forEach(button => button.addEventListener('click', async () => {
    const doc = state.docs.find(d => d.id === button.dataset.trashDoc); if (!doc) return;
    if (!confirm(`ننقل «${doc.title}» إلى سلة المحذوفات؟ تقدر ترجعه من السلة لاحقاً.`)) return;
    button.disabled = true;
    try { await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' }); showToast('تم نقل الوثيقة إلى سلة المحذوفات.'); await renderDocuments(); }
    catch (error) { button.disabled = false; showToast(error.message, 'error'); }
  }));
}
async function renderTrash() {
  if (!can('trash.manage')) { state.page = 'documents'; return renderDocuments(); }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">استرجاع الوثائق المحذوفة</p><h1>سلة المحذوفات</h1><p class="page-subtitle">الوثائق هنا مخفية من الأرشيف وتبقى ملفاتها محفوظة إلى أن تختار الحذف النهائي.</p></div><button class="button button-quiet" id="refresh-trash" type="button">↻ تحديث</button></div><section class="panel"><div id="trash-result" class="table-wrap"><div class="empty-state">جارٍ تحميل سلة المحذوفات…</div></div></section>`;
  $('#refresh-trash').addEventListener('click', renderTrash);
  try {
    const result = await api('/api/trash'); const docs = result.documents || []; const target = $('#trash-result');
    if (!docs.length) {
      target.innerHTML = `<div class="empty-state"><div class="empty-graphic">▤</div><strong>سلة المحذوفات فارغة</strong><p>أي وثيقة تنقلها إلى السلة راح تظهر هنا وتقدر ترجعها.</p></div>`; return;
    }
    const rows = docs.map(doc => {
      const deletedAt = doc.deleted_at ? new Intl.DateTimeFormat('ar-IQ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(doc.deleted_at)) : '—';
      return `<tr><td><div class="doc-name">${escapeHtml(doc.title)}</div><div class="doc-sub">${escapeHtml(doc.archive_no || '—')} · ${escapeHtml(doc.file_original)}</div></td><td><span class="doc-number">${escapeHtml(doc.doc_number)}</span></td><td>${dateLabel(doc.doc_date)}</td><td>${escapeHtml(deletedAt)}</td><td><div class="row-actions"><button class="button button-quiet button-small" data-trash-view="${escapeHtml(doc.id)}" type="button">عرض الملف</button><button class="button button-primary button-small" data-trash-restore="${escapeHtml(doc.id)}" type="button">استرجاع</button><button class="button button-danger button-small" data-trash-delete="${escapeHtml(doc.id)}" type="button">حذف نهائي</button></div></td></tr>`;
    }).join('');
    target.innerHTML = `<table class="docs-table trash-table"><thead><tr><th>عنوان الوثيقة</th><th>رقم الكتاب</th><th>تاريخ الكتاب</th><th>تاريخ الحذف</th><th>الإجراء</th></tr></thead><tbody>${rows}</tbody></table><div class="table-foot"><span>${docs.length.toLocaleString('ar-IQ')} وثيقة${result.truncated ? ' — المعروض أول 1000 وثيقة' : ''}</span><span>الحذف النهائي يمسح الوثيقة وملفها نهائياً.</span></div>`;
    $$('[data-trash-view]', target).forEach(button => button.addEventListener('click', () => openSavedFileViewer(docs.find(doc => doc.id === button.dataset.trashView))));
    $$('[data-trash-restore]', target).forEach(button => button.addEventListener('click', async () => {
      const doc = docs.find(item => item.id === button.dataset.trashRestore); if (!doc) return;
      button.disabled = true;
      try { await api(`/api/trash/${encodeURIComponent(doc.id)}/restore`, { method: 'POST' }); showToast('تم استرجاع الوثيقة إلى الأرشيف.'); await renderTrash(); }
      catch (error) { button.disabled = false; showToast(error.message, 'error'); }
    }));
    $$('[data-trash-delete]', target).forEach(button => button.addEventListener('click', async () => {
      const doc = docs.find(item => item.id === button.dataset.trashDelete); if (!doc) return;
      if (!confirm(`حذف نهائي: «${doc.title}»؟ راح ينحذف ملف الوثيقة وسجل ارتباطاتها وما تقدر تسترجعه من البرنامج.`)) return;
      button.disabled = true;
      try {
        const deleted = await api(`/api/trash/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
        showToast(deleted.fileCleanupPending ? 'حُذفت الوثيقة، لكن تعذر حذف ملفها المؤقت. راجع مسؤول النظام.' : 'تم حذف الوثيقة وملفها نهائياً.');
        await renderTrash();
      } catch (error) { button.disabled = false; showToast(error.message, 'error'); }
    }));
  } catch (error) { $('#trash-result').innerHTML = `<div class="callout">${escapeHtml(error.message)}</div>`; }
}
async function openDocumentActivityModal(doc) {
  if (!doc || !can('documents.view')) return;
  try {
    const result = await api(`/api/documents/${encodeURIComponent(doc.id)}/activity`);
    const events = result.events.length ? `<div class="activity-timeline">${result.events.map(item => `<article class="activity-item"><div class="activity-item-head"><strong>${escapeHtml(item.event)}</strong><small>${new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium',timeStyle:'short'}).format(new Date(item.created_at))}</small></div><p>${escapeHtml(item.details || '—')}</p><small>${escapeHtml(item.full_name || 'النظام')}</small></article>`).join('')}</div>` : '<div class="relation-empty">ماكو متابعات مسجلة لهذا الكتاب بعد.</div>';
    const body = `<div class="activity-intro"><strong>${escapeHtml(doc.archive_no || '')} · ${escapeHtml(doc.doc_number)} — ${escapeHtml(doc.title)}</strong><small>سجّل الاتصالات والإجراءات والنتائج المهمة للمعاملة.</small></div><form id="activity-form" class="activity-form"><label for="activity-details">إضافة متابعة جديدة</label><textarea id="activity-details" maxlength="3000" required placeholder="مثال: تمت مراجعة القسم المالي، والرد متوقع يوم الأحد"></textarea><button class="button button-primary" type="submit">حفظ المتابعة</button></form><h3 class="relation-selected-title">سجل المتابعة <span>(${result.events.length.toLocaleString('ar-IQ')})</span></h3>${events}`;
    modal('سجل متابعة الكتاب', 'كل خطوة على المعاملة محفوظة مع اسم المستخدم والوقت.', body);
    if (!can('documents.followup')) $('#activity-form').remove();
    $('#activity-form')?.addEventListener('submit', async event => {
      if (!can('documents.followup')) return;
      event.preventDefault(); const button = $('button[type=submit]', event.currentTarget); button.disabled = true;
      try {
        await api(`/api/documents/${encodeURIComponent(doc.id)}/activity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ details: $('#activity-details').value }) });
        showToast('تم تسجيل المتابعة.'); await openDocumentActivityModal(doc);
      } catch (error) { button.disabled = false; showToast(error.message, 'error'); }
    });
  } catch (error) { showToast(error.message, 'error'); }
}
async function openRelationsModal(doc) {
  if (!doc || !can('documents.view')) return;
  try {
    const initial = await api(`/api/documents/${encodeURIComponent(doc.id)}/relations`);
    const selected = new Map(initial.related.map(item => [item.id, item]));
    if (!can('documents.relate')) {
      const body = `<h3 class="relation-selected-title">الكتب المرتبطة حالياً (${selected.size.toLocaleString('ar-IQ')})</h3><div class="relation-selected">${selected.size ? [...selected.values()].map(item => `<div class="relation-chip"><button class="relation-preview-link" type="button" data-preview-related="${escapeHtml(item.id)}"><strong>${escapeHtml(item.doc_number)}</strong> · ${escapeHtml(item.title)}<small>اضغط لمعاينة الكتاب</small></button></div>`).join('') : '<div class="relation-empty">ماكو كتب مرتبطة حالياً.</div>'}</div><section id="relation-preview" class="relation-inline-preview hidden"></section><div class="modal-actions"><button class="button button-quiet" data-close-modal type="button">إغلاق</button></div>`;
      modal('الكتب المرتبطة', `الوثيقة: ${doc.doc_number} — ${doc.title}`, body);
      $$('[data-preview-related]').forEach(button => button.addEventListener('click', () => showRelationPreview(selected.get(button.dataset.previewRelated))));
      return;
    }
    const body = `<div class="relation-search"><label for="relations-search">ابحث عن كتاب برقم الكتاب أو عنوانه</label><input id="relations-search" type="search" placeholder="اكتب الرقم أو جزءاً من العنوان"><small>اختر كتاباً واربطه بهذه الوثيقة. لمعاينته اضغط «معاينة»؛ الربط يظهر من الجهتين.</small></div><div id="relations-results" class="relation-results"></div><h3 class="relation-selected-title">الكتب المرتبطة حالياً <span id="relations-count"></span></h3><div id="relations-selected" class="relation-selected"></div><section id="relation-preview" class="relation-inline-preview hidden"></section><div class="modal-actions"><button class="button button-primary" id="save-relations" type="button">حفظ الربط</button><button class="button button-quiet" data-close-modal type="button">إلغاء</button></div>`;
    modal('ربط الكتب والمعاملات', `الوثيقة: ${doc.doc_number} — ${doc.title}`, body);
    const selectedTarget = $('#relations-selected'); const resultsTarget = $('#relations-results');
    const renderSelected = () => {
      $('#relations-count').textContent = `(${selected.size.toLocaleString('ar-IQ')})`;
      selectedTarget.innerHTML = selected.size ? [...selected.values()].map(item => `<div class="relation-chip"><button class="relation-preview-link" type="button" data-preview-related="${escapeHtml(item.id)}"><strong>${escapeHtml(item.doc_number)}</strong> · ${escapeHtml(item.title)}<small>اضغط لمعاينة الكتاب</small></button><button type="button" data-remove-relation="${escapeHtml(item.id)}" aria-label="إزالة الربط">×</button></div>`).join('') : '<div class="relation-empty">ماكو كتب مرتبطة حالياً.</div>';
      $$('[data-remove-relation]', selectedTarget).forEach(button => button.addEventListener('click', () => { selected.delete(button.dataset.removeRelation); renderSelected(); renderCandidates($('#relations-search').value); }));
      $$('[data-preview-related]', selectedTarget).forEach(button => button.addEventListener('click', () => showRelationPreview(selected.get(button.dataset.previewRelated))));
    };
    async function renderCandidates(query) {
      try {
        const result = await api(`/api/documents/lookup?exclude=${encodeURIComponent(doc.id)}&q=${encodeURIComponent(query)}`);
        resultsTarget.innerHTML = result.documents.length ? result.documents.map(item => `<div class="relation-option"><label class="relation-option-main"><input type="checkbox" data-relation-option="${escapeHtml(item.id)}" ${selected.has(item.id) ? 'checked' : ''}><span><strong>${escapeHtml(item.doc_number)}</strong><span>${escapeHtml(item.title)}</span><small>${dateLabel(item.doc_date)} · ${typeName(item.doc_type)}</small></span></label><button class="button button-quiet button-small" type="button" data-preview-candidate="${escapeHtml(item.id)}">معاينة</button></div>`).join('') : '<div class="relation-empty">ما لقينا كتب مطابقة. تأكد أن الكتاب مضاف للأرشيف أولاً.</div>';
        $$('[data-relation-option]', resultsTarget).forEach(input => input.addEventListener('change', () => {
          const item = result.documents.find(candidate => candidate.id === input.dataset.relationOption);
          if (!item) return;
          if (input.checked) selected.set(item.id, item); else selected.delete(item.id);
          renderSelected();
        }));
        $$('[data-preview-candidate]', resultsTarget).forEach(button => button.addEventListener('click', () => {
          const item = result.documents.find(candidate => candidate.id === button.dataset.previewCandidate);
          if (item) showRelationPreview(item);
        }));
      } catch (error) { resultsTarget.innerHTML = `<div class="relation-empty">${escapeHtml(error.message)}</div>`; }
    }
    let searchTimer;
    $('#relations-search').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderCandidates(event.target.value), 220); });
    renderSelected(); await renderCandidates('');
    $('#save-relations').addEventListener('click', async event => {
      if (!can('documents.relate')) return;
      const button = event.currentTarget; button.disabled = true;
      try {
        await api(`/api/documents/${encodeURIComponent(doc.id)}/relations`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ related_ids: [...selected.keys()] }) });
        closeModal(); showToast('تم حفظ الكتب المرتبطة.'); await loadDocuments();
      } catch (error) { button.disabled = false; showToast(error.message, 'error'); }
    });
  } catch (error) { showToast(error.message, 'error'); }
}
async function showRelationPreview(doc) {
  if (!doc) return;
  const panel = $('#relation-preview'); if (!panel) return;
  disposeFilePreview($('#relation-preview-frame'));
  const token = (window.relationPreviewToken || 0) + 1; window.relationPreviewToken = token;
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="relation-preview-heading"><div><strong>${escapeHtml(doc.doc_number)} — ${escapeHtml(doc.title)}</strong><small>${dateLabel(doc.doc_date)} · ${escapeHtml(doc.file_original)}</small></div><a class="button button-quiet button-small" href="/api/files/${encodeURIComponent(doc.id)}">تنزيل</a></div><div class="file-viewer-status" id="relation-preview-status">جارٍ تحميل معاينة الكتاب…</div><iframe class="document-viewer-frame hidden" id="relation-preview-frame" title="معاينة الكتاب المرتبط"></iframe>`;
  if (!/\.(pdf|png|jpe?g)$/i.test(doc.file_original || '')) {
    $('#relation-preview-status').textContent = 'معاينة داخل البرنامج متوفرة لملفات PDF والصور. تگدر تنزّل هذا الملف من الزر أعلاه.';
    return;
  }
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(doc.id)}?view=1`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`تعذر فتح الملف (${response.status}).`);
    const file = await response.blob();
    if (token !== window.relationPreviewToken || !$('#relation-preview-frame')) return;
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) throw new Error('صيغة الملف لا تدعم المعاينة داخل البرنامج.');
    const frame = $('#relation-preview-frame');
    await setFilePreviewFrame(frame, file, file.type, doc.file_original);
    if (token !== window.relationPreviewToken || !frame.isConnected) return;
    $('#relation-preview-status')?.classList.add('hidden');
  } catch (error) {
    if (token !== window.relationPreviewToken || error.name === 'AbortError') return;
    const status = $('#relation-preview-status'); if (status) status.textContent = `${error.message} تگدر تنزّله من الزر أعلاه.`;
  }
}
async function openSavedFileViewer(doc) {
  if (!doc) return;
  const token = (window.savedViewerToken || 0) + 1; window.savedViewerToken = token;
  const canPreview = /\.(pdf|png|jpe?g)$/i.test(doc.file_original || '');
  const body = `<div class="file-viewer-status" id="saved-file-status">جارٍ تحميل المعاينة…</div><iframe class="document-viewer-frame hidden" id="saved-file-frame" title="معاينة ${escapeHtml(doc.file_original)}"></iframe><div class="modal-actions viewer-actions">${canPreview ? `<button class="button button-primary" id="print-saved-file" type="button" disabled>طباعة</button>` : ''}<a class="button button-quiet" href="/api/files/${encodeURIComponent(doc.id)}">تنزيل نسخة</a><button class="button button-quiet" type="button" data-close-modal>إغلاق</button></div>`;
  modal(doc.title, doc.file_original, body);
  $('.modal').classList.add('modal-wide');
  const frame = $('#saved-file-frame'); const printButton = $('#print-saved-file');
  if (!canPreview) {
    $('#saved-file-status').textContent = 'المعاينة داخل البرنامج متوفرة لملفات PDF والصور. نزّل هذا الملف من الزر أدناه لفتحه.';
    return;
  }
  printButton.addEventListener('click', () => printFrame(frame));
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(doc.id)}?view=1`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`تعذر فتح الملف (${response.status}).`);
    const file = await response.blob();
    if (token !== window.savedViewerToken) return;
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) throw new Error('صيغة الملف لا تدعم المعاينة داخل البرنامج.');
    await setFilePreviewFrame(frame, file, file.type, doc.file_original);
    if (token !== window.savedViewerToken || !frame.isConnected) return;
    printButton.disabled = false; $('#saved-file-status')?.classList.add('hidden');
  } catch (error) {
    if (token !== window.savedViewerToken || error.name === 'AbortError') return;
    const status = $('#saved-file-status'); if (status) status.textContent = `${error.message} تگدر تنزّله من الزر أدناه.`;
  }
}
async function openViewAndEditModal(doc) {
  if (!doc || !can('documents.view')) return;
  openDocumentModal(doc);
  const modalElement = $('.modal');
  const layout = $('.archive-entry-layout');
  if (!modalElement || !layout) return;
  modalElement.classList.add('archive-entry-modal', 'modal-wide');
  $('.modal-head h2').textContent = can('documents.edit') ? 'عرض وتعديل الوثيقة' : 'عرض الوثيقة';
  $('.modal-head p').textContent = can('documents.edit') ? 'عاين الكتاب أو اطبعه أو نزّله، وعدّل بياناته واحفظها من النافذة نفسها.' : 'عاين الكتاب وبياناته أو اطبعه أو نزّله.';
  $('button[data-close-modal]', $('#doc-form')).textContent = 'إغلاق';

  const canPreview = /\.(pdf|png|jpe?g)$/i.test(doc.file_original || '');
  const preview = `<section class="local-preview archive-file-preview combined-file-preview"><div class="local-preview-head"><div><strong>عرض الملف</strong><small>${escapeHtml(doc.file_original)}</small></div><div class="viewer-actions">${canPreview ? '<button class="button button-primary button-small" id="combined-print-file" type="button" disabled>طباعة</button>' : ''}<a class="button button-quiet button-small" href="/api/files/${encodeURIComponent(doc.id)}">تنزيل نسخة</a></div></div><div class="file-viewer-status" id="combined-file-status">جارٍ تحميل المعاينة…</div><iframe class="document-viewer-frame hidden" id="combined-file-frame" title="معاينة ${escapeHtml(doc.file_original)}"></iframe></section>`;
  layout.insertAdjacentHTML('afterbegin', preview);
  if (!canPreview) {
    $('#combined-file-status').textContent = 'المعاينة داخل البرنامج متوفرة لملفات PDF والصور. نزّل هذا الملف من الزر أعلاه لفتحه.';
    return;
  }

  const token = (window.savedViewerToken || 0) + 1;
  window.savedViewerToken = token;
  const frame = $('#combined-file-frame');
  const printButton = $('#combined-print-file');
  printButton.addEventListener('click', () => printFrame(frame));
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(doc.id)}?view=1`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`تعذر فتح الملف (${response.status}).`);
    const file = await response.blob();
    if (token !== window.savedViewerToken || !$('#combined-file-frame')) return;
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) throw new Error('صيغة الملف لا تدعم المعاينة داخل البرنامج.');
    await setFilePreviewFrame(frame, file, file.type, doc.file_original);
    if (token !== window.savedViewerToken || !frame.isConnected) return;
    printButton.disabled = false;
    $('#combined-file-status')?.classList.add('hidden');
  } catch (error) {
    if (token !== window.savedViewerToken || error.name === 'AbortError') return;
    const status = $('#combined-file-status'); if (status) status.textContent = `${error.message} تگدر تنزّله من الزر أعلاه.`;
  }
}
const filePreviewSessions = new Map();
let filePreviewSequence = 0;
function disposeFilePreview(frame) {
  if (frame) filePreviewSessions.get(frame)?.dispose();
}
function disposeAllFilePreviews() {
  for (const session of [...filePreviewSessions.values()]) session.dispose();
}
function setFilePreviewFrame(frame, file, type, title) {
  disposeFilePreview(frame);
  if (!file || typeof file.arrayBuffer !== 'function') return Promise.reject(new Error('تعذر قراءة الملف للمعاينة.'));
  const id = `preview-${Date.now()}-${++filePreviewSequence}`;
  const origin = window.location.origin;
  let settled = false; let opened = false; let loaded = false; let disposed = false; let printPending = null;
  let resolveReady; let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const abortError = () => new DOMException('تم إغلاق المعاينة.', 'AbortError');
  const send = (message, transfer = []) => frame.contentWindow.postMessage({ channel: 'arsheefna-file-viewer', id, ...message }, origin, transfer);
  const session = {
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timeout); window.removeEventListener('message', onMessage);
      try { send({ action: 'dispose' }); } catch {}
      if (!settled) { settled = true; rejectReady(abortError()); }
      if (printPending) { printPending.reject(abortError()); printPending = null; }
      filePreviewSessions.delete(frame);
    },
    print() {
      if (disposed || !frame.isConnected) return Promise.reject(abortError());
      if (!loaded) return Promise.reject(new Error('انتظر حتى يكتمل تحميل معاينة الكتاب.'));
      if (printPending) return printPending.promise;
      const requestId = `print-${++filePreviewSequence}`;
      let resolve; let reject;
      const promise = new Promise((resolvePrint, rejectPrint) => { resolve = resolvePrint; reject = rejectPrint; });
      printPending = { requestId, promise, resolve, reject };
      try { send({ action: 'print', requestId }); } catch (error) { printPending = null; reject(error); }
      return promise;
    }
  };
  async function onMessage(event) {
    if (disposed || event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = event.data;
    if (!message || message.channel !== 'arsheefna-file-viewer') return;
    if (message.action === 'ready' && !opened) {
      opened = true;
      try {
        const bytes = await file.arrayBuffer();
        if (disposed || !frame.isConnected) { session.dispose(); return; }
        send({ action: 'open', mime: type, title, bytes }, [bytes]);
      } catch (error) {
        if (!settled) { settled = true; clearTimeout(timeout); rejectReady(error); }
      }
      return;
    }
    if (message.id !== id) return;
    if (message.action === 'loaded' && !settled) {
      loaded = true; settled = true; clearTimeout(timeout); resolveReady({ pageCount: message.pageCount });
    } else if (message.action === 'error') {
      loaded = false;
      const error = new Error(message.message || 'تعذر عرض الملف.');
      if (!settled) { settled = true; clearTimeout(timeout); rejectReady(error); }
      if (printPending) { printPending.reject(error); printPending = null; }
    } else if (printPending && message.requestId === printPending.requestId) {
      if (message.action === 'printed') { printPending.resolve(); printPending = null; }
      else if (message.action === 'print-error') { printPending.reject(new Error(message.message || 'تعذر تجهيز صفحات الطباعة.')); printPending = null; }
    }
  }
  const timeout = setTimeout(() => {
    if (!settled) { settled = true; rejectReady(new Error('تعذر تشغيل عارض الملفات. أعد فتح المعاينة وتأكد من تحديث المتصفح.')); session.dispose(); }
  }, 90000);
  filePreviewSessions.set(frame, session);
  window.addEventListener('message', onMessage);
  frame.classList.remove('hidden');
  frame.removeAttribute('srcdoc'); frame.src = '/file-viewer.html';
  return ready;
}
async function printFrame(frame) {
  try {
    const session = filePreviewSessions.get(frame);
    if (!session) throw new Error('أعد فتح معاينة الكتاب قبل الطباعة.');
    await session.print();
  } catch (error) { if (error.name !== 'AbortError') showToast(error.message || 'تعذر فتح الطباعة لهذا الملف.', 'error'); }
}
function normalizeOcrDigits(value) {
  return String(value || '').replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}
function ocrSuggestions(text) {
  const lines = normalizeOcrDigits(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const dateMatch = normalizeOcrDigits(text).match(/(\d{1,4})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{1,4})/);
  let docDate = '';
  if (dateMatch) {
    const first = dateMatch[1]; const second = dateMatch[2]; const third = dateMatch[3];
    const year = Number(first.length === 4 ? first : third.length === 4 ? third : '0');
    const month = Number(second); const day = Number(first.length === 4 ? third : first);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (year >= 1900 && year <= 2200 && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) docDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  let docNumber = '';
  const numberLine = lines.find(line => /(?:العدد|رقم(?:\s+الكتاب)?|رقم الكتاب|number)/i.test(line));
  const numberMatch = numberLine?.match(/(?:العدد|رقم(?:\s+الكتاب)?|رقم الكتاب|number)\s*(?:[:：/#-]\s*)?([0-9][0-9/\\\-_. ]{0,28})/i);
  if (numberMatch) docNumber = numberMatch[1].trim().replace(/[\s.]+$/g, '').replace(/\s+/g, ' ');
  const subjectLine = lines.find(line => /(?:الموضوع|موضوع الكتاب)/.test(line));
  let title = subjectLine ? subjectLine.replace(/^.*?(?:الموضوع|موضوع الكتاب)\s*[:：\-]?\s*/, '').trim() : '';
  if (!title) title = lines.find(line => line.length >= 8 && !/^(بسم الله|جمهورية العراق|وزارة|إلى|من|السلام عليكم)/.test(line)) || '';
  return { title: title.slice(0, 300), docNumber: docNumber.slice(0, 100), docDate };
}
async function recognizeDocumentText(file, onProgress) {
  if (!window.Tesseract?.createWorker) throw new Error('محرك قراءة النص غير جاهز. أعد فتح البرنامج.');
  const isPdf = /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
  if (!isPdf && !/\.(png|jpe?g)$/i.test(file.name || '') && !/^image\/(png|jpeg)$/i.test(file.type || '')) throw new Error('قراءة النص متوفرة حالياً لملفات PDF والصور فقط.');
  const worker = await window.Tesseract.createWorker('ara+eng', 1, {
    workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr/lang', workerBlobURL: true, gzip: true,
    logger: info => { if (info.status) onProgress(`${info.status}${Number.isFinite(info.progress) ? ` ${Math.round(info.progress * 100)}٪` : ''}`); }
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: '1' });
    let input = file;
    if (isPdf) {
      onProgress('جارٍ فتح ملف PDF…');
      const pdfjs = await import('/ocr/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/ocr/pdf.worker.min.mjs';
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true }).promise;
      const pageCount = pdf.numPages;
      if (pageCount > 200) { await pdf.destroy(); throw new Error('الملف يحتوي أكثر من ٢٠٠ صفحة. تم إبقاء الكتاب كاملاً للمعاينة والأرشفة، لكن القراءة الآلية تدعم حتى ٢٠٠ صفحة في المرة الواحدة.'); }
      const pagesText = [];
      try {
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          onProgress(`جارٍ قراءة صفحة ${pageNumber.toLocaleString('ar-IQ')} من ${pageCount.toLocaleString('ar-IQ')}…`);
          const page = await pdf.getPage(pageNumber); const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d', { alpha: false }); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
          const result = await worker.recognize(canvas);
          pagesText.push(`صفحة ${pageNumber}\n${result.data.text || ''}`);
          canvas.width = 0; canvas.height = 0; page.cleanup();
        }
      } finally { await pdf.destroy(); }
      return { text: pagesText.join('\n\n'), pageCount };
    }
    const result = await worker.recognize(input);
    return { text: result.data.text || '', pageCount: 1 };
  } finally { await worker.terminate(); }
}
async function scannedJpegsToPdf(imageBlobs) {
  const encoder = new TextEncoder(); const images = [];
  for (const blob of imageBlobs) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: false }); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0); bitmap.close();
    const jpegBlob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('تعذر تحويل المسح إلى PDF.')), 'image/jpeg', 0.86));
    const pageScale = Math.min(595 / canvas.width, 842 / canvas.height);
    images.push({ width: canvas.width, height: canvas.height, pageWidth: canvas.width * pageScale, pageHeight: canvas.height * pageScale, bytes: new Uint8Array(await jpegBlob.arrayBuffer()) });
  }
  const chunks = []; const offsets = []; let length = 0;
  const push = value => { const bytes = typeof value === 'string' ? encoder.encode(value) : value; chunks.push(bytes); length += bytes.length; };
  const object = (id, value) => { offsets[id] = length; push(`${id} 0 obj\n${value}\nendobj\n`); };
  push('%PDF-1.4\n%Arsheefna\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${images.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] /Count ${images.length} >>`);
  images.forEach((image, index) => {
    const pageId = 3 + index * 3; const imageId = pageId + 1; const contentId = pageId + 2;
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.pageWidth.toFixed(2)} ${image.pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    offsets[imageId] = length; push(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`); push(image.bytes); push('\nendstream\nendobj\n');
    const content = `q\n${image.pageWidth.toFixed(2)} 0 0 ${image.pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    object(contentId, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`);
  });
  const xref = length; push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let index = 1; index < offsets.length; index += 1) push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}
async function imageToArchiveJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const jpeg = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('تعذر تجهيز إحدى الصور.')), 'image/jpeg', 0.88));
  canvas.width = 0; canvas.height = 0;
  return jpeg;
}
async function multipleArchiveFilesToPdf(files, onProgress = () => {}) {
  const maxUploadBytes = 50 * 1024 * 1024;
  const maxSourceBytes = 200 * 1024 * 1024;
  const maxPages = 200;
  if (files.length < 2) throw new Error('اختار ملفين أو أكثر للدمج.');
  if (files.reduce((sum, file) => sum + file.size, 0) > maxSourceBytes) throw new Error('حجم الملفات المختارة كبير جداً. اختار ملفات مجموعها أقل من 200 ميغابايت.');
  const pdfjs = await import('/ocr/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/ocr/pdf.worker.min.mjs';
  const pageImages = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (/\.(png|jpe?g)$/i.test(file.name)) {
      onProgress(`جارٍ تجهيز الصورة ${fileIndex + 1} من ${files.length}…`);
      pageImages.push(await imageToArchiveJpeg(file));
      continue;
    }
    if (!/\.pdf$/i.test(file.name)) throw new Error('عند اختيار أكثر من ملف، الصيغ المدعومة هي الصور JPG وPNG وملفات PDF فقط.');
    onProgress(`جارٍ فتح ${file.name}…`);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true }).promise;
    try {
      if (pageImages.length + pdf.numPages > maxPages) throw new Error('الملفات تتجاوز 200 صفحة. قسّمها إلى أكثر من عملية أرشفة.');
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        onProgress(`جارٍ تجهيز ${file.name} — صفحة ${pageNumber} من ${pdf.numPages}…`);
        const page = await pdf.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2.25, 1800 / Math.max(baseViewport.width, baseViewport.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, background: '#fff' }).promise;
        const jpeg = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error(`تعذر تجهيز صفحة ${pageNumber} من ${file.name}.`)), 'image/jpeg', 0.88));
        pageImages.push(jpeg);
        canvas.width = 0; canvas.height = 0; page.cleanup();
      }
    } finally { await pdf.destroy(); }
  }
  const output = await scannedJpegsToPdf(pageImages);
  if (output.size > maxUploadBytes) throw new Error('حجم الملف الناتج أكبر من 50 ميغابايت. قلّل عدد الملفات أو الصفحات.');
  return { file: output, pageCount: pageImages.length };
}
function openDocumentModal(doc = null) {
  const editing = Boolean(doc);
  if (!(editing ? can('documents.view') : can('documents.create'))) { showToast('ما عندك صلاحية لهذا الإجراء.', 'error'); return; }
  const today = new Date().toISOString().slice(0, 10);
  if (!editing) { window.scannedArchiveFile = null; window.scannedPages = []; window.scannedDeviceId = ''; window.archiveFileSelectionError = false; window.archiveFilesPreparing = false; window.archiveFileSelectionToken = (window.archiveFileSelectionToken || 0) + 1; }
  const body = `<form id="doc-form"><div class="archive-entry-layout ${editing ? 'editing' : ''}">${editing ? '' : `<section class="local-preview archive-file-preview hidden" id="local-preview"><div class="local-preview-head"><div><strong>معاينة الكتاب</strong><small>عاين الملف وتأكد من البيانات قبل الحفظ.</small></div><button class="button button-quiet button-small hidden" id="print-local-file" type="button">طباعة</button></div><div id="local-preview-body"></div></section>`}<div class="archive-entry-fields"><div class="form-grid">${field('عنوان الوثيقة / الموضوع','title',{value:doc?.title || '',required:true,max:300,full:true,placeholder:'مثال: طلب تجهيز مواد مكتبية'})}${field('رقم الكتاب أو المعاملة','doc_number',{value:doc?.doc_number || '',required:true,max:100,placeholder:'مثال: ١٢٣/م'})}${field('التاريخ','doc_date',{type:'date',value:doc?.doc_date || today,required:true})}${field('موعد المتابعة','due_date',{type:'date',value:doc?.due_date || '',help:'اختياري — يظهر في صفحة مواعيد المتابعة إذا لم تكن المعاملة منجزة.'})}${field('نوع الوثيقة','doc_type',{value:doc?.doc_type || 'incoming',required:true,options:[{value:'incoming',label:'كتب واردنا'},{value:'external_incoming',label:'وارد خارجي'},{value:'outgoing',label:'كتاب صادر'}]})}${field('التصنيف','category',{value:doc?.category || 'عام',required:true,options:categoryOptions.map(category => ({value:category,label:category}))})}${field('حالة المعاملة','status',{value:doc?.status || 'new',required:true,options:[{value:'new',label:'جديدة'},{value:'in_progress',label:'قيد الإنجاز'},{value:'completed',label:'منجزة'}]})}${field('الجهة المرسلة','sender',{value:doc?.sender || '',max:160,placeholder:'الوزارة أو الجهة المرسلة'})}${field('الجهة المستلمة','recipient',{value:doc?.recipient || '',max:160,placeholder:'القسم أو الجهة المستلمة'})}${field('القسم','department',{value:doc?.department || '',max:120,placeholder:'مثال: شعبة الحسابات'})}${editing ? '' : field('ملفات الوثيقة','file',{type:'file',required:false,full:true,accept:'.pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx',help:'يمكن اختيار عدة صور أو ملفات PDF؛ تُجمع بالتسلسل في ملف واحد.'})}${field('ملاحظات','notes',{type:'textarea',value:doc?.notes || '',max:3000,full:true,placeholder:'ملاحظات داخلية اختيارية'})}</div>${editing ? '' : `<div class="archive-tools"><div class="archive-tool-buttons"><button class="button button-quiet button-small" id="scan-document" type="button">مسح الصفحة الأولى</button><select id="scanner-select" class="hidden" aria-label="اختيار الماسح الضوئي"></select><button class="button button-quiet button-small hidden" id="start-scan" type="button">ابدأ المسح</button><button class="button button-quiet button-small" id="extract-metadata" type="button" disabled>قراءة بيانات الكتاب آلياً</button></div><small id="archive-tool-status">المسح يضيف صفحات كاملة إلى PDF. إذا كان الماسح مسطحاً، ضَع كل صفحة على الزجاج ثم أضف الصفحة التالية. القراءة الآلية تقترح العنوان والرقم والتاريخ فقط؛ الملف الكامل يبقى للمعاينة والأرشفة.</small><div id="ocr-results" class="ocr-results hidden"></div></div>`}<div class="file-picked" id="file-picked">${editing ? `الملف الحالي: ${escapeHtml(doc.file_original)}` : ''}</div></div></div><div class="modal-actions"><button class="button button-primary" type="submit">${editing ? 'حفظ التعديلات' : 'حفظ للأرشيف'}</button><button class="button button-quiet" type="button" data-close-modal>إلغاء</button></div></form>`;
  modal(editing ? 'تعديل بيانات الوثيقة' : 'إضافة وثيقة جديدة', editing ? 'حدّث المعلومات الأساسية للوثيقة.' : 'عاين الملف أولاً؛ ينضاف للأرشيف فقط بعد ضغط «حفظ للأرشيف».', body);
  if (!editing) $('.modal').classList.add('archive-entry-modal');
  const form = $('#doc-form');
  if (editing && !can('documents.edit')) {
    $$('input, textarea, select', form).forEach(control => { control.disabled = true; });
    $('button[type=submit]', form).classList.add('hidden');
  }
  if (editing) $('.form-grid', form).insertAdjacentHTML('beforeend', `<div class="field"><label for="document-created-by">أُضيفت بواسطة</label><input id="document-created-by" type="text" value="${escapeHtml(doc.created_by_name || '—')}" readonly aria-readonly="true"></div>`);
  if (!editing) $('#f-file')?.setAttribute('multiple', 'multiple');
  const showSelectedFile = file => {
    disposeFilePreview($('#local-file-frame'));
    $('#file-picked').textContent = file ? file.name : '';
    const preview = $('#local-preview'); const previewBody = $('#local-preview-body'); const printButton = $('#print-local-file');
    if (!file || !preview) { preview?.classList.add('hidden'); return; }
    preview.classList.remove('hidden');
    if (/\.(pdf|png|jpe?g)$/i.test(file.name)) {
      previewBody.innerHTML = `<iframe class="document-viewer-frame" id="local-file-frame" title="معاينة ${escapeHtml(file.name)}"></iframe>`;
      printButton.classList.remove('hidden'); printButton.disabled = true;
      const frame = $('#local-file-frame');
      printButton.onclick = () => printFrame(frame);
      const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : 'application/pdf');
      setFilePreviewFrame(frame, file, mime, file.name).then(() => {
        if (frame.isConnected && $('#local-file-frame') === frame) printButton.disabled = false;
      }).catch(error => {
        if (error.name === 'AbortError' || !frame.isConnected || $('#local-file-frame') !== frame) return;
        printButton.classList.add('hidden');
        previewBody.insertAdjacentHTML('beforeend', `<div class="preview-not-supported">${escapeHtml(error.message)} الملف المختار يبقى جاهزاً للأرشفة.</div>`);
      });
    } else {
      previewBody.innerHTML = '<div class="preview-not-supported">المعاينة المباشرة والطباعة متوفرة لملفات PDF والصور فقط. هذا الملف لم يُحفظ بعد؛ بعد ما تتأكد من اسمه اضغط «حفظ للأرشيف».</div>';
      printButton.classList.add('hidden');
    }
  };
  $('#f-file')?.addEventListener('change', async event => {
    window.scannedArchiveFile = null; window.scannedPages = []; window.scannedDeviceId = '';
    window.archiveFileSelectionError = false; window.archiveFilesPreparing = false;
    const selectionToken = (window.archiveFileSelectionToken || 0) + 1;
    window.archiveFileSelectionToken = selectionToken;
    $('#scan-document').textContent = 'مسح الصفحة الأولى';
    const files = [...event.currentTarget.files];
    $('#ocr-results').classList.add('hidden');
    if (!files.length) {
      showSelectedFile(null); $('#extract-metadata').disabled = true;
      $('#archive-tool-status').textContent = 'قراءة النص تتم على هذا اللابتوب. راجع البيانات المقترحة قبل الحفظ.';
      return;
    }
    if (files.length === 1) {
      showSelectedFile(files[0]); $('#extract-metadata').disabled = false;
      $('#archive-tool-status').textContent = 'الملف جاهز. راجع المعاينة أو اقرأ البيانات آلياً.';
      return;
    }
    const saveButton = $('button[type=submit]', form);
    window.archiveFilesPreparing = true;
    saveButton.disabled = true; $('#extract-metadata').disabled = true;
    $('#file-picked').textContent = `تجهيز ${files.length.toLocaleString('ar-IQ')} ملفات…`;
    $('#archive-tool-status').textContent = 'سيجمع البرنامج الملفات بالترتيب في كتاب PDF واحد.';
    try {
      const combined = await multipleArchiveFilesToPdf(files, status => {
        const target = $('#archive-tool-status'); if (target) target.textContent = status;
      });
      if (selectionToken !== window.archiveFileSelectionToken || !$('#doc-form')) return;
      const file = new File([combined.file], `مرفقات-${new Date().toISOString().slice(0, 10)}.pdf`, { type: 'application/pdf' });
      window.scannedArchiveFile = file;
      showSelectedFile(file);
      $('#file-picked').textContent = `${files.length.toLocaleString('ar-IQ')} ملفات مدمجة — ${combined.pageCount.toLocaleString('ar-IQ')} صفحة`;
      $('#extract-metadata').disabled = false;
      $('#archive-tool-status').textContent = `تم جمع ${files.length.toLocaleString('ar-IQ')} ملفات في PDF واحد من ${combined.pageCount.toLocaleString('ar-IQ')} صفحة. راجع المعاينة ثم احفظ للأرشيف.`;
    } catch (error) {
      if (selectionToken !== window.archiveFileSelectionToken) return;
      window.archiveFileSelectionError = true;
      showSelectedFile(null);
      $('#file-picked').textContent = `تعذر تجهيز ${files.length.toLocaleString('ar-IQ')} ملفات.`;
      $('#archive-tool-status').textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      if (selectionToken === window.archiveFileSelectionToken) {
        window.archiveFilesPreparing = false;
        if ($('#doc-form')) saveButton.disabled = false;
      }
    }
  });
  $('#scan-document')?.addEventListener('click', async event => {
    if ($('#f-file')?.files.length) {
      $('#archive-tool-status').textContent = 'اختار الملفات من الحاسبة أو استخدم الماسح الضوئي في كل مرة، حتى لا تضيع المرفقات.';
      showToast('أفرغ اختيار الملفات إذا تريد استخدام الماسح، أو أعد اختيار كل المرفقات معاً.', 'error');
      return;
    }
    const button = event.currentTarget; button.disabled = true; $('#archive-tool-status').textContent = 'جارٍ البحث عن الماسحات المتصلة…';
    try {
      if (window.scannedPages?.length && window.scannedDeviceId) { await startScannerScan(window.scannedDeviceId); return; }
      const result = await api('/api/scanners'); const select = $('#scanner-select');
      if (!result.scanners.length) { $('#archive-tool-status').textContent = 'ما لقينا ماسحاً ضوئياً. تأكد من توصيله وتشغيل تعريفه.'; return; }
      select.innerHTML = `<option value="">اختار الماسح الضوئي</option>${result.scanners.map(scanner => `<option value="${escapeHtml(scanner.id)}">${escapeHtml(scanner.name)}</option>`).join('')}`;
      if (result.scanners.length === 1) await startScannerScan(result.scanners[0].id);
      else { select.classList.remove('hidden'); $('#start-scan').classList.remove('hidden'); $('#archive-tool-status').textContent = 'اختار الماسح ثم اضغط «ابدأ المسح».'; }
    } catch (error) { const status = $('#archive-tool-status'); if (status) status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#start-scan')?.addEventListener('click', async event => {
    const deviceId = $('#scanner-select').value; if (!deviceId) { $('#archive-tool-status').textContent = 'اختار الماسح الضوئي أولاً.'; return; }
    const button = event.currentTarget; button.disabled = true;
    try { await startScannerScan(deviceId); }
    catch (error) { $('#archive-tool-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  async function startScannerScan(deviceId) {
    const scanButton = $('#scan-document'); const startButton = $('#start-scan');
    scanButton.disabled = true; startButton.disabled = true; $('#archive-tool-status').textContent = 'ضع الصفحة في الماسح وانتظر اكتمال المسح…';
    try {
      const response = await fetch('/api/scanners/scan', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }) });
      if (!response.ok) { let data = {}; try { data = await response.json(); } catch {} throw new Error(data.error || 'تعذر المسح الضوئي.'); }
      const pageImage = await response.blob(); if (!$('#doc-form')) return;
      const candidatePages = [...(window.scannedPages || []), pageImage];
      const pdf = await scannedJpegsToPdf(candidatePages);
      if (!$('#doc-form')) return;
      if (pdf.size > 50 * 1024 * 1024) throw new Error('صار حجم المسح أكبر من 50 ميغابايت. استخدم دقة أقل أو ارفع ملفاً مضغوطاً.');
      window.scannedPages = candidatePages; window.scannedDeviceId = deviceId;
      const file = new File([pdf], `مسح-${new Date().toISOString().slice(0, 10)}.pdf`, { type: 'application/pdf' });
      $('#f-file').value = ''; window.scannedArchiveFile = file; showSelectedFile(file); $('#extract-metadata').disabled = false;
      $('#scanner-select').classList.add('hidden'); startButton.classList.add('hidden');
      $('#ocr-results').classList.add('hidden');
      scanButton.textContent = 'إضافة صفحة للكتاب';
      $('#archive-tool-status').textContent = `تم مسح الصفحة كاملة وإظهارها بالمعاينة (${window.scannedPages.length.toLocaleString('ar-IQ')} صفحة في PDF). ضع الصفحة التالية على الزجاج واضغط «إضافة صفحة للكتاب». الملف الكامل يُحفظ عند ضغط «حفظ للأرشيف».`;
    } finally { scanButton.disabled = false; startButton.disabled = false; }
  }
  $('#extract-metadata')?.addEventListener('click', async event => {
    const file = window.scannedArchiveFile || $('#f-file')?.files[0]; if (!file) return;
    const button = event.currentTarget; button.disabled = true; $('#archive-tool-status').textContent = 'جارٍ تجهيز OCR…'; $('#ocr-results').classList.add('hidden');
    try {
      const result = await recognizeDocumentText(file, status => { if ($('#archive-tool-status')) $('#archive-tool-status').textContent = status; });
      if (!$('#doc-form')) return;
      const text = result.text;
      if (!text.trim()) throw new Error('ما قدر البرنامج يقرأ نصاً واضحاً. جرب صورة أوضح أو اكتب البيانات يدوياً.');
      const suggestions = ocrSuggestions(text);
      if (suggestions.title && !$('#f-title').value) $('#f-title').value = suggestions.title;
      if (suggestions.docNumber && !$('#f-doc_number').value) $('#f-doc_number').value = suggestions.docNumber;
      if (suggestions.docDate && (!$('#f-doc_date').value || $('#f-doc_date').value === today)) $('#f-doc_date').value = suggestions.docDate;
      $('#archive-tool-status').textContent = `قُرئ النص من ${result.pageCount.toLocaleString('ar-IQ')} صفحة. راجع العنوان والرقم والتاريخ المقترحة وصححها قبل الحفظ.`;
      $('#ocr-results').innerHTML = `<details><summary>عرض النص المقروء من كل الصفحات والاقتراحات</summary><p>العنوان: ${escapeHtml(suggestions.title || 'لم يتعرف عليه')}</p><p>الرقم: ${escapeHtml(suggestions.docNumber || 'لم يتعرف عليه')}</p><p>التاريخ: ${escapeHtml(suggestions.docDate || 'لم يتعرف عليه')}</p><pre>${escapeHtml(text.slice(0, 12000))}${text.length > 12000 ? '\n… بقية النص موجودة في الملف المؤرشف.' : ''}</pre></details>`;
      $('#ocr-results').classList.remove('hidden');
    } catch (error) { const status = $('#archive-tool-status'); if (status) status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
    if (!(editing ? can('documents.edit') : can('documents.create'))) { button.disabled = false; showToast('ما عندك صلاحية لحفظ هذا التغيير.', 'error'); return; }
    try {
      if (!editing && window.archiveFilesPreparing) { button.disabled = false; showToast('انتظر حتى يكتمل تجهيز كل الملفات.', 'error'); return; }
      if (editing) {
        const data = Object.fromEntries(new FormData(form));
        const duplicateParams = new URLSearchParams({ number: data.doc_number, year: data.doc_date.slice(0, 4), exclude: doc.id });
        const duplicates = (await api(`/api/documents/duplicate?${duplicateParams}`)).duplicates;
        if (duplicates.length && !confirm(`يوجد كتاب آخر بنفس الرقم والسنة: ${duplicates.map(item => `${item.doc_number} — ${item.title}`).join('، ')}. تريد حفظ التعديل رغم ذلك؟`)) { button.disabled = false; return; }
        await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      } else {
        if (window.archiveFileSelectionError) { button.disabled = false; showToast('تعذر تجهيز كل الملفات. اخترها مرة ثانية أو ارفع ملفاً واحداً.', 'error'); return; }
        const upload = window.scannedArchiveFile || $('#f-file').files[0];
        if (!upload) { button.disabled = false; showToast('اختار ملف الوثيقة أو امسحها قبل الحفظ.', 'error'); return; }
        const data = Object.fromEntries(new FormData(form));
        const duplicateParams = new URLSearchParams({ number: data.doc_number, year: data.doc_date.slice(0, 4) });
        const duplicates = (await api(`/api/documents/duplicate?${duplicateParams}`)).duplicates;
        if (duplicates.length && !confirm(`يوجد كتاب آخر بنفس الرقم والسنة: ${duplicates.map(item => `${item.doc_number} — ${item.title}`).join('، ')}. تريد حفظه رغم ذلك؟`)) { button.disabled = false; return; }
        const formData = new FormData(form); formData.delete('file'); formData.set('file', upload, upload.name);
        await api('/api/documents', { method: 'POST', body: formData });
      }
      closeModal(); showToast(editing ? 'تم تحديث بيانات الوثيقة.' : 'تم حفظ الوثيقة بنجاح.'); await loadDocuments();
    } catch (error) { button.disabled = false; showToast(error.message, 'error'); }
  });
}

function canManageUser(target) {
  if (!can('users.manage')) return false;
  if (typeof target.can_manage === 'boolean') return target.can_manage;
  return state.user.role === 'admin' || (target.role !== 'admin' && userPermissionKeys(target).every(key => can(key)));
}
function finishAccountReauthentication(result) {
  if (!result?.reauthenticate) return false;
  state.user = null; stopIdleLock(); stopDocumentRefresh(); closeModal(); content.innerHTML = '';
  renderLogin(false, 'تم تحديث حسابك وصلاحياته. سجّل الدخول من جديد.');
  return true;
}
async function renderUsers() {
  if (!can('users.manage')) { state.page = 'documents'; return renderDocuments(); }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">إدارة الوصول للنظام</p><h1>المستخدمون</h1><p class="page-subtitle">أضف حسابات الموظفين، وعدّل بياناتهم والصلاحيات المسموحة لكل حساب.</p></div><button class="button button-primary" id="add-user"><span>＋</span> إضافة حساب دخول</button></div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">حسابات النظام</h2><div class="panel-hint">اختَر «تعديل الحساب» لتغيير الاسم واسم المستخدم والصلاحيات.</div></div></div><div id="users-result"></div></section><div class="callout">حساب المدير يمتلك كافة الصلاحيات. للحسابات الأخرى اختَر الصلاحيات المطلوبة فقط. إدارة المستخدمين تسمح بمنح الصلاحيات التي تمتلكها ضمن حسابات الموظفين المسموح لك بإدارتها.</div>`;
  $('#add-user').addEventListener('click', () => openUserModal());
  try {
    const result = await api('/api/users');
    if (!$('#users-result')) return;
    await Promise.all(result.users.map(user => rememberUsername(user.username)));
    $('#users-result').innerHTML = result.users.length ? `<div class="table-wrap"><table class="users-table"><thead><tr><th>الموظف</th><th>اسم المستخدم</th><th>الصلاحيات</th><th>الحالة</th><th>تاريخ الإضافة</th><th>إجراء</th></tr></thead><tbody>${result.users.map(u => `<tr><td><div class="user-person"><span class="avatar">${escapeHtml(initials(u.full_name))}</span><strong>${escapeHtml(u.full_name)}</strong></div></td><td>${escapeHtml(u.username)}</td><td><span class="state-badge ${u.role === 'admin' ? 'pill-admin' : 'pill-staff'}">${u.role === 'admin' ? 'كافة الصلاحيات' : `${userPermissionKeys(u).length.toLocaleString('ar-IQ')} صلاحية`}</span></td><td><span class="state-badge ${u.active ? 'status-active' : 'status-off'}">${u.active ? 'فعّال' : 'متوقف'}</span></td><td>${new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium'}).format(new Date(u.created_at))}</td><td><div class="row-actions">${canManageUser(u) ? `<button class="button button-primary button-small" data-edit-user="${u.id}" type="button">تعديل الحساب</button><button class="button button-quiet button-small" data-reset-user="${u.id}" data-name="${escapeHtml(u.full_name)}" type="button">تغيير كلمة المرور</button>${u.id !== state.user.id ? `<button class="button ${u.active ? 'button-danger' : 'button-quiet'} button-small" data-toggle-user="${u.id}" data-active="${u.active}" type="button">${u.active ? 'إيقاف' : 'تفعيل'}</button>` : ''}` : '<span class="help">خارج صلاحيات إدارتك</span>'}</div></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><div class="empty-graphic">♙</div><strong>ماكو مستخدمين إضافيين</strong><p>أضف الموظفين حتى يقدرون يدخلون للنظام.</p></div>`;
    $$('[data-edit-user]').forEach(button => button.addEventListener('click', () => openUserModal(result.users.find(user => user.id === Number(button.dataset.editUser)))));
    $$('[data-toggle-user]').forEach(button => button.addEventListener('click', async () => {
      try { const updated = await api(`/api/users/${button.dataset.toggleUser}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: button.dataset.active !== 'true' }) }); if (finishAccountReauthentication(updated)) return; showToast(button.dataset.active === 'true' ? 'تم إيقاف الحساب.' : 'تم تفعيل الحساب.'); await renderUsers(); }
      catch (error) { showToast(error.message, 'error'); }
    }));
    $$('[data-reset-user]').forEach(button => button.addEventListener('click', () => openPasswordModal(Number(button.dataset.resetUser), button.dataset.name)));
  } catch (error) { showToast(error.message, 'error'); }
}
function openUserModal(user = null) {
  if (!can('users.manage') || (user && !canManageUser(user))) return;
  const editing = Boolean(user);
  const selfStaff = editing && user.id === state.user.id && state.user.role !== 'admin';
  const allowed = state.user.role === 'admin' ? allPermissionKeys : userPermissionKeys();
  const selected = new Set(user ? userPermissionKeys(user) : legacyStaffPermissions.filter(key => allowed.includes(key)));
  const roleOptions = [{ value:'staff', label:'صلاحيات محددة — اخترها أدناه' }, ...(state.user.role === 'admin' ? [{value:'admin',label:'كافة الصلاحيات — مدير النظام'}] : [])];
  const permissionMarkup = `<section class="account-permissions" aria-labelledby="account-permissions-title"><div class="account-permissions-head"><div><h3 id="account-permissions-title">صلاحيات الحساب</h3><small id="account-permissions-count"></small></div><div class="permission-selection-actions"><button class="button button-quiet button-small" id="select-all-permissions" type="button">تحديد الكل</button><button class="button button-quiet button-small" id="clear-permissions" type="button">مسح الاختيار</button></div></div>${permissionGroups.map(group => `<fieldset class="permission-group"><legend>${escapeHtml(group.title)}</legend><div class="permission-options">${group.items.map(([key,label]) => `<label class="permission-option"><input type="checkbox" name="permissions" value="${key}" ${selected.has(key) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('')}</div></fieldset>`).join('')}<p class="help">الإضافة والتعديل والربط والمتابعة والتصدير تتطلب عرض الكتب أيضاً. صلاحية النسخ الاحتياطي تشمل بيانات الأرشيف والحسابات.</p>${selfStaff ? '<p class="help">تعديل صلاحيات حسابك يحتاج إلى مدير النظام.</p>' : ''}</section>`;
  const body = `<form id="user-form"><div class="form-grid">${field('الاسم الكامل','full_name',{value:user?.full_name || '',required:true,max:120,full:true,placeholder:'اسم الموظف'})}${field('اسم المستخدم','username',{value:user?.username || '',required:true,max:50,placeholder:'مثال: sara'})}${field(editing ? 'كلمة مرور جديدة' : 'كلمة المرور المؤقتة','password',{type:'password',required:!editing,max:200,help:editing ? 'اختياري — 6 أحرف على الأقل، أو اتركها فارغة للاحتفاظ بكلمة المرور الحالية.' : '6 أحرف على الأقل.'})}${field('مستوى الصلاحيات','role',{value:user?.role || 'staff',required:true,options:roleOptions})}${editing && user.id !== state.user.id ? `<div class="field full"><label class="permission-option"><input id="account-active" type="checkbox" ${user.active ? 'checked' : ''}><span>الحساب فعّال ويسمح له بتسجيل الدخول</span></label></div>` : ''}</div>${permissionMarkup}<div class="modal-actions"><button class="button button-primary" type="submit">${editing ? 'حفظ تعديل الحساب' : 'إنشاء الحساب'}</button><button class="button button-quiet" type="button" data-close-modal>إلغاء</button></div></form>`;
  modal(editing ? 'تعديل حساب المستخدم' : 'إضافة حساب دخول', editing ? `الحساب: ${user.username}` : 'أنشئ بيانات الدخول وحدد الصلاحيات المطلوبة.', body);
  $('.modal').classList.add('account-permissions-modal');
  const form = $('#user-form'); const role = $('#f-role');
  const inputs = $$('input[name=permissions]', form);
  role.disabled = selfStaff || state.user.role !== 'admin';
  const updatePermissions = () => {
    const full = role.value === 'admin';
    inputs.forEach(input => { if (full) input.checked = true; input.disabled = full || selfStaff || !allowed.includes(input.value); });
    $('#select-all-permissions').disabled = full || selfStaff;
    $('#clear-permissions').disabled = full || selfStaff;
    $('#account-permissions-count').textContent = full ? 'كافة صلاحيات البرنامج' : `${inputs.filter(input => input.checked).length.toLocaleString('ar-IQ')} من ${allPermissionKeys.length.toLocaleString('ar-IQ')} صلاحية`;
  };
  role.addEventListener('change', updatePermissions);
  $('#select-all-permissions').addEventListener('click', () => { inputs.forEach(input => { if (!input.disabled) input.checked = true; }); updatePermissions(); });
  $('#clear-permissions').addEventListener('click', () => { inputs.forEach(input => { if (!input.disabled) input.checked = false; }); updatePermissions(); });
  inputs.forEach(input => input.addEventListener('change', () => {
    const view = inputs.find(item => item.value === 'documents.view');
    if (input.checked && documentDependentPermissions.includes(input.value)) view.checked = true;
    if (!input.checked && input.value === 'documents.view') inputs.filter(item => documentDependentPermissions.includes(item.value)).forEach(item => { item.checked = false; });
    updatePermissions();
  }));
  updatePermissions();
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
    const data = new FormData(form);
    const payload = { full_name:data.get('full_name'), username:data.get('username') };
    const password = String(data.get('password') || '');
    if (password || !editing) payload.password = password;
    if (!selfStaff) { payload.role = role.value; payload.permissions = inputs.filter(input => input.checked).map(input => input.value); }
    if ($('#account-active')) payload.active = $('#account-active').checked;
    try {
      const updated = await api(editing ? `/api/users/${user.id}` : '/api/users', { method:editing ? 'PATCH' : 'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
      closeModal();
      if (finishAccountReauthentication(updated)) return;
      if (editing && user.id === state.user.id && updated.user) { const page = state.page; setUser(updated.user); state.page = page; }
      showToast(editing ? 'تم حفظ بيانات الحساب وصلاحياته.' : 'تم إنشاء حساب المستخدم.');
      await renderUsers();
    } catch (error) { if (button.isConnected) button.disabled = false; showToast(error.message, 'error'); }
  });
}

function openPasswordModal(id, name) {
  if (!can('users.manage')) return;
  const body = `<form id="password-form">${field('كلمة المرور الجديدة','password',{type:'password',required:true,max:200,full:true,help:'6 أحرف على الأقل.'})}<div class="modal-actions"><button class="button button-primary" type="submit">حفظ كلمة المرور</button><button class="button button-quiet" type="button" data-close-modal>إلغاء</button></div></form>`;
  modal('تغيير كلمة المرور', `حساب الموظف: ${name}`, body);
  $('#password-form').addEventListener('submit', async event => { event.preventDefault(); const button = $('button[type=submit]', event.currentTarget); button.disabled = true;
    try { const updated = await api(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); if (finishAccountReauthentication(updated)) return; showToast('تم تغيير كلمة المرور.'); }
    catch (error) { button.disabled = false; showToast(error.message, 'error'); }
  });
}
async function renderAudit() {
  if (!can('audit.view')) { state.page = 'documents'; return renderDocuments(); }
  content.innerHTML = `<div class="page-head"><div><p class="eyebrow">متابعة العمليات</p><h1>سجل الحركة</h1><p class="page-subtitle">آخر العمليات التي تمت على النظام.</p></div><button class="button button-quiet" id="refresh-audit">↻ تحديث</button></div><section class="panel"><div class="panel-header"><div><h2 class="panel-title">سجل التدقيق</h2><div class="panel-hint">آخر 200 عملية مسجلة</div></div></div><div id="audit-result"></div></section>`;
  $('#refresh-audit').addEventListener('click', renderAudit);
  try {
    const result = await api('/api/audit');
    $('#audit-result').innerHTML = result.events.length ? `<div class="table-wrap"><table class="audit-table"><thead><tr><th>العملية</th><th>المستخدم</th><th>التفاصيل</th><th>الوقت</th></tr></thead><tbody>${result.events.map(e => `<tr><td><span class="audit-event">${escapeHtml(e.event)}</span></td><td>${escapeHtml(e.full_name || 'حساب موقوف')}</td><td>${escapeHtml(e.details || e.doc_id || '—')}</td><td>${new Intl.DateTimeFormat('ar-IQ',{dateStyle:'medium',timeStyle:'short'}).format(new Date(e.created_at))}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><div class="empty-graphic">◷</div><strong>السجل فارغ</strong></div>`;
  } catch (error) { showToast(error.message, 'error'); }
}

document.addEventListener('click', async event => {
  const preset = event.target.closest('[data-type-preset]');
  if (preset && can('documents.view')) { state.type = preset.dataset.typePreset; await renderDocuments(); return; }
  const nav = event.target.closest('[data-page]');
  if (nav) {
    if (!canOpenPage(nav.dataset.page)) return;
    state.page = nav.dataset.page; await renderPage(); return;
  }
  if (event.target.closest('#user-menu')) {
    stopDocumentRefresh();
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    state.user = null; stopIdleLock(); closeModal(); content.innerHTML = ''; renderLogin(); return;
  }
  if (event.target.closest('#mobile-menu')) $('#sidebar').classList.toggle('open');
});

boot();
