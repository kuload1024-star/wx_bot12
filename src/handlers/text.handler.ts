import type { Message as WechatyMessage, Contact } from 'wechaty';
import { LLMAdapter, Message } from '../llm/interface';
import { ContextManager } from '../llm/context';
import { logger } from '../utils/logger';
import { handleFeatureCommand } from '../features';
import { loadFeaturesConfig } from '../features/config';

const featuresConfig = loadFeaturesConfig();

export async function handleText(
  msg: WechatyMessage,
  contact: Contact,
  llmAdapter: LLMAdapter,
  contextManager: ContextManager,
  contextId?: string,
  overriddenText?: string,
  isAllowedUser: boolean = true
): Promise<void> {
  const userText = overriddenText ?? msg.text();
  const effectiveId = contextId ?? contact.id;

  try {
    // Check for feature commands first (only for whitelisted users)
    if (isAllowedUser) {
      const featureResult = await handleFeatureCommand(userText, contact.id, true, featuresConfig);
      if (featureResult.handled) {
        if (featureResult.reply) {
          await msg.say(featureResult.reply);
          logger.info(`[功能] ${contact.name()} 使用了功能命令: "${userText.slice(0, 50)}"`);
        }
        return;
      }
    }

    // Build user message
    const userMsg: Message = { role: 'user', content: userText };
    contextManager.addMessage(effectiveId, userMsg);

    // Get conversation history
    const history = contextManager.getHistory(effectiveId);

    // Call LLM
    logger.info(`[LLM] 发送给 ${llmAdapter.name}: "${userText.slice(0, 50)}..."`);
    const response = await llmAdapter.chat(history);

    // 如果 LLM 返回空内容（如 Mock 关闭复读），不存储也不回复
    if (!response.content) {
      logger.info(`[LLM] 空响应，跳过回复 (ctx=${effectiveId.slice(0, 20)}...)`);
      return;
    }

    // Store assistant response
    const assistantMsg: Message = { role: 'assistant', content: response.content };
    contextManager.addMessage(effectiveId, assistantMsg);

    // Send reply
    await msg.say(response.content);
    logger.info(`[LLM] 回复已发送给 ${contact.name()} (ctx=${effectiveId.slice(0, 20)}...): "${response.content.slice(0, 50)}..."`);
  } catch (error) {
    logger.error(`[LLM] 处理 ${contact.name()} 的消息时出错:`, error);
    await msg.say('抱歉，我遇到了一些问题，请稍后再试。');
  }
}