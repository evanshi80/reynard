# Reynard - WeChat Vision Monitor

## Project Overview

Windows 微信监控工具，通过截图 + VLM（视觉大模型）非侵入式采集聊天消息。不涉及微信协议逆向。

**核心流程**: 截图采集 → VLM/OCR 识图 → 消息入库(SQLite) → Webhook 推送 / Web 查看

**核心特性**: 滚动断点截图 — 通过 OCR 识别时间戳，只截图新消息，跳过已读内容

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2020, CommonJS)
- **FFI**: Koffi (Win32 API 调用) — 禁止使用 ffi-napi
- **截屏**: robotjs (`screen.capture`)
- **图片处理**: sharp
- **OCR**: Tesseract.js (中文 `chi_sim`)
- **UI 自动化**: AutoHotkey v2 (通过 `child_process.execFile` 调用)
- **VLM 提供者**: Ollama / OpenAI / Anthropic / Qwen (DashScope) (可配置)
- **数据库**: better-sqlite3
- **Web**: Express 5
- **日志**: winston + daily-rotate-file
- **开发**: tsx (运行), nodemon (热重载)

## Commands

```bash
npm run dev          # 开发运行 (tsx)
npm run dev:watch    # 热重载开发
npm run build        # TypeScript 编译
npm start            # 运行编译产物
```

## 开发调试

### 停止开发服务器
由于 Claude Code 的 TaskStop 有时无法彻底停止后台进程，请使用以下方法：

```bash
# 方法1: 使用 taskkill 强制停止所有 node 进程
taskkill //F //IM node.exe

# 方法2: 先查找进程再杀死
tasklist | grep node   # 查找 node 进程
taskkill //F //PID <PID>  # 杀死指定进程
```

## Project Structure

```
src/
  index.ts                 # 入口: 初始化 DB → Web → VLM → Patrol → Monitor
  config/index.ts          # 环境变量配置 (dotenv), 所有参数可配
  types/index.ts           # 全局类型定义
  capture/
    windowFinder.ts        # Koffi Win32 API: 窗口枚举/定位/DPI检测
    screenshot.ts          # 截图 + 聊天区域检测 + 增量变化检测
    monitor.ts             # 定时截图→VLM分析→入库循环
  vision/
    providers.ts           # VLM Provider 接口 + Ollama/OpenAI/Anthropic/Qwen 实现
    index.ts               # Vision 模块入口
  wechat/
    ahkBridge.ts           # Node↔AHK 进程桥接 (stdout JSON 通信)
    ocr.ts                 # Tesseract OCR: 搜索结果分类定位 + 时间戳识别
    index.ts               # WeChat 高层操作: 搜索/导航/发送
  bot/
    patrol.ts              # 巡逻循环: 遍历目标→截图(断点)→可选问候
    starter.ts             # Bot 启动器
    index.ts               # Bot 模块入口
  web/
    server.ts              # Express 服务器
    routes.ts              # API 路由
  webhook/
    queue.ts               # 消息推送队列
    sender.ts              # Webhook 发送器
  database/
    client.ts              # SQLite 客户端
    schema.ts              # 表结构
    repositories/          # 数据访问层
  utils/
    logger.ts              # Winston 日志
    rateLimiter.ts         # 速率限制
    delay.ts               # 延时工具
scripts/
  wechat.ahk              # AHK v2 脚本: 微信窗口操作 + 滚动操作
```

## Critical Rules (MUST Follow)

### Koffi / Win32 API

1. **输出参数必须标注 `_Out_`**, 否则函数返回成功但结构体全零:
   ```typescript
   user32.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)');
   ```
2. **需要初始值的参数用 `_Inout_`** (如 cbSize 字段)
3. **回调函数必须声明 `__stdcall`**:
   ```typescript
   const Proto = koffi.proto('bool __stdcall Proto(void *hwnd, intptr_t lParam)');
   ```
4. **结构体传普通 JS 对象**, Koffi 自动 marshal

### DPI 缩放 (最大的坑)

5. **robotjs 坐标不一致**: `getScreenSize()` 返回逻辑分辨率, `screen.capture()` 使用物理像素
6. **所有截图坐标必须乘以 DPI 缩放比**: `physical = logical × scale`
7. **Windows DPI API 可能失败** (返回 96 = 1.0x), 必须有分辨率推算兜底
8. 4K @ 150%: 逻辑 2560x1440, 物理 3840x2160

### AHK 自动化

9. **仅支持 AHK v2**, v1/v2 语法完全不兼容, 脚本须 `#Requires AutoHotkey v2.0`
10. **中文输入必须走剪贴板** (`A_Clipboard + ^v`), `Send` 无法可靠输入中文 (IME 不可控), 且必须保存/恢复原始剪贴板
11. **微信搜索"搜一搜"干扰**: `Home` 键已完成一次焦点下移(跳过搜一搜), 后续 Down 次数要 **减 1**
12. **搜索结果加载需等约 2-2.5 秒**, 通过 `config.ocr.searchLoadWait` 配置, 不要硬编码
13. **AHK 进程通信**: stdout 输出 JSON, 需手动转义 `\ " \n \r`, 加重试机制

### Tesseract OCR 中文

14. **OCR 结果必须去空格**: Tesseract 中文输出每字间有空格, 所有结果必须 `.replace(/\s+/g, '')` 后再匹配
15. **中文识别需模糊匹配**: "群聊"常被误识别为"群获/群了/群人", 用 `isFuzzyMatch` 兜底
16. **OCR 预处理**: 默认 放大 3x + 灰度 + 对比度1.5 + 亮度-20, 参数通过 `OCR_*` 环境变量可配
17. **星期时间戳解析**: 当OCR识别到"星期X"或"周X"时，会解析为**上一周的星期X**（非当天）。例如今天周三，识别到"星期三"会解析为上周三。可通过 `OCR_WEEKDAY_AS_TODAY` 环境变量配置（设为true则视为当天）
18. **recognizeTimestamps 预处理**: 该函数现在会对截图进行预处理（缩放、灰度、增强对比度）后再OCR识别，提高时间戳识别率

### robotjs 像素格式

17. **robotjs 返回 BGRA 格式**, 使用 sharp 前需手动交换 B↔R 通道:
    ```typescript
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = b;
    }
    ```

### 配置规范

18. **所有参数走环境变量 + dotenv**, 不要硬编码魔法数字
19. **新增配置项**: 加 `Config` 类型 → `config/index.ts` 读取 → `.env.example` 文档化
20. 微信窗口查找支持多标识: `ahk_class WeChatMainWndForPC` / `微信` / `WeChat`

### VLM Provider (OpenAI 兼容)

21. **OpenAI Provider 支持自定义 baseURL**, 用于 Qwen DashScope 等兼容 API:
    ```typescript
    // providers.ts
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl || undefined,  // 支持 DashScope 等
    });
    ```
22. **Qwen DashScope 国际站**: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
23. **Qwen 模型**: `qwen3-vl-plus-2025-12-19`, `qwen-vl-plus-2025-12-19`

### 滚动断点截图 (核心功能)

24. **Checkpoint 机制**: 每次截图后保存时间戳到 `data/screenshots/checkpoints/`
25. **新消息识别**: OCR 识别时间戳，与 checkpoint 对比，只截图新内容
26. **时间戳格式支持**:
    - 当日: `HH:mm` (如 `21:35`)
    - 历史斜杠: `M/d HH:mm` (如 `1/15 21:30`)
    - 历史中文: `M月d日 HH:mm` (如 `1月15日 21:30`)
    - 完整日期: `YYYY/M/d HH:mm` (如 `2025/1/15 21:30`)
    - 昨天: `昨天 HH:mm`
    - 星期: `周X HH:mm` / `星期X HH:mm`
27. **比较逻辑**: 使用 epochMs 比较 - 先比较 minEpoch/maxEpoch 与 watermark
28. **滚动策略**:
    - 滚到底部（最新消息）
    - 截图 + OCR 识别时间戳
    - 找到旧 checkpoint 停止（当 minEpoch <= watermark），否则继续向上滚动
    - 最多滚动 10 次（无CP）或 50 次（有CP）
29. **AHK 滚动命令**: `scroll_home` (传递窗口坐标用于动态点击), `scroll_up`

### VLM 批量处理

30. **截图文件名格式**: `patrol_<name>_<runId>_<index>.png`
    - runId: 巡逻批次ID（时间戳后6位），防止重启后覆盖
    - index: 截图序号
31. **RunId 作为幂等单元**: VLM 按 runId 处理，整批完成后更新 watermark
32. **批量 overlap**: 同一次 run 内相邻批次重叠 1 张图，避免消息截断
33. **去重**: VLM 端去重 + 本地去重（按内容 normalized 后比较）

### Patrol Backoff 机制

34. **触发条件**: 巡逻成功执行但没有新消息
35. **指数退避**: 间隔 + (level × interval)
    - level 1: 2× = 40秒 (interval=20s)
    - level 2: 3× = 60秒
    - level 3: 4× = 80秒 → 80秒后重置为 0
36. **失败不计入**: 窗口未找到等失败情况用正常间隔重试，不计入 backoff

## Code Conventions

- TypeScript strict mode
- 日志用 `logger` (winston), 不要 console.log
- 异步操作用 async/await
- 配置集中在 `config/index.ts`, 通过 `getEnv` / `getEnvNumber` / `getEnvBoolean` 读取
- 单例模式: `getCapturer()`, `getMonitor()` 等工厂函数
- VLM Provider 通过接口 `VisionProvider` 扩展, 工厂函数 `createVisionProvider` 分发
- LLM 返回的 JSON 需容错解析: 直接解析 → 提取 code block → 正则提取 `{...}` → 降级返回
- Patrol checkpoint 存储在 `data/screenshots/checkpoints/`
