# Reynard Bot (狐狸机器人) 🦊

一个基于 Wechaty 的微信群聊机器人，用于收集群聊消息并支持多种数据输出方式。

## 功能特性

- ✅ 监听并收集微信群聊消息
- ✅ 将消息存储到 SQLite 数据库
- ✅ 支持通过 Webhook 推送消息到外部服务
- ✅ Web UI 显示二维码登录
- ✅ Session 持久化，重启后自动登录
- ✅ 消息频率控制和随机延迟（防封策略）
- ✅ Docker 容器化部署
- ✅ 完整的日志系统

## 技术栈

- **语言**: Node.js / TypeScript
- **框架**: Wechaty (微信机器人框架)
- **数据库**: SQLite (better-sqlite3)
- **Web 服务器**: Express
- **日志**: Winston
- **部署**: Docker / Docker Compose

## 快速开始

### 前置要求

- Node.js 18+ 或 Docker
- 一个微信账号（建议使用小号测试）

### 方式 1：直接运行

1. **克隆项目并安装依赖**

```bash
git clone <repository-url>
cd reynard
npm install
```

2. **配置环境变量**

```bash
cp .env.example .env
# 编辑 .env 文件，根据需要修改配置
```

3. **编译 TypeScript**

```bash
npm run build
```

4. **启动应用**

```bash
npm start
```

5. **登录微信**

在浏览器中打开 http://localhost:3000/login，扫描二维码登录。

### 方式 2：Docker Compose（推荐）

1. **配置环境变量**

```bash
cp .env.example .env
# 编辑 .env 文件
```

2. **启动服务**

```bash
docker-compose up -d
```

3. **查看日志**

```bash
docker-compose logs -f reynard-bot
```

4. **登录微信**

在浏览器中打开 http://localhost:3000/login，扫描二维码登录。

5. **停止服务**

```bash
docker-compose down
```

## 配置说明

所有配置通过环境变量设置，详见 `.env.example`：

### Bot 配置

```env
# Puppet 类型（免费版使用 wechaty-puppet-wechat）
WECHATY_PUPPET=wechaty-puppet-wechat

# Puppet Token（付费版本需要）
# WECHATY_PUPPET_TOKEN=your_token_here

# Session 持久化文件路径
WECHATY_MEMORY_PATH=data/wechaty.memory-card.json
```

### Web UI 配置

```env
# Web 服务器端口
WEB_PORT=3000

# Web 服务器监听地址
WEB_HOST=0.0.0.0

# 是否启用 Web UI
WEB_ENABLED=true
```

### 数据库配置

```env
# SQLite 数据库文件路径
DATABASE_PATH=data/reynard.db
```

### Webhook 配置

```env
# Webhook 接收地址
WEBHOOK_URL=https://your-webhook-endpoint.com/receive

# 是否启用 Webhook
WEBHOOK_ENABLED=false

# 批量发送大小
WEBHOOK_BATCH_SIZE=10

# 批量发送间隔（秒）
WEBHOOK_BATCH_INTERVAL=5
```

### 限流配置（防封策略）

```env
# 每分钟消息处理限制
RATE_LIMIT_PER_MINUTE=60

# 消息处理最小延迟（毫秒）
MESSAGE_DELAY_MIN=1000

# 消息处理最大延迟（毫秒）
MESSAGE_DELAY_MAX=3000
```

### 监控配置

```env
# 监听的群聊 ID 列表（逗号分隔，空则监听所有）
MONITORED_ROOMS=

# 日志级别（debug/info/warn/error）
LOG_LEVEL=info
```

## 使用指南

### 登录流程

1. 启动应用后，访问 http://localhost:3000/login
2. 浏览器会显示微信二维码
3. 使用手机微信扫描二维码
4. 在手机上确认登录
5. 登录成功后，session 会自动保存到 `data/wechaty.memory-card.json`
6. 下次重启应用，会自动使用保存的 session 登录，无需再次扫码

### Session 过期处理

如果 session 过期（例如在其他设备登录导致被踢下线）：

1. Web UI 会自动检测到登出状态
2. 再次访问 http://localhost:3000/login
3. 扫描新的二维码重新登录

### 查看收集的消息

消息存储在 SQLite 数据库中，可以使用任何 SQLite 客户端查看：

```bash
# 使用 sqlite3 命令行
sqlite3 data/reynard.db

# 查询最近的 10 条消息
SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10;

# 查询特定群聊的消息
SELECT * FROM messages WHERE room_id = 'your-room-id' ORDER BY timestamp DESC;
```

### Webhook 集成

如果启用了 Webhook，每条消息都会以以下格式发送到配置的 URL：

```json
{
  "messageId": "message-id",
  "roomId": "room-id",
  "roomName": "群聊名称",
  "talkerId": "talker-id",
  "talkerName": "发言人昵称",
  "content": "消息内容",
  "messageType": "Text",
  "timestamp": 1234567890000
}
```

## 目录结构

```
reynard/
├── src/                    # 源代码
│   ├── bot/               # Bot 核心模块
│   ├── web/               # Web UI 模块
│   ├── database/          # 数据库模块
│   ├── webhook/           # Webhook 模块
│   ├── utils/             # 工具函数
│   ├── types/             # TypeScript 类型定义
│   ├── config/            # 配置管理
│   └── index.ts           # 应用入口
├── data/                   # 数据目录（持久化）
│   ├── reynard.db         # SQLite 数据库
│   └── wechaty.memory-card.json  # Session 文件
├── logs/                   # 日志目录
├── dist/                   # 编译输出（自动生成）
├── .env                    # 环境变量配置
├── Dockerfile              # Docker 镜像构建
├── docker-compose.yml      # Docker Compose 配置
└── README.md               # 本文档
```

## 防封策略

为了降低被封号风险，本项目实现了以下策略：

1. **消息频率控制**
   - 默认每分钟最多处理 60 条消息
   - 超过限制的消息会被丢弃

2. **随机延迟**
   - 处理每条消息前添加 1-3 秒随机延迟
   - 模拟人工操作行为

3. **Webhook 批量发送**
   - 避免频繁的 HTTP 请求
   - 默认每 10 条或每 5 秒批量发送

4. **Session 持久化**
   - 避免频繁登录
   - 重启后自动恢复登录状态

5. **建议**
   - 使用稳定的网络环境
   - 不要频繁切换 IP
   - 避免 24/7 不间断运行
   - 定期手动登录原生微信客户端
   - 使用小号测试

## 升级到付费 Puppet

免费的 `wechaty-puppet-wechat` (Web 协议) 可能不够稳定，如需更好的体验，可以升级到付费方案：

1. **Padlocal Puppet**（推荐）
   ```bash
   npm install wechaty-puppet-padlocal
   ```

   修改 `.env`：
   ```env
   WECHATY_PUPPET=wechaty-puppet-padlocal
   WECHATY_PUPPET_TOKEN=your_padlocal_token
   ```

2. **Wechaty Puppet Service**
   ```env
   WECHATY_PUPPET=wechaty-puppet-service
   WECHATY_PUPPET_TOKEN=your_service_token
   ```

**无需修改任何代码**，只需更改配置即可切换。

## 开发

### 开发模式

```bash
# 开发模式（手动重启）
npm run dev

# 开发模式（自动监听文件变化）
npm run dev:watch
```

### 编译

```bash
npm run build
```

### 清理

```bash
npm run clean
```

## API 端点

### `GET /api/status`

获取 Bot 状态

**响应：**
```json
{
  "loggedIn": true,
  "scanning": false,
  "userName": "用户昵称",
  "qrcodeUrl": "data:image/png;base64,..."
}
```

### `GET /api/qrcode`

获取当前二维码

**响应：**
```json
{
  "url": "https://login.weixin.qq.com/...",
  "dataUrl": "data:image/png;base64,...",
  "timestamp": 1234567890000
}
```

### `GET /api/health`

健康检查

**响应：**
```json
{
  "status": "ok",
  "timestamp": 1234567890000
}
```

## 常见问题

### 1. 扫码后无法登录

- 确认使用的是真实微信账号（不是企业微信）
- 尝试重启应用重新扫码
- 检查网络连接是否稳定

### 2. Session 总是过期

- 这是正常现象，Web 协议的 session 不够稳定
- 考虑升级到付费 Puppet
- 避免在多个设备同时登录

### 3. 收不到消息

- 检查 `MONITORED_ROOMS` 配置是否正确
- 查看日志文件确认 Bot 是否正常运行
- 确认 Bot 已加入目标群聊

### 4. Webhook 不工作

- 确认 `WEBHOOK_ENABLED=true`
- 确认 `WEBHOOK_URL` 配置正确
- 检查 Webhook 端点是否可访问
- 查看日志中的错误信息

### 5. Docker 容器启动失败

- 确认端口 3000 未被占用
- 确认 `.env` 文件存在且格式正确
- 查看容器日志：`docker-compose logs reynard-bot`

## 许可证

ISC

## 免责声明

本项目仅供学习和研究使用。使用本项目时请遵守微信的使用条款，作者不对使用本项目导致的任何后果负责。建议使用小号进行测试，避免主号被封。
