import { LLMAdapter, Message, ChatOptions, LLMResponse } from '../interface';
import { logger } from '../../utils/logger';
import axios from 'axios';

type ApiType = 'responses' | 'chat_completions';

export interface OpenAIOptions {
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  apiType?: ApiType;
}

const VALID_OPTION_KEYS = ['model', 'baseURL', 'apiKey', 'temperature', 'maxTokens', 'headers', 'apiType'];
const ALLOWED_CHAT_FIELDS = ['model', 'messages', 'input', 'temperature', 'max_tokens', 'max_output_tokens', 'stream', 'reasoning_effort'];

export class OpenAIAdapter implements LLMAdapter {
  readonly name = 'openai';
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private headers: Record<string, string>;
  private apiType: ApiType;

  constructor(options: OpenAIOptions) {
    const cleanOptions: Record<string, any> = {};
    for (const key of VALID_OPTION_KEYS) {
      if ((options as Record<string, any>)[key] !== undefined) {
        cleanOptions[key] = (options as Record<string, any>)[key];
      }
    }

    const apiKey = cleanOptions.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('缺少 API Key');
    }
    if (!cleanOptions.model) {
      throw new Error('缺少 model 配置');
    }

    this.apiKey = String(apiKey);
    this.model = String(cleanOptions.model);
    this.baseURL = String(cleanOptions.baseURL || 'https://api.openai.com');
    this.headers = cleanOptions.headers || {};
    this.apiType = (cleanOptions.apiType as ApiType) || 'chat_completions';

    logger.info(`[OpenAIAdapter] 初始化完成, model=${this.model}, baseURL=${this.baseURL}, apiType=${this.apiType}`);
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const payload = this.sanitizePayload(this.buildPayload(messages, options));
    const url = this.buildUrl();

    logger.debug(`[OpenAIAdapter] 调用 chat (${this.apiType}), 消息数: ${messages.length}`);

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        timeout: 120000,
      });

      const data = response.data;
      const content = this.extractContent(data);

      logger.debug(`[OpenAIAdapter] chat 返回, content长度: ${content.length}`);

      return {
        content,
        model: data.model || this.model,
        usage: this.extractUsage(data),
      };
    } catch (err: any) {
      if (err.response) {
        const status = err.response.status;
        const body = JSON.stringify(err.response.data).slice(0, 500);
        logger.error(`[OpenAIAdapter] API 错误 ${status}: ${body}`);
      }
      throw err;
    }
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<string> {
    const payload = this.sanitizePayload({ ...this.buildPayload(messages, options), stream: true });
    const url = this.buildUrl();

    logger.debug(`[OpenAIAdapter] 调用 chatStream (${this.apiType}), 消息数: ${messages.length}`);

    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.headers,
        'Accept': 'text/event-stream',
      },
      responseType: 'stream',
      timeout: 120000,
    });

    const stream = response.data;
    if (stream && typeof stream.on === 'function') {
      for await (const chunk of stream as any) {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
            try {
              const event = JSON.parse(trimmed.slice(6));
              const delta = this.extractStreamDelta(event);
              if (delta) {
                yield delta;
              }
            } catch {
            }
          }
        }
      }
    }
  }

  private buildUrl(): string {
    const path = this.apiType === 'responses' ? '/responses' : '/chat/completions';
    return `${this.baseURL}${path}`;
  }

  private buildPayload(messages: Message[], options?: ChatOptions): Record<string, any> {
    if (this.apiType === 'responses') {
      const input: Array<{ role: string; content: string }> = [];
      if (options?.systemPrompt) {
        input.push({ role: 'system', content: options.systemPrompt });
      }
      for (const msg of messages) {
        input.push({ role: msg.role, content: msg.content });
      }
      return {
        model: this.model,
        input,
        temperature: options?.temperature,
        max_output_tokens: options?.maxTokens,
      };
    }

    const chatMessages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      chatMessages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const msg of messages) {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
    return {
      model: this.model,
      messages: chatMessages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
    };
  }

  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const key of ALLOWED_CHAT_FIELDS) {
      const val = payload[key];
      if (val !== undefined && val !== null) {
        result[key] = val;
      }
    }
    return result;
  }

  private extractContent(data: any): string {
    if (!data) return '';

    if (this.apiType === 'responses') {
      if (data.output_text) return data.output_text;
      if (Array.isArray(data.output)) {
        const parts: string[] = [];
        for (const item of data.output) {
          if (item?.content) {
            if (typeof item.content === 'string') {
              parts.push(item.content);
            } else if (Array.isArray(item.content)) {
              for (const c of item.content) {
                if (c?.type === 'output_text' && c.text) {
                  parts.push(c.text);
                }
              }
            }
          }
        }
        if (parts.length > 0) return parts.join('');
      }
    }

    const choice = data.choices?.[0];
    if (choice?.message?.content) {
      let text = choice.message.content;
      if (choice.message.reasoning_content) {
        text = choice.message.reasoning_content + '\n\n' + text;
      }
      return text;
    }

    return '';
  }

  private extractUsage(data: any) {
    if (data?.usage) {
      const usage = data.usage;
      return {
        promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      };
    }
    return undefined;
  }

  private extractStreamDelta(event: any): string {
    if (this.apiType === 'responses') {
      if (event?.delta) return event.delta;
      if (event?.output_text) return event.output_text;
      if (event?.content_block_delta?.delta) {
        return event.content_block_delta.delta;
      }
    }

    const delta = event?.choices?.[0]?.delta;
    if (delta?.content) {
      return delta.content;
    }
    if (delta?.reasoning_content) {
      return delta.reasoning_content;
    }

    return '';
  }
}