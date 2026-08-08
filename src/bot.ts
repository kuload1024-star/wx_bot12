import { WechatyBuilder, types, qrcodeValueToImageUrl } from 'wechaty';
import type { Wechaty } from 'wechaty';
import { MemoryCard } from 'memory-card';
import { LLMAdapter } from './llm/interface';
import { MockAdapter } from './llm/adapters/mock';
import { ContextManager } from './llm/context';
import { routeMessage } from './handlers';
import { DownloaderClient } from './downloader/api';
import { logger } from './utils/logger';
import { getDeviceId } from './utils/device-id';
import { AppConfig } from './config/types';
import { updateBotStatus, getBotStatus } from './web/api';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const qrcodeTerm = require('qrcode-terminal');

// Map short puppet names to full npm module names
const PUPPET_NAME_MAP: Record<string, string> = {
  wechat4u: 'wechaty-puppet-wechat4u',
  xp: 'wechaty-puppet-xp',
  padlocal: 'wechaty-puppet-padlocal',
  mock: 'wechaty-puppet-mock',
};

function resolvePuppetName(shortName: string): string {
  return PUPPET_NAME_MAP[shortName] || shortName;
}

export class WeChatBot {
  private wechaty!: Wechaty;
  private memory!: MemoryCard;
  private llmAdapter: LLMAdapter;
  private contextManager: ContextManager;
  private config: AppConfig;
  private downloader: DownloaderClient;
  private retryCount: number = 0;
  private maxRetries: number = 3;
  private manualLogout: boolean = false;
  private puppetName: string;
  private deviceId: string;

  constructor(config: AppConfig, llmAdapter: LLMAdapter) {
    this.config = config;
    this.llmAdapter = llmAdapter;
    this.contextManager = new ContextManager(config.bot.maxContextMessages);
    this.downloader = new DownloaderClient(config.downloader.apiUrl);

    this.puppetName = resolvePuppetName(config.puppet.type);
    logger.info(`解析后的 Puppet 名称: ${this.puppetName}`);

    // Patch wechat4u's getDeviceID BEFORE puppet loads, so WeChat sees a fixed device.
    // Must patch lib/util/global.js directly — lib/util/index.js uses getter-based
    // re-exports that silently reject property assignment (getter without setter).
    this.deviceId = getDeviceId();
    try {
      const wechat4uGlobal = require('wechat4u/lib/util/global.js');
      wechat4uGlobal.getDeviceID = () => this.deviceId;
      logger.info(`已 patch wechat4u 设备 ID (global.js)`);
    } catch {
      // Non-wechat4u puppet, skip
    }

    // Patch syncCheck to handle unexpected retcode values (e.g. retcode=1) as
    // logout conditions instead of crashing with an assertion error "1 == 0".
    // Without this patch, any non-0 non-1101 retcode causes the bot to hang
    // after QR scan with no recovery.
    try {
      const wechat4uCore = require('wechat4u/lib/core.js');
      const WechatCore = wechat4uCore.default;
      const AlreadyLogoutError = wechat4uCore.AlreadyLogoutError;
      const origSyncCheck = WechatCore.prototype.syncCheck;
      WechatCore.prototype.syncCheck = function () {
        return origSyncCheck.call(this).catch((err: any) => {
          if (err && err.tips === '同步失败') {
            logger.warn('SyncCheck 失败，视为会话失效，触发重新登录:', err.message);
            throw new AlreadyLogoutError('syncCheck retcode indicates re-login needed');
          }
          throw err;
        });
      };
      logger.info('已 patch wechat4u syncCheck 错误处理');
    } catch {
      // Non-wechat4u puppet, skip
    }
  }

  async start(): Promise<void> {
    // Create and load MemoryCard BEFORE building Wechaty.
    // Must pass a name so the storage backend uses file-based persistence (not nop).
    this.memory = new MemoryCard(this.config.bot.name);
    await this.memory.load().catch(async err => {
      logger.warn('MemoryCard 加载失败，使用全新会话:', err.message);
      await this.memory.destroy();
      await this.memory.load();
    });

    const puppetOptions = {
      ...this.config.puppet.options,
      deviceId: this.deviceId,
    };

    this.wechaty = WechatyBuilder.build({
      name: this.config.bot.name,
      puppet: this.puppetName as any,
      puppetOptions,
      memory: this.memory,
    });

    this.wechaty
      .on('scan', this.onScan.bind(this))
      .on('login', this.onLogin.bind(this))
      .on('logout', this.onLogout.bind(this))
      .on('message', this.onMessage.bind(this))
      .on('error', this.onError.bind(this));

    updateBotStatus({
      state: 'waiting_scan',
      puppet: this.config.puppet.type,
      llmProvider: this.config.llm.provider,
    });

    logger.info(`机器人启动中，Puppet: ${this.config.puppet.type}, LLM: ${this.llmAdapter.name}`);
    await this.wechaty.start();
  }

  async stop(): Promise<void> {
    logger.info('机器人正在停止...');
    if (this.wechaty) {
      await this.wechaty.stop();
    }
    logger.info('机器人已停止。');
  }

  /**
   * 断开微信连接，清除会话后重新进入扫码状态。
   * 设备 ID 与会话 token 分开存储：
   *   - .device.json   → 设备标识（持久化）
   *   - WxBot.memory-card.json → 会话 token（此处清除）
   */
  async logout(): Promise<void> {
    logger.info('用户请求断开连接...');
    this.manualLogout = true;
    this.retryCount = this.maxRetries;

    if (this.wechaty) {
      await this.wechaty.stop();
    }

    // 清除旧会话，避免重启后使用过期 session 导致 1101/1102 同步错误
    try {
      await this.memory.delete('PUPPET-WECHAT4U');
      await this.memory.save();
      logger.info('已清除旧会话数据');
    } catch (err) {
      logger.warn('清除会话数据失败:', (err as Error).message);
    }

    this.manualLogout = false;
    this.retryCount = 0;
    updateBotStatus({ state: 'waiting_scan', loginUser: undefined, qrcode: undefined, qrcodeImageUrl: undefined });
    logger.info('已断开，正在重新启动...');
    await this.wechaty.start();
  }

  /**
   * 更新视频下载服务的 API 地址
   */
  updateDownloaderUrl(newUrl: string): void {
    this.downloader.updateBaseUrl(newUrl);
    this.config.downloader.apiUrl = newUrl;
  }

  /**
   * 动态切换 Mock 复读模式（仅 Mock 适配器有效）
   */
  setMockEcho(enabled: boolean): void {
    if (this.llmAdapter instanceof MockAdapter) {
      this.llmAdapter.setMockEcho(enabled);
    } else {
      logger.warn('setMockEcho 仅对 Mock 适配器有效，当前 LLM 提供商为:', this.llmAdapter.name);
    }
  }

  private onScan(qrcodeVal: string, status: number): void {
    const statusName = types.ScanStatus[status] || 'Unknown';
    logger.info(`请扫描二维码登录 (状态: ${status} ${statusName})`);

    if (status === types.ScanStatus.Waiting || status === types.ScanStatus.Timeout) {
      updateBotStatus({
        state: 'waiting_scan',
        qrcode: qrcodeVal,
        qrcodeImageUrl: qrcodeValueToImageUrl(qrcodeVal),
      });

      qrcodeTerm.generate(qrcodeVal);
      console.log('\n📱 请使用微信扫描上方二维码登录');
      console.log('💡 如果二维码无法识别，请打开以下链接扫码：');
      console.log(`   ${qrcodeValueToImageUrl(qrcodeVal)}\n`);
    }
  }

  private onLogin(user: any): void {
    logger.info(`✅ 登录成功: ${user.name()} (${user.id})`);
    this.retryCount = 0;
    this.manualLogout = false;
    updateBotStatus({
      state: 'logged_in',
      loginUser: user.name(),
      qrcode: undefined,
      qrcodeImageUrl: undefined,
    });
  }

  private async onLogout(user: any): Promise<void> {
    logger.warn(`已登出: ${user.name()}`);
    updateBotStatus({ state: 'logged_out', loginUser: undefined });

    if (this.manualLogout) {
      logger.info('手动登出，已清除会话。重新启动机器人或刷新页面扫码登录。');
      return; // 不自动重连，等待用户操作
    }

    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      logger.info(`5秒后尝试重新连接... (第 ${this.retryCount}/${this.maxRetries} 次)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        await this.wechaty.start();
      } catch (error) {
        logger.error('重新连接失败:', error);
      }
    } else {
      logger.error(`已达到最大重试次数 (${this.maxRetries})，程序退出。`);
      process.exit(1);
    }
  }

  private async onMessage(msg: any): Promise<void> {
    try {
      const requireMentionGroup = this.config.bot.requireMentionInGroup ?? this.config.bot.requireMention ?? true;
      const requireMentionPrivate = this.config.bot.requireMentionInPrivate ?? false;
      await routeMessage(
        msg,
        this.llmAdapter,
        this.contextManager,
        this.config.bot.name,
        this.downloader,
        this.config.bot.noteImageThreshold,
        requireMentionGroup,
        requireMentionPrivate,
        this.config.bot.allowedPrivateUsers,
        this.config.bot.allowedGroupNames
      );
    } catch (error) {
      logger.error('未处理的消息错误:', error);
    }
  }

  private async onError(error: Error): Promise<void> {
    logger.error('机器人错误:', error.message);

    // SyncCheck assertion errors (e.g. "1 == 0") indicate an invalid session.
    // Clear stale session data so the next restart shows a fresh QR code.
    if (/^\d+\s*==\s*\d+$/.test(error.message?.trim() ?? '')) {
      logger.warn('检测到 SyncCheck 断言错误，清理过期会话数据...');
      try {
        await this.memory.delete('PUPPET-WECHAT4U');
        await this.memory.save();
        logger.info('已清理过期会话，将在下次启动时重新扫码');
      } catch (e) {
        logger.warn('清理会话失败:', (e as Error).message);
      }
      // Update status so the dashboard reflects the issue
      updateBotStatus({ state: 'waiting_scan', qrcode: undefined, qrcodeImageUrl: undefined });
      return;
    }

    // Errors during non-logged-in phase (e.g., 1101 syncCheck) are normal, don't change state
    const state = getBotStatus().state;
    if (state !== 'logged_in') return;
    updateBotStatus({ state: 'error' });
  }
}