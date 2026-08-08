export interface PuppetConfig {
  type: 'wechat4u' | 'xp' | 'padlocal';
  options: Record<string, unknown>;
}

export interface LLMConfig {
  provider: string;
  options: Record<string, unknown>;
}

export interface ProviderPreset {
  provider: string;
  options: Record<string, unknown>;
  apiKeyEnv?: string | null;
}

export type ProvidersConfig = Record<string, ProviderPreset>;

export interface BotSettings {
  name: string;
  maxContextMessages: number;
  /** 图文笔记图片超过此数量时，拼接为一张长图发送（默认 3） */
  noteImageThreshold: number;
}

export interface DownloaderConfig {
  apiUrl: string;
}

export interface AppConfig {
  puppet: PuppetConfig;
  llm: LLMConfig;
  bot: BotSettings;
  downloader: DownloaderConfig;
}