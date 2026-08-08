/*
 * @Author: linxf 2361906818@qq.com
 * @Date: 2026-08-09 00:58:35
 * @LastEditors: linxf 2361906818@qq.com
 * @LastEditTime: 2026-08-09 03:43:11
 * @FilePath: \AI\wx_bot12\src\config\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { AppConfig, ProvidersConfig, ProviderPreset } from './types';
import * as path from 'path';
import * as fs from 'fs';

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadProvidersConfig(): ProvidersConfig {
  const providersPath = path.resolve(__dirname, '../../config/providers.json');
  if (!fs.existsSync(providersPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(providersPath, 'utf-8')) as ProvidersConfig;
}

function resolveProvider(): { provider: string; config: ProviderPreset | null } {
  const providers = loadProvidersConfig();
  const envProvider = process.env.LLM_PROVIDER;

  if (envProvider && providers[envProvider]) {
    return { provider: envProvider, config: providers[envProvider] };
  }

  if (envProvider && !providers[envProvider]) {
    console.warn(`[CONFIG] 警告: LLM_PROVIDER=${envProvider} 在 providers.json 中不存在`);
  }

  return { provider: envProvider || 'default', config: null };
}

function parseEnvList(envKey: string): string[] | undefined {
  const val = process.env[envKey];
  if (val === undefined) return undefined;
  const trimmed = val.trim();
  if (!trimmed) return [];

  let list: string[] = [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        list = parsed.map((s: any) => String(s).trim()).filter(Boolean);
      }
    } catch {
      list = trimmed.split(',').map(s => s.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
    }
  } else {
    list = trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  return list;
}

function resolveEnvVars(config: AppConfig): AppConfig {
  const llm = { ...config.llm };
  const options = { ...llm.options };
  const bot = { ...config.bot };

  const allowedPrivateUsers = parseEnvList('ALLOWED_PRIVATE_USERS');
  const allowedGroupNames = parseEnvList('ALLOWED_GROUP_NAMES');
  if (allowedPrivateUsers) bot.allowedPrivateUsers = allowedPrivateUsers;
  if (allowedGroupNames) bot.allowedGroupNames = allowedGroupNames;

  if (process.env.BOT_NAME) {
    bot.name = process.env.BOT_NAME;
  }

  const { provider: envProvider, config: preset } = resolveProvider();

  if (preset) {
    llm.provider = preset.provider;
    llm.options = { ...preset.options };

    if (preset.apiKeyEnv) {
      const apiKey = process.env[preset.apiKeyEnv];
      if (apiKey) {
        llm.options.apiKey = apiKey;
      }
    }
  } else if (llm.provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      options.apiKey = apiKey;
      llm.options = options;
    }
  } else if (llm.provider === 'qwen') {
    const apiKey = process.env.QWEN_API_KEY;
    if (apiKey) {
      options.apiKey = apiKey;
      llm.options = options;
    }
  }

  return { ...config, llm, bot };
}

let runtimeConfig: AppConfig;

export function loadConfig(): AppConfig {
  const defaultPath = path.resolve(__dirname, '../../config/default.json');
  if (!fs.existsSync(defaultPath)) {
    throw new Error(`默认配置文件不存在: ${defaultPath}`);
  }
  let config = JSON.parse(fs.readFileSync(defaultPath, 'utf-8')) as AppConfig;

  const prodPath = path.resolve(__dirname, '../../config/production.json');
  if (fs.existsSync(prodPath)) {
    const prodConfig = JSON.parse(fs.readFileSync(prodPath, 'utf-8'));
    config = deepMerge(
      config as unknown as Record<string, unknown>,
      prodConfig
    ) as unknown as AppConfig;
  }

  config = resolveEnvVars(config);

  if (process.env.DOWNLOADER_API_URL) {
    config.downloader = { ...config.downloader, apiUrl: process.env.DOWNLOADER_API_URL };
  }

  const { provider: envProvider } = resolveProvider();
  if (envProvider && envProvider !== 'default') {
    console.log(`[CONFIG] 使用 LLM 提供商: ${envProvider} (来自 .env 的 LLM_PROVIDER)`);
  }

  runtimeConfig = config;
  return config;
}

export function getRuntimeConfig(): AppConfig {
  return runtimeConfig;
}

export function updateRuntimeConfig(update: Partial<AppConfig>): AppConfig {
  runtimeConfig = deepMerge(
    runtimeConfig as unknown as Record<string, unknown>,
    update as unknown as Record<string, unknown>
  ) as unknown as AppConfig;

  const prodPath = path.resolve(__dirname, '../../config/production.json');
  const toSave = {
    ...runtimeConfig,
    llm: {
      ...runtimeConfig.llm,
      options: { ...runtimeConfig.llm.options },
    },
  };
  if (toSave.llm.options.apiKey) {
    delete toSave.llm.options.apiKey;
  }

  try {
    fs.writeFileSync(prodPath, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    throw new Error(`保存配置文件失败: ${(err as Error).message}`);
  }

  return runtimeConfig;
}