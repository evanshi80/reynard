import { RecognizedMessage } from '../types';

/**
 * LLM Vision Provider Interface
 * Implement this interface to add new providers
 */
/** Context about the screenshot being analyzed */
export interface RecognizeContext {
  targetName: string;   // 配置的目标名称
  category: string;     // "群聊" | "联系人" | "功能"
  referenceTime?: string; // 参考时间，格式 "YYYY/M/D HH:mm" - 用于顶部没有时间戳时
  /** Batch info for multiple images processing */
  batchInfo?: {
    imageCount: number;   // Total images in batch
    imageIndex: number;   // Current image index (0-based)
    earliestTime: string; // Earliest timestamp in batch
    latestTime: string;   // Latest timestamp in batch
  };
}

export interface VisionProvider {
  /**
   * Recognize text from images
   * @param imageBuffers - Array of PNG image buffers (sent in one API call)
   * @param context - Optional target context for better prompt
   * @returns Parsed message data
   */
  recognize(imageBuffers: Buffer[], context?: RecognizeContext): Promise<RecognizedMessage>;

  /**
   * Check if provider is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get provider name
   */
  getName(): string;
}

/**
 * Factory function to get the appropriate provider
 */
export function createVisionProvider(): VisionProvider {
  const { config } = require('../config');

  switch (config.vision.provider) {
    case 'ollama':
      return new OllamaProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'disabled':
      return new DisabledProvider();
    default:
      throw new Error(`Unknown vision provider: ${config.vision.provider}`);
  }
}

/**
 * Build extraction prompt for single image, with batch context for time order and duplicate handling.
 */
function buildPrompt(context?: RecognizeContext): string {
  const now = new Date();
  const today = `${now.getMonth() + 1}/${now.getDate()}`;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[now.getDay()];

  let header = '分析这张微信聊天截图，提取所有消息内容。\n';

  // Add batch context for time order and duplicate handling
  const batchInfo = context?.batchInfo;
  if (batchInfo) {
    header += `\n【批处理信息】这是批量图片中的第 ${batchInfo.imageIndex + 1} 张，共 ${batchInfo.imageCount} 张。\n`;
    header += `图片时间顺序：第1张是最早的历史（顶部），最后1张是最近的消息（底部）。\n`;
    header += `本张图片的时间范围：${batchInfo.earliestTime} → ${batchInfo.latestTime}\n`;
    header += `重要：请务必检查并排除与相邻图片重复的消息！相邻图片可能有重叠区域（消息重复出现在两张图片底部和顶部）。\n`;
  }

  if (context) {
    const isGroup = context.category === '群聊';
    header += `\n已知信息：这是一个${isGroup ? '群聊' : '私聊（好友对话）'}，名称为"${context.targetName}"。\n`;
    if (!isGroup) {
      header += `私聊规则：左侧消息的发送者是"${context.targetName}"（对方），右侧消息的发送者是"我"（自己）。\n`;
      header += `重要：右侧消息的sender字段必须填"我"，不要填昵称或其他内容。\n`;
    }
    // Add reference time for handling messages without visible timestamps
    if (context.referenceTime) {
      header += `重要：如果截图中最顶部（或某条消息）没有显示时间戳，但该消息下方有另一个消息显示了时间戳 "${context.referenceTime}"，那么该消息的时间也视为 "${context.referenceTime}"。\n`;
    }
  }

  return `${header}
重要规则：
1. 今天日期是 ${today}，星期是 ${weekday}
2. **微信时间戳是聚合UI**：在聊天界面中，时间戳显示在消息组的顶部。例如"14:27"这条时间下面可能有5条消息，这5条消息都使用同一个时间"14:27"。不要把时间戳行当作消息返回！
3. **严格使用截图中的时间戳**：你必须直接复制截图上显示的时间字符串，不要推理、猜测或转换！
   - 如果截图显示 "14:27"，time 就填 "14:27"
   - 如果截图显示 "1/15 09:30"，time 就填 "1/15 09:30"
   - 如果截图显示 "星期三 20:40"，time 就填 "星期三 20:40"
   - **绝对不要**把 "14:27" 转换成其他形式！
4. **每条消息都必须有time**：即使是继承的时间，也要在time字段填写该时间组的聚合时间！
   - 例如：聚合时间 "14:27" 下面有5条消息，这5条的time都填 "14:27"
   - 绝对不要填 null！
5. 区分群聊和私聊：
   - 群聊：每条消息上方有发送者昵称，准确识别昵称
   - 私聊：消息分左右两侧，左侧=对方（sender="${context?.targetName || '对方'}"), 右侧="我"（sender="我"）
6. **处理重复消息**：批量图片之间可能有重叠区域（同一条消息出现在上一张底部和下一张顶部）。如果发现完全相同或几乎相同的内容（sender相同、content相同、time相近），只保留第一条出现的！

请以 JSON 格式返回，必须包含 roomName 和 messages：
{
  "roomName": "${context ? context.targetName : '聊天名称'}",
  "messages": [
    {"index": 0, "sender": "发送者昵称", "content": "消息内容", "time": "14:27"},
    {"index": 1, "sender": "发送者昵称", "content": "消息内容", "time": "14:27"},
    {"index": 2, "sender": "发送者昵称", "content": "消息内容", "time": "14:27"},
    {"index": 3, "sender": "发送者昵称", "content": "消息内容", "time": "昨天 20:30"},
    {"index": 4, "sender": "发送者昵称", "content": "消息内容", "time": "昨天 20:30"}
  ]
}

注意：
- **每条消息的time字段必须填写**：即使是继承的时间，也要填写该时间组的聚合时间！
- index表示消息在截图中的顺序（从顶部0开始递增）
- **严格严格严格**：time 字段必须完全复制截图中的时间字符串，不要转换！
- sender必须是准确的发送者昵称，群聊不要漏掉发送者
- 私聊右侧消息sender必须是"我"
- **去重**：如果本张图片的顶部消息与上一张图片的底部消息相同（或高度相似），应该排除
- 只返回 JSON，不要包裹在 code block 里。`;
}

/**
 * Ollama Provider (Local) - Supports llava and moondream
 */
export class OllamaProvider implements VisionProvider {
  private baseUrl: string;
  private model: string;
  private isMoondream: boolean;

  constructor() {
    const { config } = require('../config');
    this.baseUrl = config.vision.apiUrl || 'http://localhost:11434';
    this.model = config.vision.model || 'moondream';
    this.isMoondream = this.model.toLowerCase().includes('moondream');
  }

  getName(): string {
    return `Ollama (${this.model})${this.isMoondream ? ' ⚡' : ''}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const axios = require('axios');
      await axios.get(`${this.baseUrl}/api/tags`);
      return true;
    } catch {
      return false;
    }
  }

  async recognize(imageBuffers: Buffer[], context?: RecognizeContext): Promise<RecognizedMessage> {
    const axios = require('axios');
    const { config } = require('../config');

    const base64Images = imageBuffers.map(b => b.toString('base64'));
    const prompt = buildPrompt(context);

    let response;

    if (this.isMoondream) {
      // Moondream uses /api/chat endpoint
      response = await axios.post(`${this.baseUrl}/api/chat`, {
        model: this.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: base64Images,
          },
        ],
        stream: false,
      });

      const text = response.data.message?.content || response.data.response || '';
      return parseVisionResponse(text, 'Ollama');
    } else {
      // LLaVA and other models use /api/generate endpoint (single image only)
      // For multiple images, send first image only as fallback
      const base64Image = base64Images[0];
      response = await axios.post(`${this.baseUrl}/api/generate`, {
        model: this.model,
        prompt,
        images: [base64Image],
        stream: false,
        options: {
          temperature: config.vision.temperature,
          num_predict: config.vision.maxTokens,
        },
      });

      const text = response.data.response;
      return parseVisionResponse(text, 'Ollama');
    }
  }

}

/**
 * Shared robust JSON parser for all vision providers.
 * Attempts: direct parse → code block extraction → regex {…} → graceful fallback.
 */
function parseVisionResponse(text: string, providerName: string): RecognizedMessage {
  const logger = require('../utils/logger').default;

  if (!text) {
    logger.debug(`${providerName}: empty response text, returning empty messages`);
    return { roomName: '未知群聊', messages: [] };
  }

  // Log raw response for debugging
  logger.info(`${providerName}: raw response: ${text}`);

  // 1. Direct JSON parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // 2. Extract from ```json ... ``` code block
  const codeBlockMatch = text.match(/```json?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {
      // continue
    }
  }

  // 3. Extract first {…} from text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // continue
    }
  }

  // 4. Graceful fallback — log raw text for debugging, return empty messages
  logger.warn(`${providerName}: could not parse response as JSON, raw text: ${text.substring(0, 300)}`);
  return { roomName: '未知群聊', messages: [] };
}

/**
 * OpenAI Provider (GPT-4o)
 */
export class OpenAIProvider implements VisionProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor() {
    const { config } = require('../config');
    this.apiKey = config.vision.apiKey || process.env.OPENAI_API_KEY || '';
    this.model = config.vision.model || 'gpt-4o';
    this.baseUrl = config.vision.apiUrl || '';
  }

  getName(): string {
    return `OpenAI (${this.model})`;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const { OpenAI } = require('openai');
      const client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl || undefined,
      });
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async recognize(imageBuffers: Buffer[], context?: RecognizeContext): Promise<RecognizedMessage> {
    const { OpenAI } = require('openai');
    const { config } = require('../config');

    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl || undefined,
    });
    const prompt = buildPrompt(context);

    // Build content array with text and all images
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: prompt },
    ];

    // Add all images
    for (const imageBuffer of imageBuffers) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${imageBuffer.toString('base64')}`,
        },
      });
    }

    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
      max_tokens: config.vision.maxTokens,
      temperature: config.vision.temperature,
    });

    const text = response.choices[0]?.message?.content || '';
    return parseVisionResponse(text, 'OpenAI');
  }
}

/**
 * Anthropic Provider (Claude 3)
 */
export class AnthropicProvider implements VisionProvider {
  private apiKey: string;
  private model: string;

  constructor() {
    const { config } = require('../config');
    this.apiKey = config.vision.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = config.vision.model || 'claude-sonnet-4-20250514';
  }

  getName(): string {
    return `Anthropic (${this.model})`;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const axios = require('axios');
      await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': this.apiKey },
      });
      return true;
    } catch {
      return false;
    }
  }

  async recognize(imageBuffers: Buffer[], context?: RecognizeContext): Promise<RecognizedMessage> {
    const { config } = require('../config');
    const axios = require('axios');
    const prompt = buildPrompt(context);

    // Build content array with all images first, then text
    const content: Array<{ type: string; source?: { type: string; media_type: string; data: string }; text?: string }> = [];

    // Add all images
    for (const imageBuffer of imageBuffers) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBuffer.toString('base64'),
        },
      });
    }
    // Add text prompt
    content.push({ type: 'text', text: prompt });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        max_tokens: config.vision.maxTokens,
        temperature: config.vision.temperature,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      },
      {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const text = response.data.content?.[0]?.text || '';
    return parseVisionResponse(text, 'Anthropic');
  }
}

/**
 * Disabled Provider (for testing without LLM)
 */
export class DisabledProvider implements VisionProvider {
  getName(): string {
    return 'Disabled';
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async recognize(): Promise<RecognizedMessage> {
    return {
      roomName: '测试群聊',
      messages: [{ index: 0, sender: '测试', content: 'LLM 已禁用', time: '' }],
    };
  }
}
