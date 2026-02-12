# 快速开始指南

## 5分钟启动 Reynard Bot

### 步骤 1：安装依赖

确保已安装 Node.js 18+：

```bash
node --version  # 应该显示 v18 或更高版本
```

安装项目依赖：

```bash
npm install
```

### 步骤 2：配置环境变量

复制环境变量模板：

```bash
cp .env.example .env
```

默认配置已经可以运行，如需自定义可编辑 `.env` 文件。

### 步骤 3：启动 Bot

#### 方式 A：开发模式（推荐用于测试）

```bash
npm run dev
```

#### 方式 B：生产模式

```bash
npm run build
npm start
```

### 步骤 4：登录微信

1. 启动后，在浏览器中打开：http://localhost:3000/login
2. 页面会显示微信二维码
3. 使用手机微信扫描二维码
4. 在手机上确认登录
5. 登录成功后，Bot 开始运行！

### 步骤 5：测试消息收集

1. 确保 Bot 已登录成功
2. 在任意一个你的微信群聊中发送消息
3. 查看终端日志，应该能看到消息被收集
4. 查看数据库：

```bash
# Windows (使用 SQLite 客户端或)
sqlite3 data/reynard.db "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10;"

# 或者使用任何 SQLite 可视化工具，如 DB Browser for SQLite
```

## 常见问题

### Q: 二维码不显示？

A:
- 检查终端日志是否有错误
- 确认端口 3000 未被占用
- 尝试刷新页面

### Q: 扫码后无法登录？

A:
- 确保使用的是个人微信（不是企业微信）
- 尝试重启应用重新扫码
- 检查网络连接

### Q: 收不到群聊消息？

A:
- 确认 Bot 账号已加入目标群聊
- 检查 `.env` 中的 `MONITORED_ROOMS` 配置（空表示监听所有）
- 查看终端日志确认是否有错误

### Q: Session 总是过期？

A:
- 这是正常现象，免费 Web 协议不够稳定
- Session 文件保存在 `data/wechaty.memory-card.json`
- 如需更稳定体验，考虑升级到付费 Puppet

## 下一步

- 📖 阅读完整文档：[README.md](./README.md)
- 🐳 使用 Docker 部署：`docker-compose up -d`
- 🔗 配置 Webhook 推送
- 🛡️ 了解防封策略

## 需要帮助？

查看完整的 [README.md](./README.md) 文档，里面有详细的配置说明和故障排除指南。
