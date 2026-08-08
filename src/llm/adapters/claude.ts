import { LLMAdapter, Message, ChatOptions, LLMResponse } from '../interface';

export class ClaudeAdapter implements LLMAdapter {
  readonly name = 'claude';

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    // 调用 Claude API
    return { content: '...', model: 'claude-3-opus' };
  }

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<string> {
    // 流式输出
  }
}