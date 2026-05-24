# 睦邻云印 - 服务器端 (MulinPrint Server)

跨网段云打印中转服务器，解决政务内外网隔离环境下的打印需求。

## 架构

```
[外网客户端] --HTTP上传--> [云服务器:8156] <--WebSocket-- [内网打印主机]
```

## 快速部署（阿里云）

```bash
# 1. 克隆代码
git clone https://github.com/hankdab/mulin-cloudprint-server.git
cd mulin-cloudprint-server

# 2. 安装依赖
npm install

# 3. 启动服务
node server.js
# 或使用 PM2 守护
pm2 start server.js --name mulin-server
```

服务默认监听 `0.0.0.0:8156`

## 环境要求

- Node.js >= 14
- 开放端口: 8156 (HTTP + WebSocket)

## 目录结构

```
├── server.js        # 主服务 (Express + WebSocket)
├── db.js            # 数据库层 (sql.js, 纯JS SQLite)
├── package.json     # 依赖声明
├── public/          # 管理后台前端
│   └── index.html   # 管理控制台 SPA
├── start.sh         # Linux 启动脚本
├── data/            # [自动生成] SQLite 数据文件
└── uploads/         # [自动生成] 临时打印文件
```

## API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 管理员登录 |
| `/api/hosts` | GET | 获取打印主机列表 |
| `/api/printers` | GET | 获取打印机列表 |
| `/api/jobs` | POST | 提交打印任务 |
| `/api/jobs` | GET | 查询任务列表 |
| `/api/stats` | GET | 统计数据 |
| `/ws` | WS | WebSocket 实时通信 |

## 默认账户

- 用户名: `hankdab`
- 密码: `!X7gFVw1QT0Tv1Hv`

> ⚠️ 首次登录后请立即修改密码

## 生产部署建议

```bash
# Nginx 反向代理 (支持 WebSocket)
server {
    listen 80;
    server_name print.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8156;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## License

MIT
