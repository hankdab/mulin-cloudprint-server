/**
 * 数据库模块 - SQLite (sql.js 纯JS实现，无需原生编译)
 * 管理组织、用户、打印机、打印任务
 */
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'cloudprint.db');
fs.mkdirSync(DB_DIR, { recursive: true });

let db = null;
let _ready = false;
let _readyCallbacks = [];

// ============ 初始化 ============

async function initDB() {
  const SQL = await initSqlJs();

  // 加载已有数据库或创建新的
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // 启用外键
  db.run('PRAGMA foreign_keys = ON');

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      org_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (org_id) REFERENCES organizations(id),
      UNIQUE(username, org_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_key TEXT UNIQUE NOT NULL,
      org_id TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      platform TEXT DEFAULT 'unknown',
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      printer_id TEXT NOT NULL,
      user_id TEXT,
      org_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      copies INTEGER DEFAULT 1,
      paper_size TEXT DEFAULT 'A4',
      orientation TEXT DEFAULT 'portrait',
      color_mode TEXT DEFAULT 'color',
      duplex TEXT DEFAULT 'none',
      status TEXT DEFAULT 'pending',
      error_msg TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (printer_id) REFERENCES printers(id),
      FOREIGN KEY (org_id) REFERENCES organizations(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT,
      printer_id TEXT,
      type TEXT NOT NULL,
      org_id TEXT NOT NULL,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  saveDB();
  _ready = true;
  _readyCallbacks.forEach(cb => cb());
  _readyCallbacks = [];
  console.log('[DB] 数据库初始化完成');
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// 定期保存（每30秒）
setInterval(() => { if (_ready) saveDB(); }, 30000);

// 进程退出时保存
process.on('exit', () => { if (_ready) saveDB(); });
process.on('SIGINT', () => { if (_ready) saveDB(); process.exit(0); });

// ============ 查询辅助 ============

/** 执行查询返回所有行 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** 执行查询返回第一行 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/** 执行写操作 */
function execute(sql, params = []) {
  db.run(sql, params);
  saveDB(); // 写操作后立即持久化
}

// ============ 组织管理 ============

function createOrganization(name) {
  const id = uuidv4();
  const code = generateOrgCode();
  execute('INSERT INTO organizations (id, name, code) VALUES (?, ?, ?)', [id, name, code]);
  return { id, name, code };
}

function getOrganization(id) {
  return queryOne('SELECT * FROM organizations WHERE id = ?', [id]);
}

function getOrganizationByCode(code) {
  return queryOne('SELECT * FROM organizations WHERE code = ?', [code]);
}

function listOrganizations() {
  return queryAll('SELECT * FROM organizations ORDER BY created_at DESC');
}

function deleteOrganization(id) {
  execute('DELETE FROM organizations WHERE id = ?', [id]);
}

// ============ 用户管理 ============

function createUser(username, password, role, orgId) {
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);
  execute('INSERT INTO users (id, username, password_hash, role, org_id) VALUES (?, ?, ?, ?, ?)',
    [id, username, passwordHash, role, orgId]);
  return { id, username, role, org_id: orgId };
}

function verifyUser(username, password, orgId) {
  const user = queryOne('SELECT * FROM users WHERE username = ? AND org_id = ? AND is_active = 1',
    [username, orgId]);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role, org_id: user.org_id };
}

function getUser(id) {
  return queryOne('SELECT id, username, role, org_id, is_active, created_at FROM users WHERE id = ?', [id]);
}

function listUsers(orgId) {
  return queryAll('SELECT id, username, role, org_id, is_active, created_at FROM users WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
}

function updateUser(id, fields) {
  const sets = [];
  const vals = [];
  if (fields.username) { sets.push('username = ?'); vals.push(fields.username); }
  if (fields.password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(fields.password, 10)); }
  if (fields.role) { sets.push('role = ?'); vals.push(fields.role); }
  if (fields.is_active !== undefined) { sets.push('is_active = ?'); vals.push(fields.is_active ? 1 : 0); }
  if (sets.length === 0) return;
  vals.push(id);
  execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function deleteUser(id) {
  execute('DELETE FROM users WHERE id = ?', [id]);
}

// ============ 打印机管理 ============

function createPrinter(name, orgId) {
  const id = uuidv4();
  const hostKey = 'hk_' + uuidv4().replace(/-/g, '');
  execute('INSERT INTO printers (id, name, host_key, org_id) VALUES (?, ?, ?, ?)',
    [id, name, hostKey, orgId]);
  return { id, name, host_key: hostKey, org_id: orgId };
}

function getPrinter(id) {
  return queryOne('SELECT * FROM printers WHERE id = ?', [id]);
}

function getPrinterByHostKey(hostKey) {
  return queryOne('SELECT * FROM printers WHERE host_key = ?', [hostKey]);
}

function listPrinters(orgId) {
  return queryAll('SELECT id, name, org_id, status, platform, last_seen, created_at FROM printers WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
}

function updatePrinterStatus(id, status, platform) {
  if (platform) {
    execute('UPDATE printers SET status = ?, platform = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [status, platform, id]);
  } else {
    execute('UPDATE printers SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]);
  }
}

function deletePrinter(id) {
  execute('DELETE FROM printers WHERE id = ?', [id]);
}

// ============ 打印任务管理 ============

function createPrintJob(printerId, userId, orgId, filename, filePath, fileSize, opts = {}) {
  const id = uuidv4();
  const copies = opts.copies || 1;
  const paperSize = opts.paper_size || 'A4';
  const orientation = opts.orientation || 'portrait';
  const colorMode = opts.color_mode || 'color';
  const duplex = opts.duplex || 'none';
  execute(
    `INSERT INTO print_jobs (id, printer_id, user_id, org_id, filename, file_path, file_size, copies, paper_size, orientation, color_mode, duplex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, printerId, userId, orgId, filename, filePath, fileSize, copies, paperSize, orientation, colorMode, duplex]
  );
  return { id, printer_id: printerId, filename, status: 'pending' };
}

function getPrintJob(id) {
  return queryOne('SELECT * FROM print_jobs WHERE id = ?', [id]);
}

function listPrintJobs(orgId, limit = 50, offset = 0) {
  return queryAll(`
    SELECT j.*, p.name as printer_name, u.username
    FROM print_jobs j
    LEFT JOIN printers p ON j.printer_id = p.id
    LEFT JOIN users u ON j.user_id = u.id
    WHERE j.org_id = ?
    ORDER BY j.created_at DESC
    LIMIT ? OFFSET ?
  `, [orgId, limit, offset]);
}

function countPrintJobs(orgId) {
  const row = queryOne('SELECT COUNT(*) as count FROM print_jobs WHERE org_id = ?', [orgId]);
  return row ? row.count : 0;
}

function updatePrintJobStatus(id, status, errorMsg) {
  if (status === 'completed' || status === 'failed') {
    execute('UPDATE print_jobs SET status = ?, error_msg = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, errorMsg || null, id]);
  } else {
    execute('UPDATE print_jobs SET status = ?, error_msg = ? WHERE id = ?',
      [status, errorMsg || null, id]);
  }
}

function getPendingJobs(printerId) {
  return queryAll('SELECT * FROM print_jobs WHERE printer_id = ? AND status = ? ORDER BY created_at ASC',
    [printerId, 'pending']);
}

// ============ Token 管理 ============

function createToken(userId, printerId, type, orgId, expiresHours = 720) {
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { userId, printerId, type, orgId },
    getJwtSecret(),
    { expiresIn: `${expiresHours}h` }
  );
  return token;
}

function getJwtSecret() {
  return process.env.JWT_SECRET || 'cloud-print-secret-change-me';
}

// ============ 初始化默认管理员 ============

function initDefaultAdmin() {
  const orgs = listOrganizations();
  if (orgs.length === 0) {
    const org = createOrganization('默认组织');
    createUser('admin', 'admin123', 'admin', org.id);
    console.log('========================================');
    console.log('初始化完成！');
    console.log(`组织名称: ${org.name}`);
    console.log(`组织邀请码: ${org.code}`);
    console.log(`管理员账号: admin`);
    console.log(`管理员密码: admin123`);
    console.log('请登录后立即修改密码！');
    console.log('========================================');
  }
}

// ============ 工具函数 ============

function generateOrgCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 基础统计
function getStats(orgId) {
  const printerCount = (queryOne('SELECT COUNT(*) as c FROM printers WHERE org_id = ?', [orgId]) || {}).c || 0;
  const onlineCount = (queryOne("SELECT COUNT(*) as c FROM printers WHERE org_id = ? AND status = 'online'", [orgId]) || {}).c || 0;
  const userCount = (queryOne('SELECT COUNT(*) as c FROM users WHERE org_id = ?', [orgId]) || {}).c || 0;
  const jobCount = (queryOne('SELECT COUNT(*) as c FROM print_jobs WHERE org_id = ?', [orgId]) || {}).c || 0;
  const todayJobs = (queryOne("SELECT COUNT(*) as c FROM print_jobs WHERE org_id = ? AND date(created_at) = date('now')", [orgId]) || {}).c || 0;
  const completedJobs = (queryOne("SELECT COUNT(*) as c FROM print_jobs WHERE org_id = ? AND status = 'completed'", [orgId]) || {}).c || 0;
  const failedJobs = (queryOne("SELECT COUNT(*) as c FROM print_jobs WHERE org_id = ? AND status = 'failed'", [orgId]) || {}).c || 0;
  const totalPages = (queryOne("SELECT COALESCE(SUM(copies), 0) as c FROM print_jobs WHERE org_id = ? AND status = 'completed'", [orgId]) || {}).c || 0;
  return { printerCount, onlineCount, userCount, jobCount, todayJobs, completedJobs, failedJobs, totalPages };
}

function getDailyStats(orgId, days = 14) {
  return queryAll(`
    SELECT date(created_at) as date,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM print_jobs
    WHERE org_id = ? AND created_at >= date('now', ?)
    GROUP BY date(created_at)
    ORDER BY date(created_at) ASC
  `, [orgId, `-${days} days`]);
}

function getPrinterStats(orgId) {
  return queryAll(`
    SELECT p.name, p.status,
           COUNT(j.id) as job_count,
           SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM printers p
    LEFT JOIN print_jobs j ON p.id = j.printer_id
    WHERE p.org_id = ?
    GROUP BY p.id
    ORDER BY job_count DESC
  `, [orgId]);
}

function getUserStats(orgId) {
  return queryAll(`
    SELECT u.username,
           COUNT(j.id) as job_count,
           SUM(j.file_size) as total_size
    FROM users u
    LEFT JOIN print_jobs j ON u.id = j.user_id
    WHERE u.org_id = ?
    GROUP BY u.id
    ORDER BY job_count DESC
    LIMIT 10
  `, [orgId]);
}

function getHourlyStats(orgId) {
  return queryAll(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as count
    FROM print_jobs
    WHERE org_id = ? AND date(created_at) = date('now')
    GROUP BY strftime('%H', created_at)
    ORDER BY hour ASC
  `, [orgId]);
}

// ============ 导出 ============

module.exports = {
  initDB,
  createOrganization, getOrganization, getOrganizationByCode, listOrganizations, deleteOrganization,
  createUser, verifyUser, getUser, listUsers, updateUser, deleteUser,
  createPrinter, getPrinter, getPrinterByHostKey, listPrinters, updatePrinterStatus, deletePrinter,
  createPrintJob, getPrintJob, listPrintJobs, countPrintJobs, updatePrintJobStatus, getPendingJobs,
  createToken, getJwtSecret,
  initDefaultAdmin, getStats, getDailyStats, getPrinterStats, getUserStats, getHourlyStats, generateOrgCode
};
