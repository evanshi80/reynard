export interface Config {
  vision: {
    provider: 'ollama' | 'openai' | 'anthropic' | 'disabled';
    model: string;
    apiUrl?: string;
    apiKey?: string;
    temperature: number;
    maxTokens: number;
    // 消息提取模式: 'vlm' = VLM截图识别, 'text' = 聊天记录文本+OCR
    extractMode: 'vlm' | 'text';
  };
  capture: {
    enabled: boolean;
    windowName: string;
    saveScreenshots: boolean;
    screenshotDir: string;
  };
  web: {
    port: number;
    host: string;
    enabled: boolean;
  };
  database: {
    path: string;
  };
  webhook: {
    url?: string;
    enabled: boolean;
    batchSize: number;
    batchInterval: number;
  };
  monitoring: {
    rooms: string[];  // 监控的群聊名称列表（空则监控所有）
    logLevel: string;
  };
  bot: {
    // 要打开聊天的目标列表: "群名|群聊", "好友名|联系人"
    targets: Array<{ name: string; category: string }>;
    // 问候消息
    greetingMessage: string;
    // 是否在首次巡逻时发送问候
    greetingEnabled: boolean;
    // 每个目标之间的等待时间（毫秒）
    delayBetweenTargets: number;
  };
  ocr: {
    // OCR预处理：缩放倍数
    resizeScale: number;
    // OCR预处理：对比度增益
    contrastGain: number;
    // OCR预处理：亮度偏移
    brightnessOffset: number;
    // 搜索结果加载等待时间（毫秒）
    searchLoadWait: number;
    // 是否保存OCR调试图片（裁剪/预处理后）
    debugArtifacts: boolean;
  };
  patrol: {
    // 巡逻间隔（毫秒）
    interval: number;
    // 每次巡逻目标之间的等待时间（毫秒）
    targetDelay: number;
    // 最大巡逻轮数（0 = 无限）
    maxRounds: number;
  };
  vlm: {
    // VLM 分析周期间隔（毫秒）
    cycleInterval: number;
    // 拼合图最大高度（像素）
    maxImageHeight: number;
    // 处理后是否删除截图
    cleanupProcessed: boolean;
  };
}

export interface MessageRecord {
  id?: number;
  messageId: string;
  roomId: string;
  roomName: string;
  talkerId: string;
  talkerName: string;
  content: string;
  messageType: string;
  timestamp: number;
  msgIndex?: number;
  rawData: string;
  createdAt?: number;
}

export interface WebhookPayload {
  messageId: string;
  roomId: string;
  roomName: string;
  talkerId: string;
  talkerName: string;
  content: string;
  messageType: string;
  timestamp: number;
}

export interface RecognizedMessage {
  roomName: string;
  messages: Array<{
    index: number;      // 消息在截图中的顺序
    sender: string;
    content: string;
    time: string | null;      // 时间戳，VLM返回null表示需要从后续消息继承
  }>;
}

export interface MonitorStatus {
  running: boolean;
  lastCapture?: string;
  lastRecognize?: string;
  messagesCollected: number;
  errors: number;
}

export interface BotStatus {
  loggedIn: boolean;
  scanning: boolean;
  userName?: string;
  qrcodeUrl?: string;
}
