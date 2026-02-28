# Reynard - WeChat Vision Monitor 🦊

Windows 微信监控工具，通过截图 + VLM（视觉大模型）非侵入式采集聊天消息。不涉及微信协议逆向。

## 核心流程

截图采集 → VLM/OCR 识图 → 消息入库(SQLite) → Webhook 推送 / Web 查看

## 核心特性

- **滚动断点截图** - 通过 OCR 识别时间戳，只截图新消息，跳过已读内容
- **多 VLM 支持** - Ollama (本地)、OpenAI、Anthropic、Qwen (DashScope)
- **增量监控** - 每次只处理新消息，节省 API 调用
- **VLM 批量处理** - 多截图合并发送，支持 overlap 避免消息截断
- **智能 Backoff** - 无新消息时自动退避，减少无效 API 调用
- **Web UI** - 本地 Web 查看消息和系统状态
- **Webhook** - 消息推送到外部系统 (n8n 等)

## 快速开始

### 前置要求

- Windows 10/11
- Node.js 18+
- Tesseract (用于 OCR)
- AutoHotkey v2 (用于 UI 自动化)
- VLM API (Ollama 本地部署或云服务)

### 安装依赖

```bash
# 安装 Node 依赖
npm install

# 安装 Tesseract (需要添加到 PATH)
# https://github.com/UB-Mannheim/tesseract/wiki

# 安装 AutoHotkey v2
# https://www.autohotkey.com/v2/
```

### 配置

```bash
cp .env.example .env
# 编辑 .env 文件
```

### 运行

```bash
# 开发模式
npm run dev

# 编译
npm run build

# 生产模式
npm start
```

## VLM 配置

### Ollama (本地)

```env
VISION_PROVIDER=ollama
VISION_API_URL=http://localhost:11434
VISION_MODEL=moondream
```

### OpenAI

```env
VISION_PROVIDER=openai
VISION_API_KEY=sk-...
VISION_MODEL=gpt-4o-mini
```

### Anthropic

```env
VISION_PROVIDER=anthropic
VISION_API_KEY=sk-ant-api03-...
VISION_MODEL=claude-sonnet-4-20250514
```

### Qwen (DashScope)

```env
VISION_PROVIDER=openai
VISION_API_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
VISION_API_KEY=qwen-api-key
VISION_MODEL=qwen3-vl-plus-2025-12-19
```

## Patrol 配置

### 巡逻间隔

```env
PATROL_INTERVAL=20000  # 毫秒，默认 20 秒
```

### Backoff 机制

当巡逻成功执行但没有新消息时，会自动应用退避策略：

- 第 1 次无新消息 → 下次等待 40 秒
- 第 2 次无新消息 → 下次等待 60 秒
- 第 3 次无新消息 → 下次等待 80 秒 → 然后重置
- 窗口未找到等失败不计入退避

```env
PATROL_MAX_ROUNDS=0  # 0 = 无限巡逻
```

## 项目结构

```
reynard/
├── src/
│   ├── index.ts              # 入口: 初始化 DB → Web → VLM → Patrol → Monitor
│   ├── config/               # 环境变量配置
│   ├── types/                # 类型定义
│   ├── capture/
│   │   ├── windowFinder.ts   # Koffi Win32 API: 窗口枚举/定位/DPI检测
│   │   ├── screenshot.ts     # 截图 + 聊天区域检测 + 增量变化检测
│   │   └── monitor.ts        # 定时截图→VLM分析→入库循环
│   ├── vision/
│   │   ├── providers.ts      # VLM Provider 接口 + Ollama/OpenAI/Anthropic 实现
│   │   └── index.ts          # Vision 模块入口
│   ├── wechat/
│   │   ├── ahkBridge.ts      # Node↔AHK 进程桥接 (stdout JSON 通信)
│   │   └── ocr.ts            # Tesseract OCR: 搜索结果分类定位 + 时间戳识别
│   ├── bot/
│   │   ├── patrol.ts         # 巡逻循环: 遍历目标→截图(断点)→可选问候
│   │   └── starter.ts        # Bot 启动器
│   ├── web/
│   │   ├── server.ts         # Express 服务器
│   │   └── routes.ts         # API 路由
│   ├── webhook/
│   │   ├── queue.ts          # 消息推送队列
│   │   └── sender.ts         # Webhook 发送器
│   ├── database/
│   │   ├── client.ts         # SQLite 客户端
│   │   └── schema.ts         # 表结构
│   └── utils/                # 工具函数
├── scripts/
│   └── wechat.ahk            # AHK v2 脚本: 微信窗口操作 + 滚动操作
├── data/                     # 数据库和截图存储
├── logs/                     # 日志
└── .env                      # 配置
```

## API 端点

### `GET /api/messages`

获取消息列表

```json
{
  "data": [...],
  "total": 100
}
```

### `POST /api/webhook/test`

测试 Webhook

## 许可证

MIT

## 免责声明

本项目仅供学习和研究使用。使用本项目时请遵守微信的使用条款，作者不对使用本项目导致的任何后果负责。建议使用小号进行测试。
