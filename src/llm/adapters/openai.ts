import { LLMAdapter, Message, ChatOptions, LLMResponse } from '../interface';
import { logger } from '../../utils/logger';
import axios from 'axios';

export interface OpenAIOptions {
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export class OpenAIAdapter implements LLMAdapter {
  readonly name = 'openai';
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private headers: Record<string, string>;

  constructor(options: OpenAIOptions) {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('缺少 OPENAI_API_KEY，请在 .env 中配置或在 options 中传入 apiKey');
    }
    if (!options.model) {
      throw new Error('缺少 model 配置，请在 config/production.json 中指定 llm.options.model');
    }

    this.apiKey = apiKey;
    this.model = options.model;
    this.baseURL = options.baseURL || 'https://api.openai.com';
    this.headers = options.headers || {};

    logger.info(`[OpenAIAdapter] 初始化完成, model=${this.model}, baseURL=${this.baseURL}`);
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const input = this.buildInput(messages, options);

    logger.debug(`[OpenAIAdapter] 调用 chat (Responses API), 输入数: ${input.length}`);

    const response = await axios.post(
      `${this.baseURL}/responses`,
      {
        model: this.model,
        input,
        temperature: options?.temperature,
        max_output_tokens: options?.maxTokens,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        timeout: 120000,
      }
    );

    const data = response.data;
    const content = this.extractContent(data);

    logger.debug(`[OpenAIAdapter] chat 返回, content长度: ${content.length}`);

    return {
      content,
      model: data.model || this.model,
    };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<string> {
    const input = this.buildInput(messages, options);

    logger.debug(`[OpenAIAdapter] 调用 chatStream (Responses API), 输入数: ${input.length}`);

    const response = await axios.post(
      `${this.baseURL}/responses`,
      {
        model: this.model,
        input,
        temperature: options?.temperature,
        max_output_tokens: options?.maxTokens,
        stream: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.headers,
          'Accept': 'text/event-stream',
        },
        responseType: 'stream',
        timeout: 120000,
      }
    );

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

  private buildInput(messages: Message[], options?: ChatOptions): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [];

    if (options?.systemPrompt) {
      result.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content });
    }

    return result;
  }

  private extractContent(data: any): string {
    if (!data) return '';

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

    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }

    return '';
  }

  private extractStreamDelta(event: any): string {
    if (event?.delta) return event.delta;
    if (event?.output_text) return event.output_text;

    if (event?.content_block_delta?.delta) {
      return event.content_block_delta.delta;
    }

    if (event?.message?.content?.[0]?.text) {
      return event.message.content[0].text;
    }

    return '';
  }
}