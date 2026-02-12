# 测试清单

本文档提供了 Reynard Bot 的完整测试清单，按照项目计划的验证测试步骤进行。

## 前置条件

- [ ] Node.js 18+ 已安装
- [ ] 项目依赖已安装 (`npm install`)
- [ ] 有一个微信测试账号（建议使用小号）
- [ ] `.env` 文件已配置

## 1. 功能测试

### 1.1 Web UI 登录测试

- [ ] **启动服务**
  ```bash
  npm run dev
  ```

- [ ] **访问登录页面**
  - 浏览器打开 http://localhost:3000/login
  - 检查页面是否正常显示

- [ ] **验证二维码显示**
  - [ ] 二维码图片正确显示
  - [ ] 页面显示"等待扫码"状态

- [ ] **扫码登录**
  - [ ] 使用手机微信扫描二维码
  - [ ] 页面状态更新为"等待扫码确认"
  - [ ] 在手机上确认登录

- [ ] **登录成功**
  - [ ] 页面状态更新为"登录成功"
  - [ ] 显示登录的用户名
  - [ ] 终端日志显示登录成功消息

- [ ] **Session 文件创建**
  - [ ] 检查 `data/wechaty.memory-card.json` 文件是否已创建
  - [ ] 文件内容是否有 session 数据

**预期结果：** ✅ 所有步骤成功，Bot 登录完成

---

### 1.2 Session 持久化测试

- [ ] **停止服务**
  - Ctrl+C 停止运行中的服务

- [ ] **重新启动服务**
  ```bash
  npm run dev
  ```

- [ ] **验证自动登录**
  - [ ] Bot 无需扫码，自动使用 session 登录
  - [ ] 终端日志显示"Bot logged in as: xxx"
  - [ ] 访问 http://localhost:3000/login 显示"已登录"状态

- [ ] **Session 文件持久性**
  - [ ] `data/wechaty.memory-card.json` 文件仍然存在
  - [ ] 文件内容未被清空

**预期结果：** ✅ 重启后自动登录，无需再次扫码

---

### 1.3 消息收集测试

- [ ] **准备测试环境**
  - [ ] Bot 账号已加入至少一个测试群聊
  - [ ] Bot 已成功登录

- [ ] **发送文本消息**
  - [ ] 在测试群聊中发送文本消息："测试消息 1"
  - [ ] 终端日志显示消息被接收
  - [ ] 日志格式：`Message saved: [群名] 昵称: 测试消息 1`

- [ ] **检查数据库**
  ```bash
  sqlite3 data/reynard.db "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 1;"
  ```
  - [ ] 数据库中有最新的消息记录
  - [ ] 字段完整：message_id, room_id, room_name, talker_id, talker_name, content, message_type, timestamp

- [ ] **测试不同消息类型**
  - [ ] 发送图片 → 日志显示 "[图片]"
  - [ ] 发送文件 → 日志显示 "[文件]"
  - [ ] 发送语音 → 日志显示 "[语音]"
  - [ ] 发送表情 → 日志显示 "[表情]"

- [ ] **测试多条消息**
  - [ ] 快速发送 5 条消息
  - [ ] 所有消息都被正确保存到数据库
  - [ ] 查询数据库确认数量：
    ```bash
    sqlite3 data/reynard.db "SELECT COUNT(*) FROM messages;"
    ```

**预期结果：** ✅ 所有消息类型都被正确收集并存储

---

### 1.4 Webhook 测试

- [ ] **配置 Webhook**
  - 使用 webhook.site 或类似服务获取测试 URL
  - 修改 `.env`：
    ```env
    WEBHOOK_ENABLED=true
    WEBHOOK_URL=https://webhook.site/your-unique-id
    ```

- [ ] **重启服务**
  ```bash
  npm run dev
  ```

- [ ] **发送测试消息**
  - [ ] 在测试群聊中发送消息
  - [ ] 终端日志显示 webhook 发送成功
  - [ ] 在 webhook.site 上查看接收到的数据

- [ ] **验证 Webhook Payload**
  - [ ] JSON 格式正确
  - [ ] 包含所有必需字段：
    - messageId
    - roomId, roomName
    - talkerId, talkerName
    - content
    - messageType
    - timestamp

- [ ] **测试批量发送**
  - [ ] 快速发送 10+ 条消息
  - [ ] Webhook 以批量方式发送（根据配置）
  - [ ] 检查 webhook.site 接收的请求数量

**预期结果：** ✅ Webhook 正确发送消息数据

---

### 1.5 速率限制测试

- [ ] **配置严格的速率限制**
  - 修改 `.env`：
    ```env
    RATE_LIMIT_PER_MINUTE=5
    MESSAGE_DELAY_MIN=2000
    MESSAGE_DELAY_MAX=3000
    ```

- [ ] **重启服务**

- [ ] **快速发送多条消息**
  - [ ] 在 30 秒内发送 10 条消息
  - [ ] 终端日志显示速率限制警告
  - [ ] 部分消息被丢弃
  - [ ] 日志显示类似：`Rate limit exceeded for key: xxx`

- [ ] **验证延迟**
  - [ ] 观察消息处理之间有 2-3 秒延迟
  - [ ] 日志时间戳间隔符合配置

**预期结果：** ✅ 速率限制正常工作，消息处理有延迟

---

## 2. Docker 部署测试

### 2.1 Docker 镜像构建

- [ ] **构建镜像**
  ```bash
  docker-compose build
  ```
  - [ ] 构建成功，无错误
  - [ ] 镜像大小合理（< 500MB）

### 2.2 容器启动

- [ ] **启动服务**
  ```bash
  docker-compose up -d
  ```
  - [ ] 容器成功启动
  - [ ] 检查容器状态：`docker-compose ps`

- [ ] **查看日志**
  ```bash
  docker-compose logs -f reynard-bot
  ```
  - [ ] 日志正常输出
  - [ ] 无严重错误

### 2.3 登录和功能验证

- [ ] **Web UI 访问**
  - [ ] 访问 http://localhost:3000/login
  - [ ] 扫码登录成功

- [ ] **消息收集**
  - [ ] 在群聊发送消息
  - [ ] 容器日志显示消息被接收
  - [ ] 数据保存到 `./data/reynard.db`

### 2.4 数据持久化

- [ ] **重启容器**
  ```bash
  docker-compose restart
  ```
  - [ ] 容器重启成功
  - [ ] Session 自动恢复，无需重新登录
  - [ ] 数据库文件保持完整

- [ ] **停止并重新启动**
  ```bash
  docker-compose down
  docker-compose up -d
  ```
  - [ ] 所有数据保持不变
  - [ ] `./data/` 和 `./logs/` 目录内容完整

### 2.5 健康检查

- [ ] **检查健康状态**
  ```bash
  docker-compose ps
  ```
  - [ ] 容器显示 "healthy" 状态

- [ ] **手动测试健康端点**
  ```bash
  curl http://localhost:3000/api/health
  ```
  - [ ] 返回 `{"status":"ok","timestamp":...}`

**预期结果：** ✅ Docker 部署完全正常，数据持久化工作正常

---

## 3. 长期稳定性测试（可选）

### 3.1 24 小时运行测试

- [ ] **启动服务并运行 24 小时**
  ```bash
  docker-compose up -d
  ```

- [ ] **监控指标**
  - [ ] 每小时检查一次容器状态
  - [ ] 记录 CPU 使用率：`docker stats reynard-bot`
  - [ ] 记录内存使用率
  - [ ] 记录数据库文件大小增长

- [ ] **功能验证**
  - [ ] 24 小时后仍能正常接收消息
  - [ ] Session 未过期（或自动恢复）
  - [ ] 数据库查询正常
  - [ ] 日志文件正常轮转

- [ ] **检查是否被封号**
  - [ ] Bot 账号仍能正常登录
  - [ ] 能正常发送和接收消息
  - [ ] 未收到微信安全提示

**预期结果：** ✅ 运行稳定，无内存泄漏，未被封号

---

## 4. API 端点测试

### 4.1 测试所有 API 端点

- [ ] **GET /api/status**
  ```bash
  curl http://localhost:3000/api/status
  ```
  - [ ] 返回正确的 Bot 状态
  - [ ] JSON 格式正确

- [ ] **GET /api/qrcode**
  ```bash
  curl http://localhost:3000/api/qrcode
  ```
  - [ ] 已登录时返回 404
  - [ ] 未登录时返回二维码数据

- [ ] **GET /api/health**
  ```bash
  curl http://localhost:3000/api/health
  ```
  - [ ] 返回 `{"status":"ok","timestamp":...}`

- [ ] **GET /**
  ```bash
  curl -L http://localhost:3000/
  ```
  - [ ] 重定向到 /login

**预期结果：** ✅ 所有 API 端点正常工作

---

## 5. 错误处理测试

### 5.1 网络中断测试

- [ ] **断开网络连接**
  - [ ] 观察 Bot 行为
  - [ ] 终端日志显示错误信息
  - [ ] Bot 尝试重连

- [ ] **恢复网络连接**
  - [ ] Bot 自动恢复连接
  - [ ] 继续正常工作

### 5.2 数据库错误测试

- [ ] **删除数据库文件（Bot 运行中）**
  ```bash
  rm data/reynard.db
  ```
  - [ ] Bot 检测到错误
  - [ ] 自动重新创建数据库
  - [ ] 或优雅地处理错误

### 5.3 Webhook 失败测试

- [ ] **配置无效的 Webhook URL**
  - `.env` 中设置错误的 URL

- [ ] **发送消息**
  - [ ] Webhook 发送失败
  - [ ] 终端日志记录错误
  - [ ] Bot 继续正常运行（不崩溃）
  - [ ] 消息仍被保存到数据库

**预期结果：** ✅ 错误处理优雅，不影响核心功能

---

## 6. 性能测试

### 6.1 高负载测试

- [ ] **在多个群聊中同时发送消息**
  - [ ] 测试 50+ 条消息/分钟
  - [ ] 观察 CPU 和内存使用
  - [ ] 所有消息都被正确处理

- [ ] **数据库查询性能**
  ```bash
  sqlite3 data/reynard.db "SELECT COUNT(*) FROM messages;"
  ```
  - [ ] 查询速度正常（< 1 秒）

### 6.2 数据库增长测试

- [ ] **收集大量消息（1000+ 条）**
  - [ ] 数据库文件大小合理
  - [ ] 查询性能不下降
  - [ ] 索引正常工作

**预期结果：** ✅ 性能表现良好，可处理高负载

---

## 测试报告模板

```markdown
# Reynard Bot 测试报告

**测试日期：** YYYY-MM-DD
**测试人员：** [Your Name]
**环境：** [Windows/Mac/Linux] + [Node.js 版本] + [Docker 版本]

## 测试结果总结

- ✅ 功能测试：通过
- ✅ Docker 部署测试：通过
- ✅ API 端点测试：通过
- ⚠️ 长期稳定性测试：部分通过
- ❌ 性能测试：失败

## 详细测试记录

### 1. Web UI 登录测试
- 状态：✅ 通过
- 备注：二维码显示正常，登录流程顺畅

### 2. Session 持久化测试
- 状态：✅ 通过
- 备注：重启后自动登录成功

[继续记录其他测试项...]

## 发现的问题

1. **问题描述**
   - 重现步骤
   - 预期结果
   - 实际结果
   - 严重程度：高/中/低

2. ...

## 建议和改进

1. ...
2. ...

## 总体评估

[总结测试结果，给出是否可以上线的建议]
```

---

## 快速测试脚本

创建一个测试脚本 `test.sh` 用于快速验证核心功能：

```bash
#!/bin/bash

echo "🦊 Reynard Bot 快速测试脚本"
echo "================================"

echo "✓ 检查 Node.js 版本..."
node --version

echo "✓ 检查依赖安装..."
npm list --depth=0

echo "✓ 编译 TypeScript..."
npm run build

echo "✓ 检查数据目录..."
ls -la data/

echo "✓ 检查日志目录..."
ls -la logs/

echo "✓ 测试数据库连接..."
sqlite3 data/reynard.db "SELECT COUNT(*) FROM messages;"

echo "================================"
echo "✅ 基础检查完成！"
echo "现在可以运行: npm run dev"
```

使用方式：
```bash
chmod +x test.sh
./test.sh
```
