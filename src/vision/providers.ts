import { RecognizedMessage } from '../types';

/**
 * LLM Vision Provider Interface
 * Implement this interface to add new providers
 */
/** Context about the screenshot being analyzed */
export interface RecognizeContext {
  targetName: string;   // 配置的目标名称
  category: string;     // "群聊" | "联系人" | "功能"
}

export interface VisionProvider {
  /**
   * Recognize text from image
   * @param imageBuffer - PNG image buffer
   * @param context - Optional target context for better prompt
   * @returns Parsed message data
   */
  recognize(imageBuffer: Buffer, context?: RecognizeContext): Promise<RecognizedMessage>;

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
 * Build extraction prompt, optionally enriched with target context.
 */
function buildPrompt(context?: RecognizeContext): string {
  const now = new Date();
  const today = `${now.getMonth() + 1}/${now.getDate()}`;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[now.getDay()];

  let header = '分析这张微信聊天截图，提取所有消息内容。\n';

  if (context) {
    const isGroup = context.category === '群聊';
    header += `\n已知信息：这是一个${isGroup ? '群聊' : '私聊（好友对话）'}，名称为"${context.targetName}"。\n`;
    if (!isGroup) {
      header += `私聊规则：左侧消息的发送者是"${context.targetName}"（对方），右侧消息的发送者是"我"（自己）。\n`;
      header += `重要：右侧消息的sender字段必须填"我"，不要填昵称或其他内容。\n`;
    }
  }

  return `${header}
重要规则：
1. 今天日期是 ${today}，星期是 ${weekday}
2. 时间戳是聚合显示的：如果多条第1条消息上方显示 "19:08"，那么这5条消息的时间都是 19:08
3. 根据时间戳格式推理完整日期：
   - 只有 HH:mm（如 09:30）→ 今天的消息，日期 = ${today}
   - 月/日 HH:mm（如 1/15 09:30）→ 需要根据 ${weekday} 推理
   - 星期X HH:mm（如 周三 21:30）→ 根据今天 ${weekday} 推理是上周的星期X
   - 昨天 HH:mm → ${now.getMonth() + 1}/${now.getDate() - 1}
4. 区分群聊和私聊：
   - 群聊：每条消息上方有发送者昵称，准确识别昵称
   - 私聊：消息分左右两侧，左侧=对方（sender="${context?.targetName || '对方'}"), 右侧="我"（sender="我"）

请以 JSON 格式返回：
{
  "roomName": "${context ? context.targetName : '聊天名称'}",
  "messages": [
    {
      "sender": "发送者昵称",
      "content": "消息内容",
      "time": "2/11 21:43"
    }
  ]
}

注意：
- 准确识别聚合时间戳，每条消息都必须有时间
- sender必须是准确的发送者昵称，群聊不要漏掉发送者
- 私聊右侧消息sender必须是"我"，不要填其他内容
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

  async recognize(imageBuffer: Buffer, context?: RecognizeContext): Promise<RecognizedMessage> {
    const axios = require('axios');
    const { config } = require('../config');

    const base64Image = imageBuffer.toString('base64');
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
            images: [base64Image],
          },
        ],
        stream: false,
      });

      const text = response.data.message?.content || response.data.response || '';
      return parseVisionResponse(text, 'Ollama');
    } else {
      // LLaVA and other models use /api/generate endpoint
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

  async recognize(imageBuffer: Buffer, context?: RecognizeContext): Promise<RecognizedMessage> {
    const { OpenAI } = require('openai');
    const { config } = require('../config');

    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl || undefined,
    });
    const prompt = buildPrompt(context);

    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${imageBuffer.toString('base64')}`,
              },
            },
          ],
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

  async recognize(imageBuffer: Buffer, context?: RecognizeContext): Promise<RecognizedMessage> {
    const { config } = require('../config');
    const axios = require('axios');
    const prompt = buildPrompt(context);

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        max_tokens: config.vision.maxTokens,
        temperature: config.vision.temperature,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: imageBuffer.toString('base64'),
                },
              },
              { type: 'text', text: prompt },
            ],
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
      messages: [{ sender: '测试', content: 'LLM 已禁用', time: null }],
    };
  }
}
