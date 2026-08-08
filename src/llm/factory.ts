import { LLMAdapter } from './interface';
import { LLMConfig } from '../config/types';
import { MockAdapter } from './adapters/mock';
import { logger } from '../utils/logger';

export function createLLMAdapter(config: LLMConfig): LLMAdapter {
  logger.info(`创建 LLM 适配器: ${config.provider}`);

  switch (config.provider) {
    case 'mock':
      return new MockAdapter(config.options as { mockEcho?: boolean });

    case 'openai':
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { OpenAIAdapter } = require('./adapters/openai');
        return new OpenAIAdapter(config.options as any);
      } catch (err) {
        console.error('[DEBUG] 加载 openai 适配器失败:', err);
        throw new Error(
          'OpenAI 适配器加载失败: ' + (err instanceof Error ? err.message : String(err))
        );
      }

    case 'qwen':
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { QwenAdapter } = require('./adapters/qwen');
        return new QwenAdapter(config.options);
      } catch {
        throw new Error(
          'Qwen 适配器尚未实现。' +
          '如需使用，请实现 src/llm/adapters/qwen.ts'
        );
      }

    case 'claude':
       const { ClaudeAdapter } = require('./adapters/claude');
       return new ClaudeAdapter(config.options);



    default:
      throw new Error(`未知的 LLM 提供商: ${config.provider}。支持的选项: mock, openai, qwen`);
  }
}