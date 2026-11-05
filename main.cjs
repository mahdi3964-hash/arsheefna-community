const { app, BrowserWindow, dialog, Menu, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto');
const { pathToFileURL } = require('node:url');
app.setName('أرشيفنا');
const userDataPath = !app.isPackaged && process.env.ARSHIFNA_USER_DATA_DIR
  ? path.resolve(process.env.ARSHIFNA_USER_DATA_DIR)
  : path.join(app.getPath('appData'), 'أرشيفنا');
app.setPath('userData', userDataPath);
fs.mkdirSync(userDataPath, { recursive: true });
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow;
  let serverOrigin;

  Menu.setApplicationMenu(null);

  function sharedNetworkEnabled() {
    const settingsPath = path.join(app.getPath('userData'), 'network-settings.json');
    if (!fs.existsSync(settingsPath)) return false;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
      return settings?.enabled === true;
    } catch {
      throw new Error('تعذر قراءة إعداد مشاركة الشبكة. أعد تشغيل ملف تفعيل الشبكة.');
    }
  }

  function reserveServerPort(shared) {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', error => reject(new Error(shared && error.code === 'EADDRINUSE' ? 'منفذ مشاركة الأرشيف 8765 مستخدم. أغلق أي نسخة أخرى تعمل على الشبكة ثم أعد فتح البرنامج.' : error.message)));
      probe.listen(shared ? 8765 : 0, shared ? '0.0.0.0' : '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(error => error ? reject(error) : resolve(port));
      });
    });
  }

  async function prepareUserData() {
    const dataDir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });

    process.env.ARCHIVE_DATA_DIR = dataDir;
    delete process.env.ARCHIVE_EXTERNAL_BACKUP_DIR;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'external-backup.json'), 'utf8'));
      if (typeof settings.folder === 'string' && settings.folder.trim()) process.env.ARCHIVE_EXTERNAL_BACKUP_DIR = path.resolve(settings.folder);
    } catch {}
  }

  function savedLoginPath() {
    return path.join(app.getPath('userData'), 'saved-login.dat');
  }

  function savedUsernamesPath() {
    return path.join(app.getPath('userData'), 'saved-usernames.json');
  }

  function readSavedUsernames() {
    try {
      const values = JSON.parse(fs.readFileSync(savedUsernamesPath(), 'utf8'));
      return Array.isArray(values)
        ? [...new Set(values.filter(value => typeof value === 'string' && /^[a-zA-Z0-9._-]{3,50}$/.test(value)).map(value => value.toLowerCase()))].slice(0, 20)
        : [];
    } catch { return []; }
  }

  function assertTrustedCredentialRequest(event) {
    try {
      if (event.sender !== mainWindow?.webContents) throw new Error('طلب غير مسموح.');
      if (new URL(event.senderFrame.url).origin !== serverOrigin) throw new Error('طلب غير مسموح.');
    } catch {
      throw new Error('طلب بيانات الدخول غير مسموح.');
    }
  }

  async function requireDesktopPermission(event, permission) {
    assertTrustedCredentialRequest(event);
    const cookies = await event.sender.session.cookies.get({ url: serverOrigin, name: 'archive_session' });
    const token = cookies.find(cookie => cookie.name === 'archive_session' && /^[a-f0-9]{64}$/i.test(cookie.value))?.value;
    if (!token) throw new Error('سجّل الدخول قبل استخدام هذه الميزة.');
    const response = await fetch(`${serverOrigin}/api/me`, {
      headers: { cookie: `archive_session=${token}` }, signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('انتهت الجلسة. سجّل الدخول من جديد.');
    const { user } = await response.json();
    if (!user || (user.role !== 'admin' && !(Array.isArray(user.permissions) && user.permissions.includes(permission)))) throw new Error('حسابك لا يملك صلاحية إعداد النسخ الاحتياطي الخارجي.');
    return user;
  }

  ipcMain.handle('saved-login:get', event => {
    assertTrustedCredentialRequest(event);
    if (!safeStorage.isEncryptionAvailable()) return { available: false, credentials: null };
    const filePath = savedLoginPath();
    if (!fs.existsSync(filePath)) return { available: true, credentials: null };
    try {
      const encrypted = fs.readFileSync(filePath, 'utf8');
      const credentials = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
      if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') throw new Error('بيانات محفوظة غير صالحة.');
      return { available: true, credentials: { username: credentials.username.slice(0, 50), password: credentials.password.slice(0, 200) } };
    } catch {
      return { available: true, credentials: null };
    }
  });

  ipcMain.handle('saved-login:save', (event, credentials) => {
    assertTrustedCredentialRequest(event);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('الحفظ الآمن لكلمة المرور غير متاح على هذا الجهاز.');
    const username = typeof credentials?.username === 'string' ? credentials.username.trim() : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    if (!username || username.length > 50 || !password || password.length > 200) throw new Error('بيانات الدخول غير صالحة للحفظ.');
    const encrypted = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64');
    const destination = savedLoginPath();
    fs.writeFileSync(destination, encrypted, { mode: 0o600 });
    return { saved: true };
  });

  ipcMain.handle('saved-login:clear', event => {
    assertTrustedCredentialRequest(event);
    fs.rmSync(savedLoginPath(), { force: true });
    return { cleared: true };
  });

  ipcMain.handle('saved-usernames:get', event => {
    assertTrustedCredentialRequest(event);
    return { usernames: readSavedUsernames() };
  });

  ipcMain.handle('saved-usernames:add', (event, username) => {
    assertTrustedCredentialRequest(event);
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,50}$/.test(username.trim())) return { saved: false };
    const value = username.trim().toLowerCase();
    const usernames = [value, ...readSavedUsernames().filter(item => item !== value)].slice(0, 20);
    const destination = savedUsernamesPath();
    fs.writeFileSync(destination, JSON.stringify(usernames), { mode: 0o600 });
    return { saved: true };
  });

  ipcMain.handle('backup:choose-external-folder', async event => {
    await requireDesktopPermission(event, 'backup.create');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'اختيار القرص أو المجلد الخارجي للنسخ الاحتياطية',
      defaultPath: process.env.ARCHIVE_EXTERNAL_BACKUP_DIR && fs.existsSync(process.env.ARCHIVE_EXTERNAL_BACKUP_DIR)
        ? process.env.ARCHIVE_EXTERNAL_BACKUP_DIR
        : app.getPath('documents'),
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    await requireDesktopPermission(event, 'backup.create');
    const folder = path.resolve(result.filePaths[0]);
    fs.writeFileSync(path.join(app.getPath('userData'), 'external-backup.json'), JSON.stringify({ folder }), { mode: 0o600 });
    process.env.ARCHIVE_EXTERNAL_BACKUP_DIR = folder;
    return { canceled: false, folder };
  });

  async function waitForServer(url) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const nonce = randomBytes(16).toString('hex');
        const response = await fetch(`${url}/__health`, { headers: { 'x-archive-health-nonce': nonce }, signal: AbortSignal.timeout(2000) });
        const proof = Buffer.from(response.headers.get('x-archive-health-proof') || '', 'hex');
        const expected = createHmac('sha256', Buffer.from(process.env.ARCHIVE_HEALTH_TOKEN, 'utf8')).update(nonce).digest();
        if (response.status === 204 && proof.length === expected.length && timingSafeEqual(proof, expected)) return;
      } catch {
        // The HTTP server may still be starting.
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('ما كدرت أشغّل الأرشيف. أعد فتح البرنامج، وإذا تكرر الخطأ تواصل مع الدعم.');
  }

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 950,
      minHeight: 650,
      show: false,
      autoHideMenuBar: true,
      title: 'أرشيفنا',
      webPreferences: {
        preload: path.join(app.getAppPath(), 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(serverOrigin + '/')) event.preventDefault();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow.loadURL(serverOrigin);
  }

  app.whenReady().then(async () => {
    try {
      const shared = sharedNetworkEnabled();
      const port = await reserveServerPort(shared);
      process.env.ARCHIVE_HOST = shared ? '0.0.0.0' : '127.0.0.1';
      process.env.ARCHIVE_LAN_ENABLED = shared ? '1' : '0';
      process.env.ARCHIVE_PORT = String(port);
      process.env.ARCHIVE_HEALTH_TOKEN = randomBytes(32).toString('hex');
      await prepareUserData();

      serverOrigin = `http://127.0.0.1:${port}`;
      await import(pathToFileURL(path.join(app.getAppPath(), 'server.mjs')).href);
      await waitForServer(serverOrigin);
      await createMainWindow();
    } catch (error) {
      dialog.showErrorBox('تعذر تشغيل أرشيفنا', error.message || String(error));
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverOrigin) createMainWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
