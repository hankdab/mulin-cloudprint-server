/**
 * 云打印中转服务器
 * Express + WebSocket + SQLite
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 8156;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============ 中间件 ============

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 文件上传配置
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// JWT 验证中间件
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const decoded = jwt.verify(token, db.getJwtSecret());
    req.auth = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token 无效或已过期' });
  }
}

// 管理员权限中间件
function adminMiddleware(req, res, next) {
  if (req.auth.type !== 'user') return res.status(403).json({ error: '无权限' });
  const user = db.getUser(req.auth.userId);
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

// ============ WebSocket 连接管理 ============

// 存储活跃的主机端连接: printerId -> ws
const hostConnections = new Map();
// 存储活跃的客户端连接: oderId -> Set<ws>（用于状态推送）
const clientConnections = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const type = url.searchParams.get('type'); // 'host' or 'client'

  if (!token) {
    ws.close(4001, '缺少认证 Token');
    return;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, db.getJwtSecret());
  } catch (e) {
    ws.close(4002, 'Token 无效');
    return;
  }

  ws.authData = decoded;
  ws.isAlive = true;

  if (type === 'host' && decoded.printerId) {
    // 打印主机端连接
    ws.type = 'host';
    ws.printerId = decoded.printerId;
    hostConnections.set(decoded.printerId, ws);
    db.updatePrinterStatus(decoded.printerId, 'online', decoded.platform || null);
    console.log(`[WS] 打印主机上线: ${decoded.printerId}`);

    // 发送待处理任务
    const pendingJobs = db.getPendingJobs(decoded.printerId);
    if (pendingJobs.length > 0) {
      ws.send(JSON.stringify({ type: 'pending_jobs', jobs: pendingJobs }));
    }

    ws.on('message', (data) => handleHostMessage(ws, data));
    ws.on('close', () => {
      hostConnections.delete(decoded.printerId);
      db.updatePrinterStatus(decoded.printerId, 'offline');
      console.log(`[WS] 打印主机离线: ${decoded.printerId}`);
    });

  } else if (type === 'client' && decoded.orgId) {
    // 客户端连接（用于接收打印状态更新）
    ws.type = 'client';
    ws.orgId = decoded.orgId;
    ws.userId = decoded.userId;
    if (!clientConnections.has(decoded.orgId)) {
      clientConnections.set(decoded.orgId, new Set());
    }
    clientConnections.get(decoded.orgId).add(ws);
    console.log(`[WS] 客户端连接: user=${decoded.userId} org=${decoded.orgId}`);

    ws.on('close', () => {
      const set = clientConnections.get(decoded.orgId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clientConnections.delete(decoded.orgId);
      }
    });

  } else {
    ws.close(4003, '无效的连接类型');
  }

  ws.on('pong', () => { ws.isAlive = true; });
});

// 心跳检测
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 处理主机端消息
function handleHostMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case 'job_status':
      // 主机报告打印任务状态
      db.updatePrintJobStatus(msg.jobId, msg.status, msg.error);
      // 通知客户端
      const job = db.getPrintJob(msg.jobId);
      if (job) {
        broadcastToOrg(job.org_id, {
          type: 'job_update',
          job: { id: job.id, filename: job.filename, status: msg.status, error: msg.error }
        });
      }
      // 打印完成后清理文件
      if (msg.status === 'completed' || msg.status === 'failed') {
        if (job && job.file_path) {
          const fullPath = path.join(UPLOAD_DIR, path.basename(job.file_path));
          fs.unlink(fullPath, () => {});
        }
      }
      break;

    case 'heartbeat':
      db.updatePrinterStatus(ws.printerId, 'online');
      ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      break;
  }
}

// 向组织内的所有客户端广播消息
function broadcastToOrg(orgId, message) {
  const set = clientConnections.get(orgId);
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// 向指定打印机推送新任务
function notifyHost(printerId, job) {
  const ws = hostConnections.get(printerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'new_job', job }));
    return true;
  }
  return false;
}

// ============ REST API - 认证 ============

// 用户登录
app.post('/api/auth/login', (req, res) => {
  const { username, password, orgCode } = req.body;
  if (!username || !password || !orgCode) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  const org = db.getOrganizationByCode(orgCode);
  if (!org) return res.status(400).json({ error: '组织码无效' });
  const user = db.verifyUser(username, password, org.id);
  if (!user) return res.status(400).json({ error: '用户名或密码错误' });
  const token = db.createToken(user.id, null, 'user', org.id);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role }, org: { id: org.id, name: org.name } });
});

// 主机端认证（用 host_key）
app.post('/api/auth/host', (req, res) => {
  const { hostKey, platform } = req.body;
  if (!hostKey) return res.status(400).json({ error: '请提供主机密钥' });
  const printer = db.getPrinterByHostKey(hostKey);
  if (!printer) return res.status(400).json({ error: '主机密钥无效' });
  const token = db.createToken(null, printer.id, 'host', printer.org_id);
  res.json({ token, printer: { id: printer.id, name: printer.name }, org: { id: printer.org_id } });
});

// ============ REST API - 组织管理（管理员） ============

app.get('/api/orgs', authMiddleware, (req, res) => {
  // admin 可以看所有，其他只能看自己的
  const user = db.getUser(req.auth.userId);
  if (user && user.role === 'admin') {
    res.json(db.listOrganizations());
  } else {
    const org = db.getOrganization(req.auth.orgId);
    res.json(org ? [org] : []);
  }
});

app.post('/api/orgs', authMiddleware, adminMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '请填写组织名称' });
  const org = db.createOrganization(name);
  res.json(org);
});

app.delete('/api/orgs/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.deleteOrganization(req.params.id);
  res.json({ ok: true });
});

// ============ REST API - 用户管理 ============

app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  res.json(db.listUsers(req.auth.orgId));
});

app.post('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, role, orgId } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
  try {
    const user = db.createUser(username, password, role || 'user', orgId || req.auth.orgId);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: '用户名已存在' });
  }
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.updateUser(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ============ REST API - 打印机管理 ============

app.get('/api/printers', authMiddleware, (req, res) => {
  res.json(db.listPrinters(req.auth.orgId));
});

app.post('/api/printers', authMiddleware, adminMiddleware, (req, res) => {
  const { name, orgId } = req.body;
  if (!name) return res.status(400).json({ error: '请填写打印机名称' });
  const printer = db.createPrinter(name, orgId || req.auth.orgId);
  res.json(printer);
});

app.delete('/api/printers/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.deletePrinter(req.params.id);
  res.json({ ok: true });
});

// ============ REST API - 打印任务 ============

// 提交打印任务（客户端上传文件）
app.post('/api/jobs', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const { printerId, copies, paper_size, orientation, color_mode, duplex } = req.body;
  if (!printerId) return res.status(400).json({ error: '请选择打印机' });

  // 验证打印机属于同一组织
  const printer = db.getPrinter(printerId);
  if (!printer || printer.org_id !== req.auth.orgId) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: '无权访问该打印机' });
  }

  const job = db.createPrintJob(
    printerId, req.auth.userId, req.auth.orgId,
    req.file.originalname, req.file.filename, req.file.size,
    { copies: parseInt(copies) || 1, paper_size, orientation, color_mode, duplex }
  );

  // 通过 WebSocket 即时推送给主机
  const fullJob = db.getPrintJob(job.id);
  const sent = notifyHost(printerId, fullJob);

  if (!sent) {
    console.log(`[Job] 打印机 ${printerId} 离线，任务 ${job.id} 排队等待`);
  }

  // 广播给管理后台
  broadcastToOrg(req.auth.orgId, {
    type: 'new_job',
    job: { id: job.id, filename: req.file.originalname, status: 'pending', printer_name: printer.name }
  });

  res.json({ ...job, host_online: sent });
});

// 查询任务列表
app.get('/api/jobs', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const jobs = db.listPrintJobs(req.auth.orgId, limit, offset);
  const total = db.countPrintJobs(req.auth.orgId);
  res.json({ jobs, total });
});

// 获取任务状态
app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  const job = db.getPrintJob(req.params.id);
  if (!job || job.org_id !== req.auth.orgId) return res.status(404).json({ error: '任务不存在' });
  res.json(job);
});

// 主机端下载打印文件
app.get('/api/jobs/:id/file', authMiddleware, (req, res) => {
  const job = db.getPrintJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const filePath = path.join(UPLOAD_DIR, job.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  res.download(filePath, job.filename);
});

// ============ REST API - 统计 ============

app.get('/api/stats', authMiddleware, (req, res) => {
  res.json(db.getStats(req.auth.orgId));
});

app.get('/api/stats/daily', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days) || 14;
  res.json(db.getDailyStats(req.auth.orgId, days));
});

app.get('/api/stats/printers', authMiddleware, (req, res) => {
  res.json(db.getPrinterStats(req.auth.orgId));
});

app.get('/api/stats/users', authMiddleware, (req, res) => {
  res.json(db.getUserStats(req.auth.orgId));
});

app.get('/api/stats/hourly', authMiddleware, (req, res) => {
  res.json(db.getHourlyStats(req.auth.orgId));
});

// ============ Web 管理后台页面 ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ 启动 ============

async function start() {
  // 先初始化数据库（sql.js 需要异步加载 WASM）
  await db.initDB();
  db.initDefaultAdmin();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`云打印服务器启动成功！`);
    console.log(`管理后台: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`API 地址: http://localhost:${PORT}/api`);
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
