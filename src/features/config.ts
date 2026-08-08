/*
 * @Author: linxf 2361906818@qq.com
 * @Date: 2026-08-09 06:13:11
 * @LastEditors: linxf 2361906818@qq.com
 * @LastEditTime: 2026-08-09 06:13:43
 * @FilePath: \AI\wx_bot12\src\features\config.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
export interface FeaturesConfig {
  idiomChain: boolean;
  weather: boolean;
  news: boolean;
  help: boolean;
}

const DEFAULTS: FeaturesConfig = {
  idiomChain: true,
  weather: true,
  news: true,
  help: true,
};

export function loadFeaturesConfig(): FeaturesConfig {
  const config: FeaturesConfig = { ...DEFAULTS };

  const parseBool = (val: string | undefined, def: boolean): boolean => {
    if (val === undefined) return def;
    const lower = val.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
    return def;
  };

  config.idiomChain = parseBool(process.env.FEATURE_IDIOM_CHAIN, config.idiomChain);
  config.weather = parseBool(process.env.FEATURE_WEATHER, config.weather);
  config.news = parseBool(process.env.FEATURE_NEWS, config.news);
  config.help = parseBool(process.env.FEATURE_HELP, config.help);

  return config;
}

export function isFeatureEnabled(config: FeaturesConfig, feature: keyof FeaturesConfig): boolean {
  return config[feature];
}