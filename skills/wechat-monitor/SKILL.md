# WeChat Monitor - 微信消息查询与分析

## 功能
- 查询微信群聊消息
- 使用 LLM 分析消息内容，提取结构化信息
- 支持多种分析用例（订单统计、信息汇总、趋势分析等）

## When to Use
- 用户想了解微信群聊的消息内容
- 用户需要对群聊消息进行统计分析
- 用户想提取特定类型的信息（如订单、产品、供应商等）

## When NOT to Use
- 实时聊天场景（API 有延迟）
- 需要获取多媒体内容（图片、语音等）

## API 调用

### 1. 获取群聊列表
```bash
curl http://localhost:3000/api/messages/rooms
```

响应：
```json
{
  "rooms": ["采购群", "技术讨论组", "家庭群"]
}
```

### 2. 获取消息（支持增量查询）
```bash
curl "http://localhost:3000/api/messages?since={上次时间}&room={群名}&limit=100"
```

#### 参数说明
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| since | number | 否 | 开始时间戳（Unix 毫秒），获取该时间之后的增量消息 |
| until | number | 否 | 结束时间戳（Unix 毫秒） |
| room | string | 否 | 群聊名称筛选，精确匹配 |
| limit | number | 否 | 返回数量上限，默认 100 |

#### 响应字段
```json
{
  "messages": [
    {
      "roomName": "采购群",
      "talkerName": "张三",
      "content": "消息内容",
      "timestamp": 1738214400000,
      "msgIndex": 0
    }
  ]
}
```

#### 字段说明
| 字段 | 类型 | 说明 |
|------|------|------|
| roomName | string | 群聊名称 |
| talkerName | string | 发送者名称 |
| content | string | 消息文本内容 |
| timestamp | number | Unix 毫秒时间戳 |
| msgIndex | number | 同时间消息序号（用于区分同一时刻的多条消息） |

#### 时间转换
```javascript
// timestamp 转为可读时间
new Date(timestamp).toLocaleString('zh-CN')

// 示例：1738214400000 -> "2024/1/30 16:00:00"
```

## 消息分析（使用 LLM）

### 分析流程
1. 调用 `/api/messages/rooms` 获取群聊列表
2. 根据用户需求确定目标群聊（如"采购群"）
3. 调用 `/api/messages?since=...&room=...` 获取增量消息
4. 将消息列表格式化为易读格式
5. 调用 LLM 分析消息，根据用户需求提取信息
6. 输出分析结果（表格、图表等）

### LLM Prompt 框架
```
分析以下微信群聊消息，提取 {用户指定的信息类型}：

消息列表：
1. [发送者] 消息内容 时间
2. [发送者] 消息内容 时间
...

请根据需求 "{用户指令}" 进行分析，并输出结构化结果。
```

### 示例：订单统计
```
用户指令：统计采购群的订单情况

LLM Prompt：
分析以下微信群聊消息，提取采购订单信息：

消息列表：
1. [张三] 订购 A产品 1000个，单价10元 12:30
2. [李四] B公司供货，总价5000元 14:20
3. [王五] 采购 C产品 50箱 16:00

请输出：
- 产品统计：各产品订购数量和金额
- 供应商统计：各供应商订单金额
- 汇总表格
```

### 示例：信息汇总
```
用户指令：汇总技术讨论组的热点话题

LLM Prompt：
分析以下微信群聊消息，汇总热点话题：

消息列表：
[消息内容...]

请输出：
- 热点话题排名
- 参与讨论的人员统计
- 讨论摘要
```

## 远程控制

### 3. 获取巡逻状态
```bash
curl http://localhost:3000/api/patrol/status
```

响应：
```json
{
  "running": true,
  "roundCount": 5,
  "consecutiveNoNewMessages": 2,
  "backoffLevel": 2,
  "currentInterval": 40000,
  "maxRounds": 0,
  "targets": [{"name": "n8n测试群", "category": "群聊"}],
  "lastMessageTime": 1738214400000
}
```

#### 字段说明
| 字段 | 类型 | 说明 |
|------|------|------|
| running | boolean | 巡逻是否运行中 |
| roundCount | number | 已执行巡逻轮数 |
| consecutiveNoNewMessages | number | 连续无新消息次数 |
| backoffLevel | number | 当前退避等级（0-3） |
| currentInterval | number | 当前巡逻间隔（毫秒） |
| maxRounds | number | 最大巡逻轮数（0=无限） |
| targets | array | 监控目标列表 |
| lastMessageTime | number | 最后一条消息的时间戳 |

### 4. 启动巡逻
```bash
curl -X POST http://localhost:3000/api/patrol/start
```

### 5. 停止巡逻
```bash
curl -X POST http://localhost:3000/api/patrol/stop
```

### 6. 修改巡逻配置
```bash
curl -X POST http://localhost:3000/api/patrol/config \
  -H "Content-Type: application/json" \
  -d '{
    "patrolInterval": 30000,
    "patrolMaxRounds": 10,
    "targets": [
      {"name": "群名1", "category": "群聊"},
      {"name": "群名2", "category": "群聊"}
    ]
  }'
```

#### 参数说明
| 参数 | 类型 | 说明 |
|------|------|------|
| patrolInterval | number | 巡逻间隔（毫秒），最小 1000 |
| patrolMaxRounds | number | 最大巡逻轮数，0=无限 |
| targets | array | 监控目标列表 |

## 远程控制 WeChat

### 7. 发送消息到联系人/群聊

```bash
# 发送给联系人
curl -X POST http://localhost:3000/api/wechat/send \
  -H "Content-Type: application/json" \
  -d '{
    "contact": "张三",
    "message": "你好！"
  }'

# 发送给群聊（需要指定 category 为 "群聊"）
curl -X POST http://localhost:3000/api/wechat/send \
  -H "Content-Type: application/json" \
  -d '{
    "contact": "采购群",
    "message": "你好！",
    "category": "群聊"
  }'
```

#### 参数说明
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| contact | string | 是 | 联系人或群聊名称 |
| message | string | 是 | 要发送的消息内容 |
| category | string | 否 | 类别，默认 "联系人"，群聊填写 "群聊" |

#### 响应
```json
{
  "success": true,
  "contact": "采购群",
  "message": "你好！",
  "category": "群聊"
}
```

### 8. 打开聊天窗口

```bash
# 打开联系人聊天
curl -X POST http://localhost:3000/api/wechat/open \
  -H "Content-Type: application/json" \
  -d '{
    "contact": "张三"
  }'

# 打开群聊聊天（需要指定 category 为 "群聊"）
curl -X POST http://localhost:3000/api/wechat/open \
  -H "Content-Type: application/json" \
  -d '{
    "contact": "采购群",
    "category": "群聊"
  }'
```

#### 参数说明
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| contact | string | 是 | 联系人或群聊名称 |
| category | string | 否 | 类别，默认 "联系人"，群聊填写 "群聊" |

### 9. 激活微信窗口

```bash
curl -X POST http://localhost:3000/api/wechat/activate
```

### 10. 检查 AHK 状态

```bash
curl http://localhost:3000/api/wechat/status
```

响应：
```json
{
  "ahkAvailable": true
}
```

### 队列说明
当巡逻（patrol）正在运行时，WeChat 远程控制操作会自动排队等候，确保不会与巡逻任务冲突。

## 动态获取

### 获取完整 API 定义
建议在每次使用时获取最新的 API 定义，以确保使用最新接口：

```bash
curl http://localhost:3000/api/skills/definition
```

响应包含：
- 所有可用端点列表
- 当前巡逻状态
- 查询参数 schemas
- 当前监控目标

这样可以动态获取当前运行状态，无需硬编码配置。

## 注意事项
1. API 返回的是增量消息，需要记录上次查询时间（timestamp）用于下次增量获取
2. 消息内容为纯文本，不包含图片、语音等多媒体
3. 建议每次查询间隔至少 10 秒，避免对系统造成压力
4. backoffLevel > 0 时表示当前处于退避状态，巡逻间隔会自动延长
5. 使用 `/api/skills/definition` 动态获取最新配置，无需手动更新 Skill
