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
  noteImageThreshold: number;
  requireMention?: boolean;
  requireMentionInGroup?: boolean;
  requireMentionInPrivate?: boolean;
  allowedPrivateUsers?: string[];
  allowedGroupNames?: string[];
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