import axios from 'axios';
import { logger } from '../utils/logger';
import { FeaturesConfig, isFeatureEnabled, loadFeaturesConfig } from './config';

type FeatureResult = {
  handled: boolean;
  reply?: string;
};

const WEATHER_API = 'https://wttr.in';

const IDIOM_CHAIN_HINTS = ['成语接龙', '接龙', '开始接龙', '来接龙', '玩接龙'];

const WEATHER_HINTS = ['天气', '气温', '下雨', '刮风', 'weather'];

const NEWS_HINTS = ['新闻', '资讯', '今日', '最新消息', 'news'];

const HELP_HINTS = ['帮助', '功能', 'help', '命令', '菜单'];

const IDIOMS: string[] = [
  '一帆风顺', '三心二意', '四面楚歌', '五光十色', '六六大顺', '七上八下',
  '八仙过海', '九牛一毛', '十全十美', '百步穿杨', '千军万马', '万紫千红',
  '画蛇添足', '守株待兔', '亡羊补牢', '刻舟求剑', '掩耳盗铃', '叶公好龙',
  '狐假虎威', '井底之蛙', '对牛弹琴', '愚公移山', '精卫填海', '夸父追日',
  '卧薪尝胆', '负荆请罪', '完璧归赵', '纸上谈兵',
  '四面楚歌', '破釜沉舟', '背水一战', '草木皆兵', '风声鹤唳',
  '塞翁失马', '水滴石穿', '绳锯木断', '聚沙成塔',
  '集腋成裘', '积少成多', '积水成渊',
  '鹏程万里', '扶摇直上', '一鸣惊人',
  '笔走龙蛇', '龙飞凤舞', '卧虎藏龙', '生龙活虎', '画龙点睛',
  '鹤立鸡群', '蛛丝马迹', '老马识途',
  '狼狈为奸', '狡兔三窟', '兔死狗烹',
  '杯弓蛇影', '打草惊蛇', '虎头蛇尾',
];

function getRandomIdiom(): string {
  return IDIOMS[Math.floor(Math.random() * IDIOMS.length)];
}

function getNextIdiom(startChar: string): string | null {
  const matches = IDIOMS.filter(i => i.startsWith(startChar));
  if (matches.length > 0) return matches[0];

  const candidates = IDIOMS.filter(i => i.startsWith(startChar.slice(0, 1)));
  if (candidates.length > 0) return candidates[0];
  return null;
}

export async function handleFeatureCommand(
  text: string,
  userId: string,
  userAllowed: boolean = true,
  featuresConfig?: FeaturesConfig
): Promise<FeatureResult> {
  const config = featuresConfig || loadFeaturesConfig();
  const lowerText = text.toLowerCase().trim();

  // ── 帮助菜单 ──
  if (isFeatureEnabled(config, 'help') && HELP_HINTS.some(h => lowerText.includes(h.toLowerCase()))) {
    return {
      handled: true,
      reply: getHelpMenu(config),
    };
  }

  // ── 成语接龙 ──
  if (isFeatureEnabled(config, 'idiomChain')) {
    const chains = global.idiomChains || {};
    const isInChain = !!chains[userId];
    const wantEnd = ['结束接龙', '退出接龙', '不玩了', '结束游戏', '退出游戏', '停止接龙'].some(h => lowerText.includes(h.toLowerCase()));

    if (wantEnd) {
      if (isInChain) {
        delete chains[userId];
        return { handled: true, reply: '已退出成语接龙' };
      }
      return { handled: true, reply: '当前没有进行中的接龙游戏' };
    }

    if (isInChain) {
      const chain = chains[userId];
      const inputIdiom = text.trim();
      if (inputIdiom.length >= 4) {
        const nextIdiom = getNextIdiom(inputIdiom[inputIdiom.length - 1]);
        if (nextIdiom) {
          chain.lastChar = nextIdiom[nextIdiom.length - 1];
          chain.count++;
          chain.history.push(inputIdiom, nextIdiom);
          return {
            handled: true,
            reply: `接龙成功！\n你接: ${inputIdiom}\n我接: ${nextIdiom}\n已接 ${chain.count} 轮\n发送「结束接龙」或「不玩了」退出`,
          };
        } else {
          return {
            handled: true,
            reply: `接龙失败，"${inputIdiom}" 结尾的成语我接不上了。可以换个成语试试，或发送「结束接龙」退出。`,
          };
        }
      }
      return { handled: true, reply: '请发送一个四字成语，或发送「结束接龙」退出' };
    }

    if (IDIOM_CHAIN_HINTS.some(h => lowerText.includes(h.toLowerCase()))) {
      return {
        handled: true,
        reply: startIdiomChain(userId),
      };
    }
  }

  // ── 天气预报 ──
  if (isFeatureEnabled(config, 'weather') && WEATHER_HINTS.some(h => lowerText.includes(h.toLowerCase()))) {
    return {
      handled: true,
      reply: await getWeather(text),
    };
  }

  // ── 新闻资讯（只匹配简短命令，长问题交给 LLM） ──
  if (isFeatureEnabled(config, 'news')) {
    const newsMatch = NEWS_HINTS.find(h => {
      const idx = lowerText.indexOf(h.toLowerCase());
      if (idx === -1) return false;
      const before = lowerText.slice(0, idx).trim();
      const after = lowerText.slice(idx + h.length).trim();
      return !before && !after;
    });
    if (newsMatch) {
      return {
        handled: true,
        reply: getNewsHint(),
      };
    }
  }

  return { handled: false };
}

function getHelpMenu(config: FeaturesConfig): string {
  const features: string[] = [];

  if (isFeatureEnabled(config, 'idiomChain')) {
    features.push('🎮 「成语接龙」- 开始接龙游戏');
  }
  if (isFeatureEnabled(config, 'weather')) {
    features.push('🌤️ 「天气 北京」- 查询天气');
  }
  if (isFeatureEnabled(config, 'news')) {
    features.push('📰 「新闻」- 查看资讯');
  }

  if (features.length === 0) {
    return '🤖 当前没有启用的功能';
  }

  return `🤖 可用功能：\n\n${features.join('\n')}\n\n💡 私聊直接发送，群聊需 @我`;
}

function startIdiomChain(userId: string): string {
  if (!global.idiomChains) {
    global.idiomChains = {};
  }
  const firstIdiom = getRandomIdiom();
  global.idiomChains[userId] = {
    lastChar: firstIdiom[firstIdiom.length - 1],
    count: 1,
    history: [firstIdiom],
  };
  return `🎮 成语接龙开始！\n我先说：${firstIdiom}\n下一个成语必须以「${firstIdiom[firstIdiom.length - 1]}」开头\n请接下一个成语~`;
}

async function getWeather(text: string): Promise<string> {
  try {
    const location = extractLocation(text);
    if (!location) {
      return '请告诉我要查询的城市，如「天气 北京」「气温 上海」';
    }

    const response = await axios.get(`${WEATHER_API}/${encodeURIComponent(location)}`, {
      params: { format: 'j1', lang: 'zh' },
      timeout: 10000,
    });

    const data = response.data;
    const current = data.current_condition?.[0];
    const area = data.nearest_area?.[0];

    if (!current) {
      return `抱歉，无法获取「${location}」的天气信息`;
    }

    const temp = current.temp_C;
    const feelsLike = current.FeelsLikeC;
    const humidity = current.humidity;
    const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || '未知';
    const wind = `${current.winddir16Point} ${current.windspeedKmph}km/h`;

    const areaName = area?.areaName?.[0]?.value || location;

    return `🌤️ ${areaName} 天气\n${'─'.repeat(14)}\n${desc} ${temp}°C\n体感温度: ${feelsLike}°C\n湿度: ${humidity}%\n风向: ${wind}`;
  } catch (err: any) {
    logger.error(`[天气] 获取失败: ${err.message}`);
    return '抱歉，天气服务暂时不可用，请稍后再试';
  }
}

function extractLocation(text: string): string | null {
  const patterns = [
    /天气\s*(.+)/,
    /气温\s*(.+)/,
    /\s*(.+?)\s*天气/,
    /\s*(.+?)\s*气温/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const loc = match[1].trim();
      if (loc && loc.length <= 20 && /^[\u4e00-\u9fa5a-zA-Z\s]+$/.test(loc)) {
        return loc;
      }
    }
  }
  return null;
}

function getNewsHint(): string {
  return `📰 今日新闻

直接问我「今天有什么新闻」「最近有什么大事」，我会通过 AI 为你解答。

💡 也可以问「最近科技新闻」「财经动态」等`;
}

declare global {
  var idiomChains: Record<string, {
    lastChar: string;
    count: number;
    history: string[];
  }> | undefined;
}