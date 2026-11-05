import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, extname, basename, dirname, relative, resolve, sep, isAbsolute, parse } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA = process.env.ARCHIVE_DATA_DIR || join(ROOT, 'data');
const FILES = join(DATA, 'files');
const AUTO_BACKUPS = join(DATA, 'auto-backups');
const EXTERNAL_BACKUP_FOLDER = 'أرشيفنا-نسخ-احتياطية';
const LEGACY_AUTO_BACKUP_FILE = 'arsheefna-auto-latest.arshbackup';
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.ARCHIVE_PORT || 8765);
// LAN access requires an explicit opt-in; desktop-only operation stays on loopback.
const LAN_ENABLED = process.env.ARCHIVE_LAN_ENABLED === '1';
const HOST = LAN_ENABLED ? '0.0.0.0' : '127.0.0.1';
function isPrivateIPv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255 || String(Number(part)) !== part)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const LAN_ADDRESSES = LAN_ENABLED ? [...new Set(Object.values(networkInterfaces()).flat().filter(entry =>
  entry && entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)
).map(entry => entry.address))].sort() : [];
const MAX_UPLOAD = 50 * 1024 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 20 * 60 * 1000;
const MAX_ACTIVE_UPLOADS = 1;
const ALLOWED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx', '.xls', '.xlsx']);
const DOWNLOAD_MIME = new Map([
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.doc', 'application/msword'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'], ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
]);
const TYPES = new Set(['incoming', 'external_incoming', 'outgoing', 'transaction']);
const CATEGORIES = new Set(['عام', 'إداري', 'مالي', 'قانوني', 'فني', 'موارد بشرية', 'صيانة', 'أخرى']);
const STATUSES = new Set(['new', 'in_progress', 'completed']);
const MAX_BACKUP = 1024 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const PERMISSION_KEYS = Object.freeze([
  'documents.view', 'documents.create', 'documents.edit', 'documents.delete', 'documents.relate',
  'documents.followup', 'reports.export', 'backup.create', 'backup.restore', 'trash.manage', 'audit.view', 'users.manage'
]);
const LEGACY_STAFF_PERMISSIONS = Object.freeze([
  'documents.view', 'documents.create', 'documents.edit', 'documents.relate', 'documents.followup', 'reports.export'
]);
const VIEW_DEPENDENTS = new Set(['documents.create', 'documents.edit', 'documents.delete', 'documents.relate', 'documents.followup', 'reports.export', 'trash.manage']);
function normalizePermissions(value) {
  if (!Array.isArray(value) || value.length > PERMISSION_KEYS.length || new Set(value).size !== value.length || value.some(key => typeof key !== 'string' || !PERMISSION_KEYS.includes(key))) {
    throw Object.assign(new Error('قائمة الصلاحيات غير صالحة.'), { status: 400 });
  }
  const selected = new Set(value);
  if ([...selected].some(key => VIEW_DEPENDENTS.has(key))) selected.add('documents.view');
  return PERMISSION_KEYS.filter(key => selected.has(key));
}
function effectivePermissions(user) {
  if (user.role === 'admin') return [...PERMISSION_KEYS];
  if (user.permissions == null) return [...LEGACY_STAFF_PERMISSIONS];
  try { return normalizePermissions(typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions); }
  catch { return []; }
}
function publicUser(user) {
  return { id: user.id, full_name: user.full_name, username: user.username, role: user.role,
    active: !!user.active, ...(user.created_at ? { created_at: user.created_at } : {}), permissions: effectivePermissions(user) };
}
function hasPermission(user, permission) {
  return user.role === 'admin' || effectivePermissions(user).includes(permission);
}
function canManageAccount(actor, target) {
  if (actor.role === 'admin') return true;
  if (target.role === 'admin' || !hasPermission(actor, 'users.manage')) return false;
  const allowed = new Set(effectivePermissions(actor));
  return effectivePermissions(target).every(key => allowed.has(key));
}
function accountBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('بيانات الحساب غير صالحة.'), { status: 400 });
  const allowed = new Set(['full_name', 'username', 'password', 'role', 'active', 'permissions']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw Object.assign(new Error('أحد حقول الحساب غير صالح.'), { status: 400 });
  return body;
}
function accountValues(body, target = null) {
  const fullName = body.full_name === undefined && target ? target.full_name : cleanText(body.full_name, 120, 'الاسم');
  const username = body.username === undefined && target ? target.username : cleanText(body.username, 50, 'اسم المستخدم').toLowerCase();
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) throw Object.assign(new Error('اسم المستخدم يجب أن يتكون من 3 أحرف أو أرقام على الأقل.'), { status: 400 });
  const role = body.role === undefined ? (target?.role || 'staff') : body.role;
  if (!['admin', 'staff'].includes(role)) throw Object.assign(new Error('نوع الحساب غير صالح.'), { status: 400 });
  if (body.active !== undefined && typeof body.active !== 'boolean') throw Object.assign(new Error('حالة الحساب غير صالحة.'), { status: 400 });
  const active = body.active === undefined ? (target ? !!target.active : true) : body.active;
  const permissions = body.permissions === undefined
    ? (target ? effectivePermissions(target) : [...LEGACY_STAFF_PERMISSIONS])
    : normalizePermissions(body.permissions);
  let passwordHashValue = target?.password_hash;
  const passwordChanged = body.password !== undefined && body.password !== '';
  if (!target || passwordChanged) {
    if (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 200) {
      throw Object.assign(new Error('كلمة المرور يجب أن تكون من 6 إلى 200 حرف.'), { status: 400 });
    }
    const password = passwordHash(body.password);
    passwordHashValue = `${password.salt}:${password.hash}`;
  } else if (body.password !== undefined && typeof body.password !== 'string') {
    throw Object.assign(new Error('كلمة المرور غير صالحة.'), { status: 400 });
  }
  return { full_name: fullName, username, role, active: active ? 1 : 0,
    permissions: JSON.stringify(role === 'admin' ? PERMISSION_KEYS : permissions), password_hash: passwordHashValue, passwordChanged };
}
function assertAccountDelegation(actor, target, values) {
  if (actor.role === 'admin') return;
  if (target && !canManageAccount(actor, target)) throw Object.assign(new Error('لا يمكنك تعديل حساب يملك صلاحيات أعلى من صلاحياتك.'), { status: 403 });
  if (values.role === 'admin') throw Object.assign(new Error('إنشاء حساب مدير أو منحه هذه الصلاحية يتطلب مدير النظام.'), { status: 403 });
  const allowed = new Set(effectivePermissions(actor));
  if (effectivePermissions(values).some(key => !allowed.has(key))) throw Object.assign(new Error('لا يمكنك منح صلاحية لا تملكها.'), { status: 403 });
  if (target?.id === actor.id && (values.role !== target.role || JSON.stringify(effectivePermissions(values)) !== JSON.stringify(effectivePermissions(target)))) {
    throw Object.assign(new Error('لا يمكنك تغيير صلاحيات حسابك بنفسك.'), { status: 403 });
  }
}
function requiredRoutePermissions(method, path) {
  if (method === 'GET' && (path === '/api/me' || path === '/api/network/status')) return [];
  if ((method === 'GET' && path === '/api/scanners') || (method === 'POST' && path === '/api/scanners/scan')) return ['documents.create'];
  if (method === 'GET' && ['/api/summary', '/api/reminders', '/api/documents', '/api/documents/lookup', '/api/documents/duplicate'].includes(path)) return ['documents.view'];
  if (method === 'GET' && /^\/api\/(files\/[0-9a-f-]+|documents\/[0-9a-f-]+\/(relations|activity))$/i.test(path)) return ['documents.view'];
  if (method === 'POST' && path === '/api/documents') return ['documents.create'];
  if (/^\/api\/documents\/[0-9a-f-]+$/i.test(path)) {
    if (method === 'PATCH') return ['documents.edit'];
    if (method === 'DELETE') return ['documents.delete'];
  }
  if (method === 'PUT' && /^\/api\/documents\/[0-9a-f-]+\/relations$/i.test(path)) return ['documents.relate'];
  if (method === 'POST' && /^\/api\/documents\/[0-9a-f-]+\/activity$/i.test(path)) return ['documents.followup'];
  if (method === 'GET' && path === '/api/export.xlsx') return ['reports.export'];
  if (method === 'GET' && path === '/api/backup-status') return ['backup.create', 'backup.restore'];
  if (method === 'POST' && path === '/api/backup/verify-upload') return ['backup.create', 'backup.restore'];
  if (method === 'POST' && path === '/api/restore') return ['backup.restore'];
  if ((method === 'GET' && ['/api/backup', '/api/backup/external/status', '/api/backup/automatic/verify', '/api/backup/automatic/latest', '/api/backup/safety/latest', '/api/backup/excel-periods', '/api/backup/excel-source'].includes(path)) ||
      (method === 'POST' && ['/api/backup/external/sync', '/api/backup.xlsx'].includes(path))) return ['backup.create'];
  if ((method === 'GET' && path === '/api/trash') || (method === 'POST' && /^\/api\/trash\/[0-9a-f-]+\/restore$/i.test(path)) || (method === 'DELETE' && /^\/api\/trash\/[0-9a-f-]+$/i.test(path))) return ['trash.manage'];
  if ((['GET', 'POST'].includes(method) && path === '/api/users') || (method === 'PATCH' && /^\/api\/users\/\d+$/.test(path))) return ['users.manage'];
  if (method === 'GET' && path === '/api/audit') return ['audit.view'];
  return null;
}


function splitIncomingTypes(connection) {
  connection.exec('CREATE TABLE IF NOT EXISTS archive_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (connection.prepare('SELECT 1 FROM archive_migrations WHERE name=?').get('incoming-scope-v1')) return;
  const normalize = value => String(value || '').replace(/[أإآٱ]/g,'ا').replace(/[\u064B-\u065F\u0670ـ]/g,'').replace(/\s+/g,' ').trim();
  const rows = connection.prepare("SELECT id,sender,doc_number FROM documents WHERE doc_type='incoming'").all();
  const external = rows.filter(row => {
    const sender=normalize(row.sender);
    if (/الجهد الخدمي/.test(sender) || /^قسم\s/.test(sender)) return false;
    return /^(?:ال)?(?:مديرية|ديرية)|^المديريه|^الدائرة|^الدايره|^مكتب (?:الامين العام|رئيس الاركان|رئيس الهيئة)|^معاون رئيس الاركان|^قيادة عمليات/.test(sender);
  });
  if (external.length) {
    const snapshot=join(DATA,'before-incoming-split-'+randomUUID()+'.sqlite');
    connection.exec("VACUUM INTO '"+snapshot.replace(/'/g,"''")+"'");
  }
  connection.exec('BEGIN IMMEDIATE');
  try {
    const update=connection.prepare("UPDATE documents SET doc_type='external_incoming' WHERE id=? AND doc_type='incoming'");
    for(const row of external) update.run(row.id);
    connection.prepare('INSERT INTO archive_migrations(name,applied_at) VALUES(?,?)').run('incoming-scope-v1',new Date().toISOString());
    if(external.length) connection.prepare('INSERT INTO audit_log(event,user_id,doc_id,details,created_at) VALUES(?,NULL,NULL,?,?)').run('تنظيم الوارد الخارجي',String(external.length)+' كتاب حسب الجهة المرسلة',new Date().toISOString());
    connection.exec('COMMIT');
  } catch(error) { connection.exec('ROLLBACK'); throw error; }
}

mkdirSync(FILES, { recursive: true });
let db;
function openDatabase() {
  const connection = new DatabaseSync(join(DATA, 'archive.sqlite'));
  connection.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','staff')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    archive_no TEXT,
    title TEXT NOT NULL,
    doc_number TEXT NOT NULL,
    doc_date TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'عام',
    sender TEXT NOT NULL DEFAULT '',
    recipient TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    file_original TEXT NOT NULL,
    file_storage TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    event TEXT NOT NULL,
    doc_id TEXT,
    user_id INTEGER REFERENCES users(id),
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS document_relations (
    doc_a TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    doc_b TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(doc_a, doc_b),
    CHECK(doc_a < doc_b)
  );
  CREATE TABLE IF NOT EXISTS document_activity (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    event TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);
  const userColumns = new Set(connection.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('permissions')) connection.exec('ALTER TABLE users ADD COLUMN permissions TEXT');
  const columns = new Set(connection.prepare('PRAGMA table_info(documents)').all().map(column => column.name));
  for (const [name, definition] of [
    ['category', "TEXT NOT NULL DEFAULT 'عام'"],
    ['sender', "TEXT NOT NULL DEFAULT ''"],
    ['recipient', "TEXT NOT NULL DEFAULT ''"],
    ['status', "TEXT NOT NULL DEFAULT 'new'"],
    ['due_date', 'TEXT'],
    ['archive_no', 'TEXT'],
    ['deleted_at', 'TEXT']
  ]) if (!columns.has(name)) connection.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  let archiveSequence = Number(connection.prepare("SELECT MAX(CAST(SUBSTR(archive_no,4) AS INTEGER)) AS n FROM documents WHERE archive_no GLOB 'AR-[0-9]*'").get().n || 0);
  const fillArchiveNo = connection.prepare('UPDATE documents SET archive_no=? WHERE id=?');
  for (const row of connection.prepare("SELECT id FROM documents WHERE archive_no IS NULL OR archive_no='' ORDER BY created_at,id").all()) {
    archiveSequence += 1;
    fillArchiveNo.run(`AR-${String(archiveSequence).padStart(6, '0')}`, row.id);
  }
  connection.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(doc_date DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_number ON documents(doc_number);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_documents_due_date ON documents(due_date);
    CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_document_relations_b ON document_relations(doc_b);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_archive_no ON documents(archive_no);
    CREATE INDEX IF NOT EXISTS idx_document_activity_doc ON document_activity(doc_id,created_at DESC);
  `);
  splitIncomingTypes(connection);
  return connection;
}
db = openDatabase();
for (const name of readdirSync(FILES)) {
  const pendingDelete = /^\.([0-9a-f-]{36}\.(?:pdf|png|jpg|jpeg|doc|docx|xls|xlsx))\.delete-[0-9a-f-]{36}\.tmp$/i.exec(name);
  if (!pendingDelete) continue;
  const storedName = pendingDelete[1]; const pendingPath = join(FILES, name); const originalPath = join(FILES, storedName);
  try {
    if (db.prepare('SELECT 1 FROM documents WHERE file_storage=?').get(storedName)) {
      if (!existsSync(originalPath)) renameSync(pendingPath, originalPath);
      else unlinkSync(pendingPath);
    } else unlinkSync(pendingPath);
  } catch (error) { console.error(`[${new Date().toISOString()}] تعذرت معالجة ملف حذف نهائي متوقف:`, error); }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function zipArchive(items) {
  if (items.length > 65535) throw new Error('عدد ملفات النسخة الاحتياطية أكبر من الحد المسموح.');
  const locals = []; const centrals = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8'); const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error('حجم أحد ملفات الأرشيف أكبر من الحد المسموح.');
    const compressed = deflateRawSync(data, { level: 6 }); const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset > 0xffffffff) throw new Error('حجم النسخة الاحتياطية تجاوز 4 غيغابايت.');
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
function unzipArchive(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535); let endAt = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) if (buffer.readUInt32LE(i) === 0x06054b50) { endAt = i; break; }
  if (endAt < 0) throw Object.assign(new Error('ملف النسخة الاحتياطية غير صالح.'), { status: 400 });
  const count = buffer.readUInt16LE(endAt + 10); const centralSize = buffer.readUInt32LE(endAt + 12); const centralAt = buffer.readUInt32LE(endAt + 16);
  if (centralAt + centralSize > endAt) throw Object.assign(new Error('ملف النسخة الاحتياطية غير مكتمل.'), { status: 400 });
  const entries = new Map(); let cursor = centralAt; let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw Object.assign(new Error('بنية ملف النسخة الاحتياطية غير صالحة.'), { status: 400 });
    const flags = buffer.readUInt16LE(cursor + 8); const method = buffer.readUInt16LE(cursor + 10); const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20); const dataSize = buffer.readUInt32LE(cursor + 24);
    const nameSize = buffer.readUInt16LE(cursor + 28); const extraSize = buffer.readUInt16LE(cursor + 30); const commentSize = buffer.readUInt16LE(cursor + 32);
    const localAt = buffer.readUInt32LE(cursor + 42); const name = buffer.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    cursor += 46 + nameSize + extraSize + commentSize;
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) throw Object.assign(new Error('اسم ملف داخل النسخة الاحتياطية غير آمن.'), { status: 400 });
    totalUncompressed += dataSize;
    if (entries.has(name) || (flags & 1) || ![0, 8].includes(method) || dataSize > MAX_BACKUP || totalUncompressed > MAX_BACKUP) throw Object.assign(new Error('حجم أو صيغة أحد ملفات النسخة الاحتياطية غير مسموح.'), { status: 400 });
    if (localAt + 30 > buffer.length || buffer.readUInt32LE(localAt) !== 0x04034b50) throw Object.assign(new Error('ملف النسخة الاحتياطية غير مكتمل.'), { status: 400 });
    const localNameSize = buffer.readUInt16LE(localAt + 26); const localExtraSize = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameSize + localExtraSize;
    if (dataAt + compressedSize > buffer.length) throw Object.assign(new Error('بيانات النسخة الاحتياطية غير مكتملة.'), { status: 400 });
    const packed = buffer.subarray(dataAt, dataAt + compressedSize);
    let data;
    try { data = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_BACKUP }); }
    catch { throw Object.assign(new Error('تعذر فك ضغط ملفات النسخة الاحتياطية.'), { status: 400 }); }
    if (data.length !== dataSize || crc32(data) !== checksum) throw Object.assign(new Error('التحقق من بيانات النسخة الاحتياطية لم ينجح.'), { status: 400 });
    entries.set(name, data);
  }
  return entries;
}
function xmlEscape(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}
function excelColumn(index) {
  let result = '';
  while (index > 0) { index -= 1; result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26); }
  return result;
}
function createExcelFile(rows) {
  const headers = ['رقم الأرشيف', 'العنوان / الموضوع', 'رقم الكتاب', 'التاريخ', 'موعد المتابعة', 'النوع', 'الجهة المرسلة', 'الجهة المستلمة', 'القسم', 'الملاحظات', 'اسم الملف', 'مؤرشف'];
  const values = [headers, ...rows.map(row => [row.archive_no, row.title, row.doc_number, row.doc_date, row.due_date || '', typeLabel(row.doc_type), row.sender, row.recipient, row.department, row.notes, row.file_original, row.archived ? 'نعم' : 'لا'])];
  return createExcelWorkbook([{ name: 'الأرشيف', headers, rows: values.slice(1) }]);
}
function createExcelWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 255) throw new Error('محتوى ملف Excel غير صالح.');
  const items = [];
  const sheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const drawingOverrides = sheets.map((sheet, index) => sheet.images?.length ? `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '').join('');
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xmlEscape(String(sheet.name || `ورقة ${index + 1}`).slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbookRels = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  let nextImageId = 1;
  items.push(
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}${drawingOverrides}</Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0" firstSheet="0" rightToLeft="1"/></bookViews><sheets>${workbookSheets}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>` }
  );
  sheets.forEach((sheet, index) => {
    const headers = Array.isArray(sheet.headers) ? sheet.headers : [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const images = Array.isArray(sheet.images) ? sheet.images : [];
    const links = Array.isArray(sheet.links) ? sheet.links : [];
    const formulas = new Map((Array.isArray(sheet.formulas) ? sheet.formulas : []).map(item => [item.cell, item.formula]));
    if (rows.length + 1 > 1_048_576) throw Object.assign(new Error(`ورقة «${sheet.name}» تتجاوز الحد الأقصى لصفوف Excel.`), { status: 413 });
    const values = [headers, ...rows];
    const lastColumn = excelColumn(Math.max(1, headers.length));
    const imageRows = new Set(images.map(image => image.row));
    const rowsXml = values.map((row, r) => `<row r="${r + 1}"${imageRows.has(r + 1) ? ' ht="138" customHeight="1"' : ''}>${row.map((value, c) => {
      const ref = `${excelColumn(c + 1)}${r + 1}`; const formula = formulas.get(ref);
      return formula ? `<c r="${ref}" t="str"><f>${xmlEscape(formula)}</f><v>${xmlEscape(value)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const colsXml = Array.isArray(sheet.widths) && sheet.widths.length ? `<cols>${sheet.widths.map((width, column) => `<col min="${column + 1}" max="${column + 1}" width="${Math.max(5, Math.min(80, Number(width) || 18))}" customWidth="1"/>`).join('')}</cols>` : '';
    const linksXml = links.length ? `<hyperlinks>${links.map(link => `<hyperlink ref="${xmlEscape(link.cell)}" location="${xmlEscape(link.location)}"${link.display ? ` display="${xmlEscape(link.display)}"` : ''}/>`).join('')}</hyperlinks>` : '';
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/>${colsXml}<sheetData>${rowsXml}</sheetData><autoFilter ref="A1:${lastColumn}${values.length}"/>${linksXml}${images.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
    items.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml });
    if (images.length) {
      const drawingParts = [];
      const drawingRels = [];
      images.forEach((image, imageIndex) => {
        const imageId = nextImageId++;
        const cx = Math.round((Number(image.width) || 130) * 9525); const cy = Math.round((Number(image.height) || 150) * 9525);
        drawingParts.push(`<xdr:oneCellAnchor><xdr:from><xdr:col>${Math.max(0, Number(image.col) || 0)}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${Math.max(0, Number(image.row) - 1)}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${imageIndex + 1}" name="${xmlEscape(image.name || `معاينة ${imageIndex + 1}`)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${imageIndex + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`);
        drawingRels.push(`<Relationship Id="rId${imageIndex + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imageId}.jpg"/>`);
        items.push({ name: `xl/media/image${imageId}.jpg`, data: Buffer.from(image.data) });
      });
      items.push({ name: `xl/drawings/drawing${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${drawingParts.join('')}</xdr:wsDr>` });
      items.push({ name: `xl/drawings/_rels/drawing${index + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>` });
      items.push({ name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${index + 1}.xml"/></Relationships>` });
    }
  });
  return zipArchive(items);
}
function typeLabel(type) { return ({ incoming: 'كتب واردنا', external_incoming: 'وارد خارجي', outgoing: 'كتاب صادر', transaction: 'معاملة' })[type] || type || ''; }
function statusLabel(status) { return ({ new: 'جديدة', in_progress: 'قيد الإنجاز', completed: 'منجزة' })[status] || status || ''; }

const sessions = new Map();
const MAX_SESSIONS_PER_USER = 5;
const failedLogins = new Map();
let activeUploads = 0;
let automaticBackupError = '';
let externalBackupError = '';

function now() { return new Date().toISOString(); }
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function normalizeArabicSearchText(value) {
  return String(value || '').replace(/[أإآٱ]/g, 'ا');
}
function normalizedArabicTextSql(column) {
  let expression = column;
  for (const letter of ['أ', 'إ', 'آ', 'ٱ']) expression = 'replace(' + expression + ",'" + letter + "','ا')";
  return 'lower(' + expression + ')';
}
function normalizeDocNumber(value) {
  return normalizeArabicSearchText(value).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/\s+/g, '').toLocaleLowerCase('en-US');
}
function normalizedDocNumberSql(column = 'd.doc_number') {
  let expression = column;
  for (let digit = 0; digit < 10; digit += 1) {
    expression = `replace(${expression},'${String.fromCharCode(0x0660 + digit)}','${digit}')`;
    expression = `replace(${expression},'${String.fromCharCode(0x06f0 + digit)}','${digit}')`;
  }
  for (const codePoint of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) {
    expression = `replace(${expression},char(${codePoint}),'')`;
  }
  for (const letter of ['أ', 'إ', 'آ', 'ٱ']) expression = 'replace(' + expression + ",'" + letter + "','ا')";
  return `lower(${expression})`;
}
const NORMALIZED_DOC_NUMBER_SQL = normalizedDocNumberSql();
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function passwordMatches(password, saved) {
  const [salt, expectedHex] = saved.split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const DUMMY_PASSWORD_HASH = (() => { const value = passwordHash(randomBytes(24).toString('hex')); return `${value.salt}:${value.hash}`; })();
function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
function fail(res, status, message) { json(res, status, { error: message }); }
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const item of raw.split(';')) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
function createSession(userId) {
  const time = Date.now();
  for (const [token, session] of sessions) {
    if (session.expires < time || time - (session.lastActivity || 0) > SESSION_IDLE_MS) sessions.delete(token);
  }
  const existing = [...sessions.entries()].filter(([, session]) => session.userId === userId)
    .sort((a, b) => (a[1].lastActivity || 0) - (b[1].lastActivity || 0));
  while (existing.length >= MAX_SESSIONS_PER_USER) sessions.delete(existing.shift()[0]);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { userId, expires: time + SESSION_MS, lastActivity: time });
  return token;
}
function currentUser(req) {
  const token = getCookie(req, 'archive_session');
  const session = sessions.get(token);
  const time = Date.now();
  if (!session || session.expires < time || time - (session.lastActivity || 0) > SESSION_IDLE_MS) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = db.prepare('SELECT id, full_name, username, role, active, permissions FROM users WHERE id = ?').get(session.userId);
  if (!user || !user.active) { sessions.delete(token); return null; }
  session.lastActivity = time;
  return publicUser(user);
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { fail(res, 401, 'انتهت الجلسة، سجّل الدخول من جديد.'); return null; }
  return user;
}
function requireAdmin(user, res) {
  if (user.role !== 'admin') { fail(res, 403, 'هذه الصلاحية للمدير فقط.'); return false; }
  return true;
}
function logEvent(event, userId, docId = null, details = '') {
  db.prepare('INSERT INTO audit_log(event, user_id, doc_id, details, created_at) VALUES(?,?,?,?,?)').run(event, userId ?? null, docId, String(details).slice(0, 500), now());
}
function logDocumentActivity(docId, userId, event, details = '') {
  db.prepare('INSERT INTO document_activity(doc_id,user_id,event,details,created_at) VALUES(?,?,?,?,?)').run(docId, userId ?? null, event, String(details).slice(0, 3000), now());
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('حجم الطلب أكبر من الحد المسموح.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('البيانات المرسلة غير مفهومة.'), { status: 400 }); }
}
function cleanText(value, max, field) {
  if (typeof value !== 'string') throw Object.assign(new Error(`تحقق من حقل ${field}.`), { status: 400 });
  const clean = value.trim();
  if (!clean || clean.length > max) throw Object.assign(new Error(`حقل ${field} مطلوب وبحد أقصى ${max} حرف.`), { status: 400 });
  return clean;
}
function validateDoc(data) {
  const title = cleanText(data.title, 300, 'العنوان');
  const number = cleanText(data.doc_number, 100, 'الرقم');
  const date = cleanText(data.doc_date, 10, 'التاريخ');
  if (!isIsoDate(date)) throw Object.assign(new Error('اكتب التاريخ بصيغة سنة-شهر-يوم.'), { status: 400 });
  if (!TYPES.has(data.doc_type)) throw Object.assign(new Error('اختر نوع الوثيقة.'), { status: 400 });
  const category = data.category || 'عام';
  const status = data.status || 'new';
  if (!CATEGORIES.has(category)) throw Object.assign(new Error('اختر تصنيفاً من القائمة.'), { status: 400 });
  if (!STATUSES.has(status)) throw Object.assign(new Error('اختر حالة المعاملة من القائمة.'), { status: 400 });
  const dueDate = typeof data.due_date === 'string' ? data.due_date.trim() : '';
  if (dueDate && !isIsoDate(dueDate)) throw Object.assign(new Error('تحقق من موعد المتابعة.'), { status: 400 });
  const department = typeof data.department === 'string' ? data.department.trim().slice(0, 120) : '';
  const sender = typeof data.sender === 'string' ? data.sender.trim().slice(0, 160) : '';
  const recipient = typeof data.recipient === 'string' ? data.recipient.trim().slice(0, 160) : '';
  const notes = typeof data.notes === 'string' ? data.notes.trim().slice(0, 3000) : '';
  return { title, doc_number: number, doc_date: date, due_date: dueDate || null, doc_type: data.doc_type, category, status, sender, recipient, department, notes };
}
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw Object.assign(new Error('نموذج رفع الملف غير صالح.'), { status: 400 });
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  const fields = {};
  let file = null;
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start < 0) break;
    let partStart = start + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
    if (buffer.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0) break;
    const headers = buffer.subarray(partStart, headerEnd).toString('latin1');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    let contentEnd = next;
    if (buffer.subarray(contentEnd - 2, contentEnd).toString() === '\r\n') contentEnd -= 2;
    const content = buffer.subarray(headerEnd + 4, contentEnd);
    const disp = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers)?.[1] || '';
    const name = /name="([^"]*)"/i.exec(disp)?.[1] || '';
    const filename = /filename="([^"]*)"/i.exec(disp)?.[1];
    if (filename !== undefined) {
      if (name === 'file' && filename) file = { filename, content: Buffer.from(content), mime: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream' };
    } else if (name) fields[name] = content.toString('utf8');
    cursor = next;
  }
  return { fields, file };
}
function safeOriginalName(filename) {
  const leaf = basename(filename.replace(/\\/g, '/'));
  return leaf.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180) || 'document';
}
function addDocRecord(doc, user, file, storageName) {
  const time = now();
  const archiveNo = nextArchiveNumber();
  db.prepare(`INSERT INTO documents(id,archive_no,title,doc_number,doc_date,due_date,doc_type,department,category,sender,recipient,status,notes,file_original,file_storage,mime_type,file_size,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(doc.id, archiveNo, doc.title, doc.doc_number, doc.doc_date, doc.due_date, doc.doc_type, doc.department, doc.category, doc.sender, doc.recipient, doc.status, doc.notes, file.original, storageName, file.mime, file.content.length, user.id, time, time);
  logEvent('إضافة وثيقة', user.id, doc.id, `${doc.doc_number} — ${doc.title}`);
  logDocumentActivity(doc.id, user.id, 'إضافة إلى الأرشيف', `${archiveNo} · ${doc.doc_number} — ${doc.title}`);
}
function nextArchiveNumber() {
  const current = Number(db.prepare("SELECT MAX(CAST(SUBSTR(archive_no,4) AS INTEGER)) AS n FROM documents WHERE archive_no GLOB 'AR-[0-9]*'").get().n || 0);
  return `AR-${String(current + 1).padStart(6, '0')}`;
}
function publicDoc(row) {
  return { id: row.id, archive_no: row.archive_no || '', title: row.title, doc_number: row.doc_number, doc_date: row.doc_date, due_date: row.due_date || '', doc_type: row.doc_type, department: row.department, category: row.category || 'عام', sender: row.sender || '', recipient: row.recipient || '', status: row.status || 'new', notes: row.notes,
    file_original: row.file_original, file_size: row.file_size, created_by_name: row.created_by_name, created_at: row.created_at, updated_at: row.updated_at, archived: !!row.archived, related_count: Number(row.related_count || 0) };
}
const DOC_SELECT = `SELECT d.*, u.full_name AS created_by_name, (SELECT COUNT(*) FROM document_relations rel JOIN documents other ON other.id=CASE WHEN rel.doc_a=d.id THEN rel.doc_b ELSE rel.doc_a END WHERE (rel.doc_a=d.id OR rel.doc_b=d.id) AND other.deleted_at IS NULL) AS related_count FROM documents d JOIN users u ON u.id=d.created_by`;
function documentFilters(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const from = url.searchParams.get('from') || ''; const to = url.searchParams.get('to') || '';
  const type = url.searchParams.get('type') || ''; const category = url.searchParams.get('category') || '';
  const status = url.searchParams.get('status') || ''; const year = url.searchParams.get('year') || '';
  const party = (url.searchParams.get('party') || '').trim().slice(0, 160);
  const requestedSearchMode = url.searchParams.get('searchMode') || 'auto';
  const searchMode = ['auto', 'number-exact', 'all'].includes(requestedSearchMode) ? requestedSearchMode : 'auto';
  const archivedFilter = url.searchParams.get('archived');
  const conditions = ['d.deleted_at IS NULL']; const params = [];
  if (archivedFilter === '0' || archivedFilter === '1') {
    conditions.push('d.archived=?'); params.push(Number(archivedFilter));
  }
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { conditions.push('d.doc_date>=?'); params.push(from); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { conditions.push('d.doc_date<=?'); params.push(to); }
  if (TYPES.has(type)) { conditions.push('d.doc_type=?'); params.push(type); }
  if (CATEGORIES.has(category)) { conditions.push('d.category=?'); params.push(category); }
  if (STATUSES.has(status)) { conditions.push('d.status=?'); params.push(status); }
  if (/^\d{4}$/.test(year)) { conditions.push('substr(d.doc_date,1,4)=?'); params.push(year); }
  if (party) {
    const normalizedParty = normalizeArabicSearchText(party);
    const partyColumns = ['d.sender', 'd.recipient', 'd.department'];
    conditions.push('(' + partyColumns.map(column => normalizedArabicTextSql(column) + ' LIKE ?').join(' OR ') + ')');
    params.push(...partyColumns.map(() => '%' + normalizedParty + '%'));
  }
  if (q) {
    const normalizedNumber = normalizeDocNumber(q);
    const isNumericQuery = /^\d+$/.test(normalizedNumber);
    const numberOnly = searchMode === 'number-exact' || (searchMode === 'auto' && isNumericQuery);
    if (numberOnly) {
      const exactNumber = searchMode === 'number-exact';
      conditions.push(exactNumber ? `${NORMALIZED_DOC_NUMBER_SQL}=?` : `${NORMALIZED_DOC_NUMBER_SQL} LIKE ?`);
      params.push(exactNumber ? normalizedNumber : `%${normalizedNumber}%`);
    } else {
      const normalizedQuery = normalizeArabicSearchText(q);
      const searchColumns = ['d.archive_no', 'd.title', 'd.doc_number', 'd.doc_date', 'd.sender', 'd.recipient', 'd.department', 'd.notes'];
      conditions.push('(' + searchColumns.map(column => normalizedArabicTextSql(column) + ' LIKE ?').join(' OR ') + ')');
      params.push(...searchColumns.map(() => '%' + normalizedQuery + '%'));
    }
  }
  return { conditions, params };
}

function excelBackupPeriod(body) {
  if (body.year != null && typeof body.year !== 'string' && !(typeof body.year === 'number' && Number.isInteger(body.year))) throw Object.assign(new Error('اختار سنة صحيحة لتصدير الكتب.'), { status: 400 });
  const year = body.year == null || body.year === '' ? '' : String(body.year);
  const allMonths = Array.from({ length: 12 }, (_, index) => index + 1);
  if (year && !/^[1-9]\d{3}$/.test(year)) throw Object.assign(new Error('اختار سنة صحيحة لتصدير الكتب.'), { status: 400 });
  if (!year) {
    if (body.months != null && (!Array.isArray(body.months) || body.months.length)) throw Object.assign(new Error('اختار السنة أولاً حتى تحدد الأشهر.'), { status: 400 });
    return { year: '', months: [], conditions: ['d.deleted_at IS NULL'], params: [], label: 'كل السنوات وكل الأشهر' };
  }
  const requested = body.months == null ? allMonths : body.months;
  if (!Array.isArray(requested) || !requested.length || requested.length > 12 || requested.some(month => !Number.isInteger(month) || month < 1 || month > 12)) {
    throw Object.assign(new Error('اختار شهراً واحداً على الأقل من 1 إلى 12، أو اختار كل الأشهر.'), { status: 400 });
  }
  const months = [...new Set(requested)].sort((a, b) => a - b);
  return {
    year, months,
    conditions: ['d.deleted_at IS NULL', 'substr(d.doc_date,1,4)=?', `substr(d.doc_date,6,2) IN (${months.map(() => '?').join(',')})`],
    params: [year, ...months.map(month => String(month).padStart(2, '0'))],
    label: months.length === 12 ? `سنة ${year} — كل الأشهر` : `سنة ${year} — الأشهر: ${months.join('، ')}`
  };
}

function makeBackup() {
  const snapshotPath = join(DATA, `.backup-${randomUUID()}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    const entries = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'arsheefna-backup-v1', createdAt: now(), app: 'أرشيفنا' }), 'utf8') },
      { name: 'archive.sqlite', data: readFileSync(snapshotPath) }
    ];
    for (const name of readdirSync(FILES)) {
      const path = join(FILES, name);
      if (statSync(path).isFile() && !name.endsWith('.tmp')) entries.push({ name: `files/${name}`, data: readFileSync(path) });
    }
    return zipArchive(entries);
  } finally {
    try { if (existsSync(snapshotPath)) unlinkSync(snapshotPath); } catch {}
  }
}

function automaticBackupFileList(directory = AUTO_BACKUPS) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^arsheefna-auto-\d{4}-\d{2}-\d{2}\.arshbackup$/.test(name))
    .sort((a, b) => b.localeCompare(a));
}
function migrateLegacyAutomaticBackup() {
  const legacyPath = join(AUTO_BACKUPS, LEGACY_AUTO_BACKUP_FILE);
  if (!existsSync(legacyPath)) return;
  const date = localDateKey(statSync(legacyPath).mtime);
  const datedName = `arsheefna-auto-${date}.arshbackup`;
  const datedPath = join(AUTO_BACKUPS, datedName);
  if (!existsSync(datedPath)) {
    renameSync(legacyPath, datedPath);
    return;
  }
  if (statSync(legacyPath).mtimeMs > statSync(datedPath).mtimeMs) {
    writeFileSync(datedPath, readFileSync(legacyPath));
  }
  unlinkSync(legacyPath);
}
function pruneAutomaticBackups(directory = AUTO_BACKUPS) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 2);
  const cutoffDate = localDateKey(cutoff);
  const files = automaticBackupFileList(directory);
  for (const file of files) {
    const date = file.match(/arsheefna-auto-(\d{4}-\d{2}-\d{2})\.arshbackup$/)?.[1];
    if (date && date < cutoffDate) unlinkSync(join(directory, file));
  }
  for (const oldFile of automaticBackupFileList(directory).slice(3)) unlinkSync(join(directory, oldFile));
}
function externalBackupBaseDirectory() {
  const configured = String(process.env.ARCHIVE_EXTERNAL_BACKUP_DIR || '').trim();
  if (!configured) return '';
  if (!isAbsolute(configured)) throw new Error('مسار القرص الخارجي غير صالح. اختاره من زر اختيار المجلد.');
  const target = resolve(configured);
  const dataPath = resolve(DATA);
  const isInside = (parent, child) => {
    const pathFromParent = relative(parent, child);
    return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
  };
  if (isInside(dataPath, target) || isInside(target, dataPath)) {
    throw new Error('اختار مجلداً خارج مجلد بيانات أرشيفنا حتى لا تكون النسخة على نفس مكان الأرشيف.');
  }
  const sourceRoot = parse(dataPath).root.toLowerCase();
  const targetRoot = parse(target).root.toLowerCase();
  if (sourceRoot && targetRoot && sourceRoot === targetRoot) {
    throw new Error('اختار قرصاً خارجياً بحرف مختلف عن قرص الأرشيف، مثل D: أو USB.');
  }
  return target;
}
function externalBackupDirectory() {
  const base = externalBackupBaseDirectory();
  return base ? join(base, EXTERNAL_BACKUP_FOLDER) : '';
}
function externalBackupErrorMessage(error) {
  if (['ENOENT', 'ENODEV', 'ENXIO'].includes(error?.code)) return 'القرص الخارجي غير متصل. وصّله ثم اضغط «مزامنة النسخة الآن». ';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'ماكو صلاحية كتابة على القرص الخارجي. اختار مجلداً آخر وتأكد أنه غير محمي من الكتابة.';
  if (error?.code === 'ENOSPC') return 'مساحة القرص الخارجي غير كافية لحفظ النسخة الاحتياطية.';
  if (error?.code === 'ENOTDIR') return 'المكان المحدد لا يشير إلى مجلد صالح على القرص الخارجي.';
  return error?.message || 'تعذرت مزامنة النسخة الخارجية.';
}
function externalBackupStatus() {
  const configured = Boolean(String(process.env.ARCHIVE_EXTERNAL_BACKUP_DIR || '').trim());
  if (!configured) return { configured: false, available: false, folderName: '', directory: '', count: 0, latest: null, latestDate: null, error: '' };
  try {
    const base = externalBackupBaseDirectory();
    const directory = externalBackupDirectory();
    if (!existsSync(base) || !statSync(base).isDirectory()) {
      return { configured: true, available: false, folderName: basename(base) || base, directory, count: 0, latest: null, latestDate: null, error: externalBackupError || 'القرص أو المجلد الخارجي غير متصل حالياً.' };
    }
    if (existsSync(directory) && !statSync(directory).isDirectory()) {
      return { configured: true, available: false, folderName: basename(base) || base, directory, count: 0, latest: null, latestDate: null, error: 'المجلد المخصص للنسخ الخارجية موجود كملف وليس كمجلد.' };
    }
    const files = automaticBackupFileList(directory);
    const latest = files[0] || null;
    const latestDate = latest ? latest.match(/arsheefna-auto-(\d{4}-\d{2}-\d{2})\.arshbackup$/)?.[1] || null : null;
    return { configured: true, available: true, folderName: basename(base) || base, directory, count: files.length, latest, latestDate, error: externalBackupError };
  } catch (error) {
    return { configured: true, available: false, folderName: '', directory: '', count: 0, latest: null, latestDate: null, error: externalBackupErrorMessage(error) };
  }
}
function syncExternalBackups() {
  const base = externalBackupBaseDirectory();
  if (!base) throw Object.assign(new Error('اختار مكان النسخة الخارجية أولاً.'), { status: 400 });
  if (!existsSync(base) || !statSync(base).isDirectory()) throw Object.assign(new Error('القرص الخارجي غير متصل. وصّله ثم اضغط مزامنة النسخة.'), { status: 503 });
  const directory = externalBackupDirectory();
  if (existsSync(directory) && !statSync(directory).isDirectory()) throw Object.assign(new Error('المجلد المخصص للنسخ الخارجية موجود كملف وليس كمجلد.'), { status: 400 });
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    const previousMatch = /^\.(arsheefna-auto-\d{4}-\d{2}-\d{2}\.arshbackup)\.[0-9a-f-]{36}\.previous\.tmp$/i.exec(name);
    const temporaryMatch = /^\.arsheefna-auto-\d{4}-\d{2}-\d{2}\.arshbackup\.[0-9a-f-]{36}\.tmp$/i.test(name);
    const pendingPath = join(directory, name);
    if (previousMatch) {
      const originalPath = join(directory, previousMatch[1]);
      try { if (!existsSync(originalPath)) renameSync(pendingPath, originalPath); else unlinkSync(pendingPath); } catch {}
    } else if (temporaryMatch) { try { unlinkSync(pendingPath); } catch {} }
  }
  const localFiles = automaticBackupFileList();
  if (!localFiles.length) {
    const fileName = `arsheefna-auto-${localDateKey()}.arshbackup`;
    writeBackupAtomically(AUTO_BACKUPS, fileName, makeBackup());
    localFiles.push(fileName);
    pruneAutomaticBackups();
  }
  let copied = 0;
  for (const fileName of localFiles.slice(0, 3)) {
    const source = join(AUTO_BACKUPS, fileName);
    const target = join(directory, fileName);
    if (existsSync(target) && statSync(target).size === statSync(source).size) continue;
    const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    const previous = join(directory, `.${fileName}.${randomUUID()}.previous.tmp`);
    let previousMoved = false;
    try {
      copyFileSync(source, temporary);
      if (existsSync(target)) { renameSync(target, previous); previousMoved = true; }
      renameSync(temporary, target);
      if (previousMoved) unlinkSync(previous);
      copied += 1;
    } catch (error) {
      if (previousMoved && existsSync(previous) && !existsSync(target)) { try { renameSync(previous, target); } catch {} }
      throw error;
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    }
  }
  pruneAutomaticBackups(directory);
  externalBackupError = '';
  return { copied, ...externalBackupStatus() };
}
function safetyBackupFileList() {
  if (!existsSync(AUTO_BACKUPS)) return [];
  return readdirSync(AUTO_BACKUPS)
    .filter(name => /^arsheefna-before-restore-\d{8}-\d{6}-[a-f0-9]{8}\.arshbackup$/i.test(name))
    .sort((a, b) => b.localeCompare(a));
}
function writeBackupAtomically(directory, fileName, contents) {
  mkdirSync(directory, { recursive: true });
  const targetPath = join(directory, fileName);
  const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx' });
    renameSync(temporaryPath, targetPath);
  } finally {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch {}
  }
  return targetPath;
}
function maybeCreateAutomaticBackup() {
  try {
    if (!Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n)) return;
    mkdirSync(AUTO_BACKUPS, { recursive: true });
    migrateLegacyAutomaticBackup();
    const fileName = `arsheefna-auto-${localDateKey()}.arshbackup`;
    const targetPath = join(AUTO_BACKUPS, fileName);
    if (!existsSync(targetPath)) {
      writeBackupAtomically(AUTO_BACKUPS, fileName, makeBackup());
      try { logEvent('نسخة احتياطية تلقائية', null, null, fileName); } catch {}
    }
    pruneAutomaticBackups();
    automaticBackupError = '';
    if (String(process.env.ARCHIVE_EXTERNAL_BACKUP_DIR || '').trim()) {
      try { syncExternalBackups(); }
      catch (error) {
        externalBackupError = externalBackupErrorMessage(error);
        console.error(`[${new Date().toISOString()}] تعذرت مزامنة النسخة الخارجية:`, error);
      }
    }
  } catch (error) {
    automaticBackupError = 'تعذر إنشاء النسخة التلقائية. أنشئ نسخة يدوية وتأكد من وجود مساحة كافية.';
    console.error(`[${new Date().toISOString()}] تعذر إنشاء النسخة التلقائية:`, error);
  }
}

function restoreBackup(archive) {
  const entries = unzipArchive(archive);
  const manifestBytes = entries.get('manifest.json'); const databaseBytes = entries.get('archive.sqlite');
  let manifest;
  try { manifest = JSON.parse(manifestBytes?.toString('utf8') || 'null'); }
  catch { throw Object.assign(new Error('ملف النسخة الاحتياطية لا يحتوي على معلومات صحيحة.'), { status: 400 }); }
  if (manifest?.format !== 'arsheefna-backup-v1' || !databaseBytes) throw Object.assign(new Error('هذا الملف ليس نسخة احتياطية صادرة من أرشيفنا.'), { status: 400 });
  const fileEntries = [];
  for (const [name, bytes] of entries) {
    if (name === 'manifest.json' || name === 'archive.sqlite') continue;
    const match = /^files\/([0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx))$/i.exec(name);
    if (!match) throw Object.assign(new Error('النسخة الاحتياطية تحتوي على مسار ملف غير مسموح.'), { status: 400 });
    fileEntries.push([match[1], bytes]);
  }

  const id = randomUUID(); const stageRoot = join(DATA, `.restore-new-${id}`); const rollbackRoot = join(DATA, `.restore-old-${id}`);
  const stagedDb = join(stageRoot, 'archive.sqlite'); const stagedFiles = join(stageRoot, 'files');
  let documentCount = 0; let checkDb;
  try {
    mkdirSync(stagedFiles, { recursive: true }); writeFileSync(stagedDb, databaseBytes, { flag: 'wx' });
    for (const [name, bytes] of fileEntries) writeFileSync(join(stagedFiles, name), bytes, { flag: 'wx' });
    checkDb = new DatabaseSync(stagedDb, { readOnly: true });
    const integrity = checkDb.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') throw Object.assign(new Error('قاعدة البيانات داخل النسخة الاحتياطية غير سليمة.'), { status: 400 });
    const tables = new Set(checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!['users', 'documents', 'audit_log'].every(name => tables.has(name))) throw Object.assign(new Error('النسخة الاحتياطية لا تحتوي على جداول الأرشيف المطلوبة.'), { status: 400 });
    if (checkDb.prepare('PRAGMA foreign_key_check').all().length) throw Object.assign(new Error('توجد روابط داخلية غير سليمة في قاعدة بيانات النسخة الاحتياطية.'), { status: 400 });
    if (Number(checkDb.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n) < 1) throw Object.assign(new Error('لا يوجد حساب مدير فعال داخل النسخة الاحتياطية.'), { status: 400 });
    const documents = checkDb.prepare('SELECT file_storage FROM documents').all(); documentCount = documents.length;
    for (const row of documents) {
      if (typeof row.file_storage !== 'string' || !/^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx)$/i.test(row.file_storage) || !existsSync(join(stagedFiles, row.file_storage))) throw Object.assign(new Error('النسخة الاحتياطية ناقصة: أحد ملفات الكتب غير موجود أو اسمه غير صالح.'), { status: 400 });
    }
  } catch (error) {
    try { checkDb?.close(); } catch {}
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    if (!error.status) error.status = 400;
    throw error;
  }
  checkDb.close();

  let safetyName = '';
  try {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    safetyName = `arsheefna-before-restore-${stamp}-${randomUUID().slice(0, 8)}.arshbackup`;
    const currentBackup = makeBackup();
    verifyBackupArchive(currentBackup);
    writeBackupAtomically(AUTO_BACKUPS, safetyName, currentBackup);
    for (const oldName of safetyBackupFileList().slice(5)) {
      try { unlinkSync(join(AUTO_BACKUPS, oldName)); } catch {}
    }
  } catch (error) {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    throw Object.assign(new Error('ما تمت الاستعادة لأن البرنامج لم يتمكن من حفظ نسخة أمان من الأرشيف الحالي. لم يغيّر الأرشيف؛ تأكد من وجود مساحة كافية ثم أعد المحاولة.'), { status: 409 });
  }

  const movedOld = []; const movedNew = [];
  const liveDb = join(DATA, 'archive.sqlite'); const liveFiles = FILES;
  const oldDbParts = ['archive.sqlite', 'archive.sqlite-wal', 'archive.sqlite-shm'];
  mkdirSync(rollbackRoot, { recursive: true });
  try {
    db.close(); sessions.clear();
    for (const name of oldDbParts) {
      const source = join(DATA, name); const destination = join(rollbackRoot, name);
      if (existsSync(source)) { renameSync(source, destination); movedOld.push([destination, source]); }
    }
    if (existsSync(liveFiles)) { const previousFiles = join(rollbackRoot, 'files'); renameSync(liveFiles, previousFiles); movedOld.push([previousFiles, liveFiles]); }
    renameSync(stagedDb, liveDb); movedNew.push(liveDb);
    renameSync(stagedFiles, liveFiles); movedNew.push(liveFiles);
    db = openDatabase();
    try { logEvent('استعادة نسخة احتياطية', null, null, `${documentCount} وثيقة`); } catch {}
  } catch (error) {
    for (const path of movedNew.reverse()) { try { rmSync(path, { recursive: true, force: true }); } catch {} }
    for (const [source, destination] of movedOld.reverse()) { try { if (existsSync(source)) renameSync(source, destination); } catch {} }
    try { db = openDatabase(); } catch {}
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }
  try { rmSync(stageRoot, { recursive: true, force: true }); } catch {}
  try { rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
  return { documentCount, safetyName };
}

function verifyBackupArchive(archive) {
  const entries = unzipArchive(archive);
  let manifest;
  try { manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') || 'null'); }
  catch { throw Object.assign(new Error('معلومات النسخة الاحتياطية غير مقروءة.'), { status: 400 }); }
  const databaseBytes = entries.get('archive.sqlite');
  if (manifest?.format !== 'arsheefna-backup-v1' || !databaseBytes) throw Object.assign(new Error('الملف المحدد ليس نسخة احتياطية صالحة من أرشيفنا.'), { status: 400 });

  const stagedPath = join(DATA, `.verify-${randomUUID()}.sqlite`);
  let checkDb;
  try {
    writeFileSync(stagedPath, databaseBytes, { flag: 'wx' });
    checkDb = new DatabaseSync(stagedPath, { readOnly: true });
    if (checkDb.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw Object.assign(new Error('قاعدة البيانات داخل النسخة غير سليمة.'), { status: 400 });
    const tables = new Set(checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!['users', 'documents', 'audit_log'].every(name => tables.has(name))) throw Object.assign(new Error('النسخة لا تحتوي على جداول الأرشيف المطلوبة.'), { status: 400 });
    if (!Number(checkDb.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n)) throw Object.assign(new Error('النسخة لا تحتوي على حساب مدير فعّال.'), { status: 400 });
    const foreignKeyProblems = checkDb.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyProblems.length) throw Object.assign(new Error('توجد روابط داخلية غير سليمة في قاعدة بيانات النسخة.'), { status: 400 });
    const allowedEntry = /^files\/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx)$/i;
    const fileEntries = [...entries.keys()].filter(name => name !== 'manifest.json' && name !== 'archive.sqlite');
    if (fileEntries.some(name => !allowedEntry.test(name))) throw Object.assign(new Error('النسخة تحتوي على ملف أو مسار غير معروف.'), { status: 400 });
    const documents = checkDb.prepare('SELECT file_storage FROM documents').all();
    for (const row of documents) {
      if (typeof row.file_storage !== 'string' || !/^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx)$/i.test(row.file_storage) || !entries.has(`files/${row.file_storage}`)) {
        throw Object.assign(new Error('النسخة ناقصة: ملف أحد الكتب غير موجود داخلها.'), { status: 400 });
      }
    }
    return { createdAt: manifest.createdAt || '', documentCount: documents.length, fileCount: fileEntries.length };
  } finally {
    try { checkDb?.close(); } catch {}
    try { unlinkSync(stagedPath); } catch {}
  }
}

async function runWiaScript(script, extraEnv = {}, timeout = 180000) {
  if (process.platform !== 'win32') throw Object.assign(new Error('المسح المباشر متوفر على ويندوز عند توصيل ماسح ضوئي متوافق.'), { status: 501 });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ...extraEnv }
    });
    return stdout.trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    throw Object.assign(new Error(`تعذر الاتصال بالماسح الضوئي. تأكد من تشغيله وتثبيت تعريفه${detail ? ` (${detail})` : ''}.`), { status: 503 });
  }
}

async function listWiaScanners() {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $m=New-Object -ComObject WIA.DeviceManager; $items=@(); foreach($i in $m.DeviceInfos){ if($i.Type -eq 1){ $n='ماسح ضوئي'; try{$n=[string]$i.Properties.Item('Name').Value}catch{}; $items += [pscustomobject]@{id=[string]$i.DeviceID;name=$n} } }; ConvertTo-Json -InputObject @($items) -Compress`;
  const output = await runWiaScript(script, {}, 30000);
  try { const value = JSON.parse(output || '[]'); return Array.isArray(value) ? value : [value]; }
  catch { throw Object.assign(new Error('تعذر قراءة قائمة الماسحات الضوئية.'), { status: 503 }); }
}

async function scanWiaDevice(deviceId) {
  const scanners = await listWiaScanners();
  if (!scanners.some(scanner => scanner.id === deviceId)) throw Object.assign(new Error('الماسح المحدد غير متصل. حدّث القائمة واختاره مرة ثانية.'), { status: 404 });
  const outputPath = join(tmpdir(), `arsheefna-scan-${randomUUID()}.jpg`);
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $m=New-Object -ComObject WIA.DeviceManager; $i=$m.DeviceInfos | Where-Object { $_.Type -eq 1 -and $_.DeviceID -eq $env:ARSHIFNA_DEVICE_ID } | Select-Object -First 1; if(-not $i){ throw 'Scanner not found' }; $d=$i.Connect(); $item=$d.Items.Item(1); $intent=$item.Properties.Item('6146'); $intent.Value=1; $dataType=$item.Properties.Item('4103'); $dataType.Value=3; if([int]$intent.Value -ne 1 -or [int]$dataType.Value -ne 3){ throw 'Could not set color scan mode' }; $xPos=$item.Properties.Item('6149'); $yPos=$item.Properties.Item('6150'); $xExtent=$item.Properties.Item('6151'); $yExtent=$item.Properties.Item('6152'); $xPos.Value=0; $yPos.Value=0; $xExtent.Value=[int]$xExtent.SubTypeMax; $yExtent.Value=[int]$yExtent.SubTypeMax; if([int]$xPos.Value -ne 0 -or [int]$yPos.Value -ne 0 -or [int]$xExtent.Value -le 0 -or [int]$yExtent.Value -le 0){ throw 'Could not set full-page scan area' }; $image=$item.Transfer('{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'); $image.SaveFile($env:ARSHIFNA_SCAN_OUTPUT); Write-Output 'ok'`;
  try {
    await runWiaScript(script, { ARSHIFNA_DEVICE_ID: deviceId, ARSHIFNA_SCAN_OUTPUT: outputPath }, 300000);
    const image = readFileSync(outputPath);
    if (!image.length || image.length > MAX_UPLOAD) throw Object.assign(new Error('حجم الصورة الناتجة من الماسح فارغ أو أكبر من 50 ميغابايت.'), { status: 413 });
    return image;
  } finally { try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {} }
}

async function handle(req, res) {
  const url = new URL(req.url, `${IS_TLS ? 'https' : 'http'}://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/setup-status') {
    json(res, 200, { needsSetup: Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) === 0 }); return;
  }
  if (req.method === 'POST' && path === '/api/setup') {
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) > 0) { fail(res, 409, 'تم إعداد النظام مسبقاً.'); return; }
    const body = await readJson(req);
    const fullName = cleanText(body.full_name, 120, 'الاسم');
    const username = cleanText(body.username, 50, 'اسم المستخدم').toLowerCase();
    const password = cleanText(body.password, 200, 'كلمة المرور');
    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) { fail(res, 400, 'اسم المستخدم يجب أن يتكون من 3 أحرف أو أرقام على الأقل.'); return; }
    if (password.length < 6) { fail(res, 400, 'كلمة مرور المدير يجب أن تكون 6 أحرف على الأقل.'); return; }
    const p = passwordHash(password);
    const result = db.prepare('INSERT INTO users(full_name,username,password_hash,role,active,created_at) VALUES(?,?,?,\'admin\',1,?)').run(fullName, username, `${p.salt}:${p.hash}`, now());
    const token = createSession(Number(result.lastInsertRowid));
    logEvent('إعداد النظام', Number(result.lastInsertRowid));
    json(res, 201, { ok: true }, { 'set-cookie': `archive_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${IS_TLS ? '; Secure' : ''}` }); return;
  }
  if (req.method === 'POST' && path === '/api/login') {
    const body = await readJson(req, 4096);
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const key = req.socket.remoteAddress || 'unknown';
    let limit = failedLogins.get(key);
    if (limit && limit.until <= Date.now()) { failedLogins.delete(key); limit = null; }
    if (limit && limit.until > Date.now() && limit.count >= 8) { fail(res, 429, 'محاولات كثيرة. حاول بعد 15 دقيقة.'); return; }
    const user = username.length <= 50 ? db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username) : null;
    const passwordOk = password.length <= 200 && passwordMatches(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!username || username.length > 50 || !user || !user.active || !passwordOk) {
      const current = limit || { count: 0, until: Date.now() + 15 * 60 * 1000 };
      current.count += 1; failedLogins.set(key, current);
      while (failedLogins.size > 256) failedLogins.delete(failedLogins.keys().next().value);
      fail(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة.'); return;
    }
    failedLogins.delete(key);
    const token = createSession(user.id);
    logEvent('تسجيل دخول', user.id);
    json(res, 200, { ok: true }, { 'set-cookie': `archive_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${IS_TLS ? '; Secure' : ''}` }); return;
  }
  if (req.method === 'POST' && path === '/api/logout') {
    const user = currentUser(req); const token = getCookie(req, 'archive_session');
    if (token) sessions.delete(token);
    if (user) logEvent('تسجيل خروج', user.id);
    json(res, 200, { ok: true }, { 'set-cookie': `archive_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${IS_TLS ? '; Secure' : ''}` }); return;
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/styles.css' || path === '/app.js' || path === '/file-viewer.html' || path === '/file-viewer.mjs' || path === '/file-viewer.css')) {
    const name = path === '/' ? 'index.html' : path.slice(1);
    const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : /\.m?js$/.test(name) ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    const content = readFileSync(join(PUBLIC, name));
    res.writeHead(200, { 'content-type': type, 'content-length': content.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" });
    res.end(content); return;
  }
  if (req.method === 'GET' && path.startsWith('/ocr/')) {
    let parts;
    try { parts = decodeURIComponent(path.slice(1)).split('/'); } catch { fail(res, 404, 'الملف غير موجود.'); return; }
    if (parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) { fail(res, 404, 'الملف غير موجود.'); return; }
    const assetPath = resolve(PUBLIC, ...parts);
    const ocrRoot = resolve(PUBLIC, 'ocr');
    const assetRelative = relative(ocrRoot, assetPath);
    if (!assetRelative || assetRelative.startsWith('..') || !existsSync(assetPath) || !statSync(assetPath).isFile()) { fail(res, 404, 'الملف غير موجود.'); return; }
    const content = readFileSync(assetPath); const extension = extname(assetPath).toLowerCase();
    const type = extension === '.mjs' || extension === '.js' ? 'text/javascript; charset=utf-8' : extension === '.wasm' ? 'application/wasm' : extension === '.gz' ? 'application/gzip' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': content.length, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" });
    res.end(content); return;
  }

  const user = requireUser(req, res);
  if (!user) return;
  const required = requiredRoutePermissions(req.method, path);
  if (required === null) { fail(res, 404, 'الصفحة المطلوبة غير موجودة.'); return; }
  if (required.length && !required.some(permission => hasPermission(user, permission))) {
    fail(res, 403, 'حسابك لا يملك الصلاحية المطلوبة لهذا الإجراء.'); return;
  }
  if (req.method === 'GET' && path === '/api/me') { json(res, 200, { user }); return; }
  if (req.method === 'GET' && path === '/api/network/status') {
    if (!requireAdmin(user, res)) return;
    json(res, 200, { enabled: LAN_ENABLED, port: PORT, urls: LAN_ADDRESSES.map(address => `${IS_TLS ? 'https' : 'http'}://${address}:${PORT}`) }); return;
  }

  if (req.method === 'GET' && path === '/api/scanners') {
    json(res, 200, { scanners: await listWiaScanners() }); return;
  }
  if (req.method === 'POST' && path === '/api/scanners/scan') {
    const body = await readJson(req); const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 500) : '';
    if (!deviceId) { fail(res, 400, 'اختار الماسح الضوئي أولاً.'); return; }
    const image = await scanWiaDevice(deviceId);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': image.length, 'content-disposition': 'inline; filename=scan.jpg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(image); return;
  }

  if (req.method === 'GET' && path === '/api/backup-status') {
    const files = automaticBackupFileList();
    const safetyFiles = safetyBackupFileList();
    const latest = files[0] || null;
    const latestDate = latest ? localDateKey(statSync(join(AUTO_BACKUPS, latest)).mtime) : null;
    json(res, 200, { count: files.length, latest, latestDate, keep: 3, safetyLatest: safetyFiles[0] || null, safetyCount: safetyFiles.length, safetyKeep: 5, error: automaticBackupError }); return;
  }
  if (req.method === 'GET' && path === '/api/backup/external/status') {
    json(res, 200, externalBackupStatus()); return;
  }
  if (req.method === 'POST' && path === '/api/backup/external/sync') {
    try {
      const result = syncExternalBackups();
      logEvent('مزامنة نسخة احتياطية خارجية', user.id, null, `${result.copied} ملف · ${result.directory}`);
      json(res, 200, result);
    } catch (error) {
      externalBackupError = externalBackupErrorMessage(error);
      throw Object.assign(new Error(externalBackupError), { status: error.status || 503 });
    }
    return;
  }
  if (req.method === 'POST' && path === '/api/backup/verify-upload') {
    const backup = await readBody(req, MAX_BACKUP);
    if (!backup.length) { fail(res, 400, 'اختر ملف النسخة الاحتياطية أولاً.'); return; }
    const result = verifyBackupArchive(backup);
    logEvent('التحقق من نسخة احتياطية مختارة', user.id, null, `${result.documentCount} وثيقة · ${result.fileCount} ملف`);
    json(res, 200, { ok: true, ...result }); return;
  }
  if (req.method === 'GET' && path === '/api/backup/automatic/verify') {
    const latest = automaticBackupFileList()[0];
    if (!latest) { fail(res, 404, 'ماكو نسخة تلقائية للتحقق منها حالياً.'); return; }
    const result = verifyBackupArchive(readFileSync(join(AUTO_BACKUPS, latest)));
    logEvent('التحقق من نسخة احتياطية', user.id, null, `${latest} · ${result.documentCount} وثيقة`);
    json(res, 200, { ok: true, file: latest, ...result }); return;
  }
  if (req.method === 'GET' && path === '/api/backup/automatic/latest') {
    const latest = automaticBackupFileList()[0];
    if (!latest) { fail(res, 404, 'ماكو نسخة تلقائية بعد. راح ينشئها البرنامج عند التشغيل القادم.'); return; }
    const backup = readFileSync(join(AUTO_BACKUPS, latest));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': backup.length, 'content-disposition': `attachment; filename="${latest}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(backup); return;
  }
  if (req.method === 'GET' && path === '/api/backup/safety/latest') {
    const latest = safetyBackupFileList()[0];
    if (!latest) { fail(res, 404, 'ماكو نسخة ما قبل استعادة سابقة.'); return; }
    const backup = readFileSync(join(AUTO_BACKUPS, latest));
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': backup.length, 'content-disposition': `attachment; filename="${latest}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(backup); return;
  }
  if (req.method === 'GET' && path === '/api/backup') {
    const backup = makeBackup();
    logEvent('إنشاء نسخة احتياطية', user.id, null, `${backup.length} bytes`);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': backup.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`أرشيفنا-${new Date().toISOString().slice(0, 10)}.arshbackup`)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(backup); return;
  }
  if (req.method === 'GET' && path === '/api/backup/excel-periods') {
    const years = db.prepare('SELECT DISTINCT substr(doc_date,1,4) AS year FROM documents WHERE deleted_at IS NULL ORDER BY year DESC').all().map(row => row.year).filter(year => /^[1-9]\d{3}$/.test(year));
    json(res, 200, { years }); return;
  }
  if (req.method === 'GET' && path === '/api/backup/excel-source') {
    const documents = db.prepare('SELECT id,archive_no,file_original,file_size FROM documents WHERE deleted_at IS NULL ORDER BY doc_date DESC,created_at DESC').all();
    json(res, 200, { documents }); return;
  }
  if (req.method === 'POST' && path === '/api/backup.xlsx') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['excel', 'images'].includes(body.output)) { fail(res, 400, 'نوع ملف التصدير غير صالح.'); return; }
    const output = body.output === 'images' ? 'images' : 'excel';
    const period = excelBackupPeriod(body);
    const documents = db.prepare(`SELECT d.*,u.full_name AS created_by_name FROM documents d JOIN users u ON u.id=d.created_by WHERE ${period.conditions.join(' AND ')} ORDER BY d.doc_date DESC,d.created_at DESC`).all(...period.params);
    if (period.year && !documents.length) { fail(res, 404, 'ماكو كتب ضمن السنة والأشهر المحددة.'); return; }
    const documentById = new Map(documents.map(doc => [doc.id, doc]));
    const imagePathById = new Map(); const imageEntries = []; let attachmentBytes = 0;
    for (const doc of documents) {
      if (!/^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx)$/i.test(doc.file_storage || '')) continue;
      const sourcePath = join(FILES, doc.file_storage);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) continue;
      const extension = extname(doc.file_storage).toLowerCase();
      const imageName = `${String(doc.archive_no || doc.id).replace(/[^A-Za-z0-9_-]/g, '_')}${extension}`;
      const imagePath = `صور الكتب/${imageName}`;
      imagePathById.set(doc.id, imagePath);
      if (output === 'images') {
        const fileData = readFileSync(sourcePath);
        attachmentBytes += fileData.length;
        if (attachmentBytes > MAX_BACKUP) { fail(res, 413, 'حجم ملفات الكتب أكبر من الحد المسموح لتنزيلها دفعة واحدة.'); return; }
        imageEntries.push({ name: imageName, data: fileData });
      }
    }
    if (output === 'images') {
      if (!imageEntries.length) { fail(res, 404, 'ماكو ملفات كتب قابلة للتصدير.'); return; }
      const bundle = zipArchive(imageEntries);
      logEvent('تنزيل ملفات الكتب المرتبطة بـ Excel', user.id, null, `${period.label} · ${imageEntries.length} ملف · ${attachmentBytes} bytes`);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bundle.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('صور الكتب.zip')}`, 'x-archive-file-count': String(imageEntries.length), 'x-archive-document-count': String(documents.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(bundle); return;
    }
    const fileLinkFormula = id => imagePathById.has(id) ? `HYPERLINK("${imagePathById.get(id)}","فتح الكتاب")` : null;
    const documentsFormulas = documents.flatMap((doc, index) => fileLinkFormula(doc.id) ? [{ cell: `C${index + 2}`, formula: fileLinkFormula(doc.id) }] : []);
    const imageIndexFormulas = documents.flatMap((doc, index) => fileLinkFormula(doc.id) ? [{ cell: `D${index + 2}`, formula: fileLinkFormula(doc.id) }] : []);
    const activities = db.prepare(`SELECT a.*,d.archive_no,d.doc_number,d.title,u.full_name FROM document_activity a JOIN documents d ON d.id=a.doc_id LEFT JOIN users u ON u.id=a.user_id WHERE ${period.conditions.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC`).all(...period.params);
    const relations = db.prepare(`SELECT r.created_at, a.id AS id_a,a.archive_no AS archive_no_a,a.doc_number AS doc_number_a,a.title AS title_a,b.id AS id_b,b.archive_no AS archive_no_b,b.doc_number AS doc_number_b,b.title AS title_b
      FROM document_relations r JOIN documents a ON a.id=r.doc_a JOIN documents b ON b.id=r.doc_b WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL ORDER BY r.created_at DESC`).all().filter(item => documentById.has(item.id_a) && documentById.has(item.id_b));
    const relationFormulas = [];
    relations.forEach((item, index) => {
      const row = index + 2;
      const linkA = fileLinkFormula(item.id_a); const linkB = fileLinkFormula(item.id_b);
      if (linkA) relationFormulas.push({ cell: `C${row}`, formula: linkA });
      if (linkB) relationFormulas.push({ cell: `H${row}`, formula: linkB });
    });
    const activityFormulas = activities.flatMap((item, index) => fileLinkFormula(item.doc_id) ? [{ cell: `C${index + 2}`, formula: fileLinkFormula(item.doc_id) }] : []);
    const movements = db.prepare('SELECT l.*,u.full_name FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC,l.id DESC').all().filter(item => !period.year || documentById.has(item.doc_id));
    const workbook = createExcelWorkbook([
      { name: 'اقرأني', headers: ['معلومة', 'تفاصيل'], rows: [
        ['تاريخ إنشاء النسخة', now()],
        ['نطاق التصدير حسب تاريخ الكتاب', period.label],
        ['عدد الوثائق', String(documents.length)],
        ['ملف Excel', 'يتضمن بيانات الكتب والمتابعات والروابط وسجل الحركة.'],
        ['مجلد الكتب', 'توجد الملفات الأصلية داخل مجلد «صور الكتب» بجانب ملف Excel.'],
        ['الروابط', 'اضغط «فتح الكتاب» في Excel لفتح الملف الأصلي كاملاً. اترك Excel ومجلد صور الكتب في المكان نفسه.'],
        ['ملفات PDF', 'يحتوي مجلد صور الكتب على ملف PDF الأصلي بكل صفحاته، وليس صورة معاينة فقط.']
      ] },
      { name: 'الوثائق', headers: ['معرف الوثيقة', 'رقم الأرشيف', 'ملف الكتاب', 'العنوان / الموضوع', 'رقم الكتاب', 'تاريخ الكتاب', 'موعد المتابعة', 'النوع', 'التصنيف', 'الحالة', 'الجهة المرسلة', 'الجهة المستلمة', 'القسم', 'الملاحظات', 'اسم الملف الأصلي', 'اسم الملف بالنظام', 'حجم الملف بالبايت', 'أضيف بواسطة', 'تاريخ الإضافة', 'آخر تعديل', 'مؤرشف'], rows: documents.map(doc => [doc.id, doc.archive_no, imagePathById.has(doc.id) ? 'فتح الكتاب' : 'غير متاح', doc.title, doc.doc_number, doc.doc_date, doc.due_date || '', typeLabel(doc.doc_type), doc.category, statusLabel(doc.status), doc.sender, doc.recipient, doc.department, doc.notes, doc.file_original, doc.file_storage, doc.file_size, doc.created_by_name, doc.created_at, doc.updated_at, doc.archived ? 'نعم' : 'لا']), formulas: documentsFormulas },
      { name: 'دليل الملفات', headers: ['رقم الأرشيف', 'رقم الكتاب', 'العنوان / الموضوع', 'فتح الكتاب', 'اسم الملف', 'حالة الملف'], rows: documents.map(doc => [doc.archive_no, doc.doc_number, doc.title, imagePathById.has(doc.id) ? 'فتح الكتاب' : 'غير متاح', imagePathById.get(doc.id) || '', imagePathById.has(doc.id) ? 'متاح' : 'الملف غير موجود']), formulas: imageIndexFormulas },
      { name: 'المتابعة', headers: ['معرف الوثيقة', 'رقم الأرشيف', 'ملف الكتاب', 'رقم الكتاب', 'العنوان / الموضوع', 'الإجراء', 'التفاصيل', 'الموظف', 'التاريخ والوقت'], rows: activities.map(item => [item.doc_id, item.archive_no, imagePathById.has(item.doc_id) ? 'فتح الكتاب' : 'غير متاح', item.doc_number, item.title, item.event, item.details, item.full_name || 'النظام', item.created_at]), formulas: activityFormulas },
      { name: 'الكتب المرتبطة', headers: ['معرف الكتاب الأول', 'رقم أرشيف الأول', 'ملف الأول', 'رقم الكتاب الأول', 'عنوان الأول', 'معرف الكتاب الثاني', 'رقم أرشيف الثاني', 'ملف الثاني', 'رقم الكتاب الثاني', 'عنوان الثاني', 'تاريخ الربط'], rows: relations.map(item => [item.id_a, item.archive_no_a, imagePathById.has(item.id_a) ? 'فتح الكتاب' : 'غير متاح', item.doc_number_a, item.title_a, item.id_b, item.archive_no_b, imagePathById.has(item.id_b) ? 'فتح الكتاب' : 'غير متاح', item.doc_number_b, item.title_b, item.created_at]), formulas: relationFormulas },
      { name: 'حركة النظام', headers: ['الإجراء', 'معرف الوثيقة', 'رقم الأرشيف', 'الموظف', 'التفاصيل', 'التاريخ والوقت'], rows: movements.map(item => [item.event, item.doc_id || '', documentById.get(item.doc_id)?.archive_no || '', item.full_name || 'النظام', item.details, item.created_at]) }
    ]);
    logEvent('تنزيل نسخة Excel للكتب', user.id, null, `${period.label} · ${documents.length} وثيقة · ${imagePathById.size} رابط ملف · ${activities.length} متابعة`);
    const periodSuffix = period.year ? `-${period.year}-${period.months.map(month => String(month).padStart(2, '0')).join('-')}` : '';
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-length': workbook.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`أرشيفنا-بيانات-الكتب${periodSuffix}-${new Date().toISOString().slice(0, 10)}.xlsx`)}`, 'x-archive-file-count': String(imagePathById.size), 'x-archive-document-count': String(documents.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(workbook); return;
  }
  if (req.method === 'POST' && path === '/api/restore') {
    const backup = await readBody(req, MAX_BACKUP);
    if (!backup.length) { fail(res, 400, 'اختر ملف النسخة الاحتياطية أولاً.'); return; }
    const result = restoreBackup(backup);
    json(res, 200, { ok: true, ...result }, { 'set-cookie': `archive_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${IS_TLS ? '; Secure' : ''}` }); return;
  }

  if (req.method === 'GET' && path === '/api/summary') {
    const total = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL').get().n;
    const byType = db.prepare('SELECT doc_type, COUNT(*) AS n FROM documents WHERE deleted_at IS NULL GROUP BY doc_type').all();
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND substr(doc_date,1,7)=?').get(month).n;
    json(res, 200, { total, thisMonth, byType: Object.fromEntries(byType.map(x => [x.doc_type, x.n])) }); return;
  }
  if (req.method === 'GET' && path === '/api/trash') {
    const rows = db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC,d.created_at DESC LIMIT 1000`).all();
    json(res, 200, { documents: rows.map(row => ({ ...publicDoc(row), deleted_at: row.deleted_at })), truncated: rows.length === 1000 }); return;
  }
  const trashMatch = /^\/api\/trash\/([0-9a-f-]+)(?:\/(restore))?$/i.exec(path);
  if (trashMatch && req.method === 'POST' && trashMatch[2] === 'restore') {
    const id = trashMatch[1]; const row = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(id);
    if (!row) { fail(res, 404, 'الوثيقة غير موجودة في سلة المحذوفات.'); return; }
    db.prepare('UPDATE documents SET deleted_at=NULL,updated_at=? WHERE id=?').run(now(), id);
    logEvent('استعادة وثيقة من سلة المحذوفات', user.id, id, `${row.doc_number} — ${row.title}`);
    logDocumentActivity(id, user.id, 'استعادة من سلة المحذوفات', row.doc_number);
    json(res, 200, { ok: true }); return;
  }
  if (trashMatch && req.method === 'DELETE' && !trashMatch[2]) {
    const id = trashMatch[1]; const row = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NOT NULL').get(id);
    if (!row) { fail(res, 404, 'الوثيقة غير موجودة في سلة المحذوفات.'); return; }
    const storedName = basename(row.file_storage || '');
    if (storedName !== row.file_storage || !/^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|doc|docx|xls|xlsx)$/i.test(storedName)) { fail(res, 500, 'مسار ملف الوثيقة غير صالح؛ لم يتم حذف شيء.'); return; }
    const filePath = join(FILES, storedName);
    const stagedPath = join(FILES, `.${storedName}.delete-${randomUUID()}.tmp`);
    let staged = false;
    if (existsSync(filePath)) { renameSync(filePath, stagedPath); staged = true; }
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare('DELETE FROM documents WHERE id=? AND deleted_at IS NOT NULL').run(id);
      if (!Number(result.changes)) throw Object.assign(new Error('الوثيقة غير موجودة في سلة المحذوفات.'), { status: 404 });
      logEvent('حذف نهائي لوثيقة من سلة المحذوفات', user.id, id, `${row.doc_number} — ${row.title}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (staged) { try { renameSync(stagedPath, filePath); } catch {} }
      throw error;
    }
    let fileCleanupPending = false;
    if (staged) { try { unlinkSync(stagedPath); } catch { fileCleanupPending = true; } }
    json(res, 200, { ok: true, fileCleanupPending }); return;
  }
  if (req.method === 'GET' && path === '/api/reminders') {
    const today = localDateKey(); const weekDate = new Date(); weekDate.setDate(weekDate.getDate() + 7);
    const week = localDateKey(weekDate);
    const select = `${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.archived=0 AND d.status<>'completed' AND d.due_date IS NOT NULL AND d.due_date<>''`;
    const overdue = db.prepare(`${select} AND d.due_date<? ORDER BY d.due_date ASC, d.doc_date DESC LIMIT 500`).all(today).map(publicDoc);
    const upcoming = db.prepare(`${select} AND d.due_date>=? AND d.due_date<=? ORDER BY d.due_date ASC, d.doc_date DESC LIMIT 500`).all(today, week).map(publicDoc);
    json(res, 200, { today, overdue, upcoming }); return;
  }
  if (req.method === 'GET' && path === '/api/documents/lookup') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120); const exclude = url.searchParams.get('exclude') || '';
    const rows = q
      ? db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.archived=0 AND d.id<>? AND (d.title LIKE ? OR d.doc_number LIKE ? OR d.doc_date LIKE ?) ORDER BY d.doc_date DESC,d.created_at DESC LIMIT 100`).all(exclude, ...Array(3).fill(`%${q}%`))
      : db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.archived=0 AND d.id<>? ORDER BY d.doc_date DESC,d.created_at DESC LIMIT 100`).all(exclude);
    json(res, 200, { documents: rows.map(publicDoc) }); return;
  }
  const relationMatch = /^\/api\/documents\/([0-9a-f-]+)\/relations$/i.exec(path);
  if (relationMatch && req.method === 'GET') {
    const id = relationMatch[1];
    if (!db.prepare('SELECT 1 FROM documents WHERE id=? AND deleted_at IS NULL').get(id)) { fail(res, 404, 'الوثيقة غير موجودة.'); return; }
    const related = db.prepare(`${DOC_SELECT} WHERE d.deleted_at IS NULL AND d.id IN (SELECT CASE WHEN doc_a=? THEN doc_b ELSE doc_a END FROM document_relations WHERE doc_a=? OR doc_b=?) ORDER BY d.doc_date DESC,d.created_at DESC`).all(id, id, id).map(publicDoc);
    json(res, 200, { related }); return;
  }
  if (relationMatch && req.method === 'PUT') {
    const id = relationMatch[1];
    if (!db.prepare('SELECT 1 FROM documents WHERE id=? AND deleted_at IS NULL').get(id)) { fail(res, 404, 'الوثيقة غير موجودة.'); return; }
    const body = await readJson(req); const ids = body.related_ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(value => typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value) || value === id)) { fail(res, 400, 'قائمة الكتب المرتبطة غير صالحة.'); return; }
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length) {
      const placeholders = uniqueIds.map(() => '?').join(',');
      const found = db.prepare(`SELECT id FROM documents WHERE deleted_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
      if (found.length !== uniqueIds.length) { fail(res, 400, 'أحد الكتب المختارة غير موجود.'); return; }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM document_relations WHERE doc_a=? OR doc_b=?').run(id, id);
      const insert = db.prepare('INSERT INTO document_relations(doc_a,doc_b,created_at) VALUES(?,?,?)');
      for (const other of uniqueIds) { const [a, b] = [id, other].sort(); insert.run(a, b, now()); }
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    logEvent('تحديث الكتب المرتبطة', user.id, id, `${uniqueIds.length} كتاب`);
    logDocumentActivity(id, user.id, 'تحديث الكتب المرتبطة', `عدد الكتب المرتبطة: ${uniqueIds.length}`);
    json(res, 200, { ok: true, count: uniqueIds.length }); return;
  }
  const activityMatch = /^\/api\/documents\/([0-9a-f-]+)\/activity$/i.exec(path);
  if (activityMatch && (req.method === 'GET' || req.method === 'POST')) {
    const id = activityMatch[1];
    if (!db.prepare('SELECT 1 FROM documents WHERE id=? AND deleted_at IS NULL').get(id)) { fail(res, 404, 'الوثيقة غير موجودة.'); return; }
    if (req.method === 'GET') {
      const events = db.prepare(`SELECT a.id,a.event,a.details,a.created_at,u.full_name FROM document_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.doc_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 200`).all(id);
      json(res, 200, { events }); return;
    }
    const body = await readJson(req); const details = cleanText(body.details, 3000, 'تفاصيل المتابعة');
    logDocumentActivity(id, user.id, 'متابعة', details);
    logEvent('تسجيل متابعة وثيقة', user.id, id, details.slice(0, 500));
    json(res, 201, { ok: true }); return;
  }
  if (req.method === 'GET' && path === '/api/documents/duplicate') {
    const number = (url.searchParams.get('number') || '').trim().slice(0, 100);
    const year = (url.searchParams.get('year') || '').trim(); const exclude = url.searchParams.get('exclude') || '';
    if (!number || !/^\d{4}$/.test(year)) { json(res, 200, { duplicates: [] }); return; }
    const normalized = normalizeDocNumber(number);
    const duplicates = db.prepare(`SELECT id,title,doc_number,doc_date FROM documents WHERE deleted_at IS NULL AND substr(doc_date,1,4)=? AND id<>? ORDER BY doc_date DESC`).all(year, exclude).filter(row => normalizeDocNumber(row.doc_number) === normalized).slice(0, 5);
    json(res, 200, { duplicates }); return;
  }
  if (req.method === 'GET' && (path === '/api/documents' || path === '/api/export.xlsx')) {
    const { conditions, params } = documentFilters(url);
    const recent = path === '/api/documents' && url.searchParams.get('recent') === '1';
    const order = recent ? 'd.created_at DESC, d.rowid DESC' : 'd.doc_date DESC, d.created_at DESC';
    const limit = path === '/api/documents' ? (recent ? ' LIMIT 10' : ' LIMIT 500') : '';
    const rows = db.prepare(`${DOC_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY ${order}${limit}`).all(...params);
    if (path === '/api/export.xlsx') {
      const workbook = createExcelFile(rows);
      logEvent('تصدير تقرير Excel', user.id, null, `${rows.length} وثيقة`);
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-length': workbook.length, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`تقرير-أرشيفنا-${new Date().toISOString().slice(0, 10)}.xlsx`)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(workbook); return;
    }
    json(res, 200, { documents: rows.map(publicDoc), truncated: !recent && rows.length === 500 }); return;
  }
  if (req.method === 'POST' && path === '/api/documents') {
    if (activeUploads >= MAX_ACTIVE_UPLOADS) { fail(res, 429, 'السيرفر يستقبل حالياً ملفاً آخر. انتظر قليلاً ثم أعد المحاولة.'); return; }
    activeUploads += 1;
    try {
      const body = await readBody(req, MAX_UPLOAD + 1024 * 1024);
      const { fields, file } = parseMultipart(body, req.headers['content-type']);
      if (!file) { fail(res, 400, 'أرفق ملف الوثيقة قبل الحفظ.'); return; }
      const original = safeOriginalName(file.filename);
      const ext = extname(original).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) { fail(res, 400, 'الصيغ المسموحة: PDF وWord وExcel والصور JPG وPNG.'); return; }
      if (!file.content.length || file.content.length > MAX_UPLOAD) { fail(res, 413, 'حجم الملف فارغ أو يتجاوز 50 ميغابايت.'); return; }
      const doc = validateDoc(fields); doc.id = randomUUID();
      const storage = `${doc.id}${ext}`; const finalPath = join(FILES, storage); const tempPath = `${finalPath}.tmp`;
      writeFileSync(tempPath, file.content, { flag: 'wx' }); renameSync(tempPath, finalPath);
      try { addDocRecord(doc, user, { original, mime: file.mime, content: file.content }, storage); }
      catch (error) { try { unlinkSync(finalPath); } catch {} throw error; }
      json(res, 201, { document: publicDoc(db.prepare(`${DOC_SELECT} WHERE d.id=?`).get(doc.id)) }); return;
    } finally { activeUploads -= 1; }
  }
  const docMatch = /^\/api\/documents\/([0-9a-f-]+)$/.exec(path);
  if (docMatch && req.method === 'DELETE') {
    const id = docMatch[1]; const existing = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NULL').get(id);
    if (!existing) { fail(res, 404, 'الوثيقة غير موجودة.'); return; }
    const deletedAt = now();
    db.prepare('UPDATE documents SET deleted_at=?,updated_at=? WHERE id=?').run(deletedAt, deletedAt, id);
    logEvent('نقل وثيقة إلى سلة المحذوفات', user.id, id, `${existing.doc_number} — ${existing.title}`);
    logDocumentActivity(id, user.id, 'نقل إلى سلة المحذوفات', existing.doc_number);
    json(res, 200, { ok: true }); return;
  }
  if (docMatch && req.method === 'PATCH') {
    const id = docMatch[1]; const body = await readJson(req); const existing = db.prepare('SELECT * FROM documents WHERE id=? AND deleted_at IS NULL').get(id);
    if (!existing) { fail(res, 404, 'الوثيقة غير موجودة.'); return; }
    if (body.archived !== undefined) {
        const archived = body.archived ? 1 : 0;
      db.prepare('UPDATE documents SET archived=?, updated_at=? WHERE id=?').run(archived, now(), id);
      logEvent(archived ? 'أرشفة وثيقة' : 'استعادة وثيقة', user.id, id, existing.doc_number);
      logDocumentActivity(id, user.id, archived ? 'نقل إلى الأرشيف' : 'استعادة من الأرشيف', existing.doc_number);
    } else {
      const doc = validateDoc(body);
      db.prepare('UPDATE documents SET title=?,doc_number=?,doc_date=?,due_date=?,doc_type=?,department=?,category=?,sender=?,recipient=?,status=?,notes=?,updated_at=? WHERE id=?').run(doc.title, doc.doc_number, doc.doc_date, doc.due_date, doc.doc_type, doc.department, doc.category, doc.sender, doc.recipient, doc.status, doc.notes, now(), id);
      logEvent('تعديل بيانات وثيقة', user.id, id, `${doc.doc_number} — ${doc.title}`);
      if (existing.status !== doc.status) logDocumentActivity(id, user.id, 'تغيير حالة المعاملة', `من «${statusLabel(existing.status)}» إلى «${statusLabel(doc.status)}»`);
    }
    json(res, 200, { ok: true }); return;
  }
  const fileMatch = /^\/api\/files\/([0-9a-f-]+)$/.exec(path);
  if (fileMatch && req.method === 'GET') {
    const row = db.prepare('SELECT id,file_storage,file_original,mime_type,file_size,deleted_at FROM documents WHERE id=?').get(fileMatch[1]);
    if (!row) { fail(res, 404, 'الملف غير موجود.'); return; }
    if (row.deleted_at && !hasPermission(user, 'trash.manage')) { fail(res, 404, 'الملف غير موجود.'); return; }
    const filepath = join(FILES, row.file_storage);
    if (!existsSync(filepath)) { fail(res, 404, 'ملف الوثيقة غير موجود على السيرفر.'); return; }
    const safeName = encodeURIComponent(row.file_original).replace(/['()]/g, escape);
    const ext = extname(row.file_storage).toLowerCase();
    const previewTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
    const inline = url.searchParams.get('view') === '1' && previewTypes[ext];
    res.writeHead(200, { 'content-type': inline ? previewTypes[ext] : (DOWNLOAD_MIME.get(ext) || 'application/octet-stream'), 'content-length': row.file_size, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const { createReadStream } = await import('node:fs'); createReadStream(filepath).pipe(res);
    logEvent(inline ? 'معاينة ملف' : 'تنزيل ملف', user.id, row.id, row.file_original); return;
  }
  if (req.method === 'GET' && path === '/api/users') {
    const users = db.prepare('SELECT id,full_name,username,role,active,created_at,permissions FROM users ORDER BY full_name').all();
    json(res, 200, { users: users.map(target => ({ ...publicUser(target), can_manage: canManageAccount(user, target) })) }); return;
  }
  if (req.method === 'POST' && path === '/api/users') {
    const body = accountBody(await readJson(req));
    const values = accountValues(body);
    assertAccountDelegation(user, null, values);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      const result = db.prepare('INSERT INTO users(full_name,username,password_hash,role,active,created_at,permissions) VALUES(?,?,?,?,?,?,?)')
        .run(values.full_name, values.username, values.password_hash, values.role, values.active, now(), values.permissions);
      const id = Number(result.lastInsertRowid);
      logEvent('إضافة مستخدم', user.id, null, `${values.username} (${values.role}) · ${effectivePermissions(values).join(', ')}`);
      db.exec('COMMIT'); transaction = false;
      json(res, 201, { id, user: publicUser({ ...values, id }) });
    } catch (e) {
      if (transaction) db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) fail(res, 409, 'اسم المستخدم مستخدم مسبقاً.'); else throw e;
    }
    return;
  }
  const userMatch = /^\/api\/users\/(\d+)$/.exec(path);
  if (userMatch && req.method === 'PATCH') {
    const id = Number(userMatch[1]); const body = accountBody(await readJson(req));
    if (!Object.keys(body).length) { fail(res, 400, 'اختر المعلومات التي تريد تعديلها.'); return; }
    const target = db.prepare('SELECT id,full_name,username,password_hash,role,active,created_at,permissions FROM users WHERE id=?').get(id);
    if (!target) { fail(res, 404, 'المستخدم غير موجود.'); return; }
    const values = accountValues(body, target);
    assertAccountDelegation(user, target, values);
    if (id === user.id && !values.active) { fail(res, 400, 'لا يمكن إيقاف حسابك وأنت مسجل الدخول به.'); return; }
    const authorizationChanged = target.username !== values.username || target.role !== values.role ||
      JSON.stringify(effectivePermissions(target)) !== JSON.stringify(effectivePermissions(values)) ||
      values.passwordChanged || !values.active;
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE'); transaction = true;
      if (target.active && target.role === 'admin' && (!values.active || values.role !== 'admin')) {
        const remaining = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id<>?").get(id).n);
        if (!remaining) throw Object.assign(new Error('يجب إبقاء حساب مدير فعّال واحد على الأقل.'), { status: 400 });
      }
      db.prepare('UPDATE users SET full_name=?,username=?,password_hash=?,role=?,active=?,permissions=? WHERE id=?')
        .run(values.full_name, values.username, values.password_hash, values.role, values.active, values.permissions, id);
      logEvent('تعديل حساب مستخدم', user.id, null, `${target.username} → ${values.username} (${values.role}, ${values.active ? 'فعال' : 'متوقف'}) · ${effectivePermissions(values).join(', ')}`);
      if (values.passwordChanged) logEvent('تغيير كلمة مرور', user.id, null, values.username);
      db.exec('COMMIT'); transaction = false;
    } catch (e) {
      if (transaction) db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) { fail(res, 409, 'اسم المستخدم مستخدم مسبقاً.'); return; }
      throw e;
    }
    if (authorizationChanged) for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token);
    json(res, 200, { ok: true, user: publicUser({ ...target, ...values }), reauthenticate: authorizationChanged && id === user.id }); return;
  }
  if (req.method === 'GET' && path === '/api/audit') {
    const rows = db.prepare(`SELECT a.id,a.event,a.doc_id,a.details,a.created_at,u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200`).all();
    json(res, 200, { events: rows }); return;
  }
  fail(res, 404, 'الصفحة المطلوبة غير موجودة.');
}

const IS_TLS = Boolean(process.env.ARCHIVE_TLS_KEY && process.env.ARCHIVE_TLS_CERT);
const EXPECTED_ORIGIN = new URL(`${IS_TLS ? 'https' : 'http'}://127.0.0.1:${PORT}`).origin;
const EXPECTED_HOST = new URL(EXPECTED_ORIGIN).host;
const ALLOWED_HOSTS = new Set([EXPECTED_HOST, ...LAN_ADDRESSES.map(address => `${address}:${PORT}`)]);
const server = IS_TLS
  ? https.createServer({ key: readFileSync(process.env.ARCHIVE_TLS_KEY), cert: readFileSync(process.env.ARCHIVE_TLS_CERT) }, (req, res) => dispatch(req, res))
  : http.createServer((req, res) => dispatch(req, res));
function dispatch(req, res) {
  for (const [name, value] of Object.entries({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=()'
  })) res.setHeader(name, value);
  if (!ALLOWED_HOSTS.has(req.headers.host)) { fail(res, 403, 'تم رفض الطلب لأسباب أمنية.'); return; }
  const internalUrl = new URL(req.url, EXPECTED_ORIGIN);
  if (internalUrl.pathname === '/__health') {
    const secret = Buffer.from(process.env.ARCHIVE_HEALTH_TOKEN || '', 'utf8');
    const nonce = String(req.headers['x-archive-health-nonce'] || '');
    if (req.method !== 'GET' || !secret.length || !/^[a-f0-9]{32}$/i.test(nonce)) {
      fail(res, 404, 'الصفحة المطلوبة غير موجودة.'); return;
    }
    const proof = createHmac('sha256', secret).update(nonce).digest('hex');
    res.writeHead(204, { 'x-archive-health-proof': proof }); res.end(); return;
  }
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    try {
      const requestOrigin = `${IS_TLS ? 'https' : 'http'}://${req.headers.host}`;
      if (!req.headers.origin || req.headers.origin !== requestOrigin) { fail(res, 403, 'تم رفض الطلب لأسباب أمنية.'); return; }
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin') { fail(res, 403, 'تم رفض الطلب لأسباب أمنية.'); return; }
    } catch { fail(res, 403, 'تم رفض الطلب لأسباب أمنية.'); return; }
  }
  Promise.resolve(handle(req, res)).catch(error => {
    if (res.headersSent || res.destroyed) return;
    const status = error.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}]`, error);
    fail(res, status, status >= 500 ? 'صار خطأ داخلي. راجع مسؤول النظام.' : error.message);
  });
}
server.listen(PORT, HOST, () => {
  console.log(`أرشيفنا يعمل على ${EXPECTED_ORIGIN}`);
  if (LAN_ENABLED) for (const address of LAN_ADDRESSES) console.log(`رابط الشبكة المحلية: ${IS_TLS ? 'https' : 'http'}://${address}:${PORT}`);
  maybeCreateAutomaticBackup();
  const backupTimer = setInterval(maybeCreateAutomaticBackup, 60 * 60 * 1000);
  backupTimer.unref();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); });
