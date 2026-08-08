import type { Message as WechatyMessage } from 'wechaty';
import { types } from 'wechaty';
import { LLMAdapter } from '../llm/interface';
import { ContextManager } from '../llm/context';
import { handleText } from './text.handler';
import { handleFallback } from './fallback.handler';
import { handleVideoShare } from './video.handler';
import { detectVideoShare } from '../utils/url-detector';
import { DownloaderClient } from '../downloader/api';
import { logger } from '../utils/logger';

/**
 * Check if the bot is @mentioned in the message text.
 * Handles common WeChat @mention formats: "@BotName", "@BotName ", etc.
 */
function isBotMentioned(text: string, botName: string): boolean {
  // Escape special regex characters in bot name
  const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionPattern = new RegExp(`@${escapedName}([\\s\u2005\u00a0]|$)`, 'i');
  return mentionPattern.test(text);
}

/**
 * Remove @botName mention(s) from the message text.
 */
function cleanMentionText(text: string, botName: string): string {
  const escapedName = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionPattern = new RegExp(`@${escapedName}[\\s\u2005\u00a0]*`, 'gi');
  return text.replace(mentionPattern, '').trim();
}

export async function routeMessage(
  msg: WechatyMessage,
  llmAdapter: LLMAdapter,
  contextManager: ContextManager,
  botName: string,
  downloader: DownloaderClient,
  noteImageThreshold: number,
  requireMentionGroup: boolean = true,
  requireMentionPrivate: boolean = false,
  allowedPrivateUsers?: string[],
  allowedGroupNames?: string[],
): Promise<void> {
  // Ignore self messages to prevent loops
  if (msg.self()) {
    return;
  }

  const contact = msg.talker();
  const room = msg.room();
  const msgType = msg.type();
  let text = msg.text();
  const contactName = await contact.name();
  let isAllowedUser = false;

  // ── Group (room) messages ──────────────────────────────────────────
  if (room) {
    const roomName = await room.topic();
    logger.info(`[路由] 群消息: 当前群="${roomName}", 白名单=${JSON.stringify(allowedGroupNames)}`);

    // --- 群名白名单检查 ---
    if (allowedGroupNames !== undefined) {
      if (allowedGroupNames.length === 0) {
        logger.info(`[路由] 群聊白名单为空，跳过所有群消息`);
        return;
      }
      if (!allowedGroupNames.includes(roomName)) {
        logger.info(`[路由] 群不在白名单，跳过: ${roomName}`);
        return;
      }
    }

    // --- Video shares: always process, even without @mention ---
    if (msgType === types.Message.Text) {
      const detected = detectVideoShare(text);
      if (detected.isVideoShare) {
        const cleanText = cleanMentionText(text, botName);
        logger.info(`[路由] 群="${roomName}" | 用户=${contactName} | 视频分享: 平台=${detected.platform}`);
        try {
          await handleVideoShare(msg, contact, cleanText, downloader, noteImageThreshold);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`[路由] 群聊视频处理失败: ${errMsg}`);
        }
        return;
      }
    }

    // --- Regular text: require @mention if configured ---
    if (requireMentionGroup) {
      const mentioned = isBotMentioned(text, botName);
      logger.info(`[路由] 群="${roomName}" | @机器人检查: mentioned=${mentioned}, text="${text.slice(0, 100)}"`);
      if (!mentioned) {
        logger.info(`[路由] 群聊未 @机器人，跳过`);
        return;
      }
    }
    text = cleanMentionText(text, botName);
    logger.info(`[路由] 群="${roomName}" | 用户=${contactName}: "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"`);

    // 群聊：群在白名单内，但用户需要检查是否在私聊白名单
    isAllowedUser = allowedPrivateUsers === undefined || allowedPrivateUsers.length === 0 || allowedPrivateUsers.includes(contactName);
  } else {
    // ── Private (1-on-1) messages ────────────────────────────────────
    if (allowedPrivateUsers !== undefined) {
      if (allowedPrivateUsers.length === 0) {
        logger.info(`[路由] 私聊白名单为空，跳过所有私聊消息`);
        return;
      }
      if (!allowedPrivateUsers.includes(contactName)) {
        logger.info(`[路由] 私聊用户不在白名单，跳过: ${contactName}`);
        return;
      }
    }
    if (requireMentionPrivate && !isBotMentioned(text, botName)) {
      logger.info(`[路由] 私聊消息未 @机器人，跳过: ${contactName}`);
      return;
    }
    if (isBotMentioned(text, botName)) {
      text = cleanMentionText(text, botName);
    }
    logger.info(`来自 ${contactName} 的消息 (${contact.id}): 类型=${types.Message[msgType]}`);

    // 私聊：用户在白名单内
    isAllowedUser = true;
  }

  switch (msgType) {
    case types.Message.Text: {
      logger.info(`[路由] 文本内容 (长度=${text.length}): "${text.slice(0, 200)}${text.length > 200 ? '...' : ''}"`);

      // Check if the message contains a douyin/bilibili share link
      const detected = detectVideoShare(text);
      if (detected.isVideoShare) {
        logger.info(`[路由] 检测到视频分享: 平台=${detected.platform}, 规则="${detected.matchedPattern}", 匹配="${detected.matchedText}"`);
        try {
          await handleVideoShare(msg, contact, text, downloader, noteImageThreshold);
          return;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.warn(`[路由] 视频处理失败，降级到 LLM: ${errMsg}`);
          // Fall through to regular text/LLM handling
        }
      } else {
        logger.debug(`[路由] 未检测到视频分享链接`);
      }

      // For group messages, use room.id as conversation context key;
      // pass cleaned text to avoid @mention prefix going to LLM.
      await handleText(msg, contact, llmAdapter, contextManager, room?.id, text, isAllowedUser);
      break;
    }
    default:
      await handleFallback(msg, msgType);
      break;
  }
}