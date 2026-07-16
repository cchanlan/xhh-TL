import fetch from 'node-fetch';
import moment from 'moment';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js';
import { createUser } from '../utils/userBind.js';
import { prepareMysContext } from '../utils/runtimePatch.js';
import { getRenderScaleStyle, pickRoleCombatBgImage, readPluginConfig, toFileUrl } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'

const MANIFEST_URL = 'https://static.nanoka.cc/manifest.json';
const ELEMENT_MAP = {
  2: 'pyro', 3: 'hydro', 4: 'dendro', 5: 'electro', 6: 'cryo', 7: 'anemo', 8: 'geo',
  Fire: 'pyro', Water: 'hydro', Grass: 'dendro', Elec: 'electro', Ice: 'cryo', Wind: 'anemo', Rock: 'geo',
};
const ELEMENT_CN = { pyro: '火', hydro: '水', dendro: '草', electro: '雷', cryo: '冰', anemo: '风', geo: '岩' };
const ELEMENT_CLASS = { pyro: 'pyro', hydro: 'hydro', dendro: 'dendro', electro: 'electro', cryo: 'cryo', anemo: 'anemo', geo: 'geo' };
const START_MONTH = { year: 2024, month: 7 };

// 配置读取
const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = path.join(pluginDir, 'config', 'config.yaml') /* user config */;
let _configCache = null;

function readConfig() {
  return readPluginConfig();
}

function config() {
  // 直接走 mtime 缓存，避免 Windows 上 fs.watch 不触发导致锅巴改完不生效
  return readConfig();
}

try {
  if (fs.existsSync(configPath)) {
    fs.watch(configPath, () => {
      _configCache = readConfig();
    });
  }
} catch (_) {}

function monthToIndex(yyyymm) {
  const y = Math.floor(Number(yyyymm) / 100);
  const m = Number(yyyymm) % 100;
  return (y * 12 + m) - (START_MONTH.year * 12 + START_MONTH.month);
}

function indexToMonth(idx) {
  const total = START_MONTH.year * 12 + START_MONTH.month + idx;
  const y = Math.floor((total - 1) / 12);
  const m = ((total - 1) % 12) + 1;
  return `${y}${String(m).padStart(2, '0')}`;
}

function parseMonth(msg = '') {
  const raw = String(msg || '');
  let m = raw.match(/(20\d{2})(?:[-/.年]?)(0?[1-9]|1[0-2])(?:月)?/);
  if (m) return `${m[1]}${String(Number(m[2])).padStart(2, '0')}`;
  m = raw.match(/20\d{4}/);
  if (m) return m[0];
  return moment().format('YYYYMM');
}

async function fetchJson(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function charById(id) {
  const char = Character.get(Number(id));
  if (!char) return null;
  return {
    id: char.id,
    name: char.name,
    elem: char.elem,
    elemName: ELEMENT_CN[char.elem] || '',
    elemClass: ELEMENT_CLASS[char.elem] || '',
    star: char.star || 4,
    face: char.face ? toFileUrl(path.join(process.cwd(), 'plugins/miao-plugin/resources', String(char.face||'').replace(/^\//,''))) : '',
  };
}

function uniqById(list = []) {
  const map = new Map();
  for (const item of list) if (item?.id && !map.has(item.id)) map.set(item.id, item);
  return [...map.values()];
}

function mergeStart(avatars, initialAvatarIds) {
  let initialAvatars = [];
  for (const id of initialAvatarIds) {
    const char = Character.get(id);
    if (char) {
      initialAvatars.push({
        id,
        name: char.name,
        elem: char.elem,
        abbr: char.abbr,
        star: char.star,
        face: char.face,
        level: 80,
        cons: 0,
        talent: {
          a: { level: 8, original: 8 },
          e: { level: 8, original: 8 },
          q: { level: 8, original: 8 }
        }
      });
    }
  }

  // 合并逻辑：求 avatars 和 initialAvatars 的并集
  const avatarMap = new Map();
  avatars.forEach(avatar => avatarMap.set(avatar.id, avatar));
  
  initialAvatars.forEach(initialAvatar => {
    if (avatarMap.has(initialAvatar.id)) {
      // 如果 id 相同，比较 level，选取较大的元素
      const existingAvatar = avatarMap.get(initialAvatar.id);
      avatarMap.set(initialAvatar.id, existingAvatar.level >= initialAvatar.level ? existingAvatar : initialAvatar);
    } else {
      // 如果 id 不同，直接加入
      avatarMap.set(initialAvatar.id, initialAvatar);
    }
  });

  return Array.from(avatarMap.values());
}

function extractCharacters(raw = {}) {
  const cfg = raw.avatar_config || raw.AvatarConfig || {};
  const openingIds = (cfg.buff_avatar_list || cfg.BuffAvatarList || []).map(v => Number(v.id || v.Id || v) + (Number(v.id || v.Id || v) < 10000000 ? 10000000 : 0));
  const inviteIds = (cfg.invite_avatar_list || cfg.InviteAvatarList || []).map(v => Number(v.id || v.Id || v) + (Number(v.id || v.Id || v) < 10000000 ? 10000000 : 0));
  const elements = (cfg.element_list || cfg.ElementList || []).map(v => ELEMENT_MAP[v]).filter(Boolean);
  const opening = uniqById(openingIds.map(charById).filter(Boolean));
  const invite = uniqById(inviteIds.map(charById).filter(Boolean));
  const inviteSet = new Set(invite.map(v => v.id));
  const available = [];
  const travelerIds = [10000005, 10000007];
  const travelerAdded = new Set();
  Character.forEach(char => {
    if (!char?.isRelease || char.game !== 'gs') return true;
    // 主角：为每个限制元素添加一个对应元素的主角
    if (travelerIds.includes(Number(char.id))) {
      for (const elem of elements) {
        const key = `${char.id}_${elem}`;
        if (travelerAdded.has(key)) continue;
        travelerAdded.add(key);
        available.push({
          id: char.id,
          name: char.name,
          elem: elem,
          elemName: ELEMENT_CN[elem] || '',
          elemClass: ELEMENT_CLASS[elem] || '',
          star: char.star || 4,
          face: char.face ? toFileUrl(path.join(process.cwd(), 'plugins/miao-plugin/resources', String(char.face||'').replace(/^\//,''))) : '',
        });
      }
      return true;
    }
    if (elements.includes(char.elem) || inviteSet.has(char.id)) available.push(charById(char.id));
    return true;
  }, 'release', 'gs');
  // available 使用 id+elem 去重，因为主角可能有多个元素条目
  const availMap = new Map();
  for (const item of available) {
    const key = `${item.id}_${item.elem}`;
    if (!availMap.has(key)) availMap.set(key, item);
  }
  return { elements: [...new Set(elements)], opening, invite, available: [...availMap.values()] };
}

function extractMonsters(raw = {}) {
  const diff = raw.difficulty_config || raw.DifficultyConfig || {};
  const last = Object.values(diff).at(-1) || {};
  const pairs = [
    ['第三幕', last.room?.['3'] || last.Room?.['3']],
    ['第六幕', last.room?.['6'] || last.Room?.['6']],
    ['第八幕', last.room?.['8'] || last.Room?.['8']],
    ['第十幕', last.room?.['10'] || last.Room?.['10']],
    ['圣牌挑战 I', last.hard_room?.['4']],
    ['圣牌挑战 II', last.hard_room?.['7']],
  ];
  return pairs.map(([stage, room]) => {
    const names = (room?.monster_preview_list || room?.MonsterPreviewList || []).map(v => v.name || v.Name).filter(Boolean);
    return names.length ? { stage, names } : null;
  }).filter(Boolean);
}

async function loadRoleCombat(month) {
  const manifest = await fetchJson(MANIFEST_URL);
  const version = manifest?.gi?.latest;
  if (!version) throw new Error('Nanoka manifest 未返回原神版本');
  const overall = await fetchJson(`https://static.nanoka.cc/gi/${version}/rolecombat.json`);
  const count = Object.keys(overall || {}).length;
  const minMonth = indexToMonth(0);
  const maxMonth = indexToMonth(count - 1);
  let idx = monthToIndex(month);
  let usedMonth = month;
  let fallback = false;
  if (idx < 0 || idx >= count) {
    idx = count - 1;
    usedMonth = maxMonth;
    fallback = true;
  }
  const raw = await fetchJson(`https://static.nanoka.cc/gi/${version}/zh/rolecombat/${idx + 3}.json`);
  return { version, minMonth, maxMonth, month: usedMonth, requestedMonth: month, fallback, raw };
}

export class role_combat extends plugin {
  constructor() {
    super({
      name: '[小花火]幻想真境剧诗',
      dsc: '原神幻想真境剧诗当期可用角色',
      event: 'message',
      priority: -9999,
      rule: [
        {
          // #幻想剧诗 / 幻想角色 / #幻想202607；仅允许可选月份后缀，其它尾巴不触发
          // 可选 #；仅允许已知后缀/月份，尾部乱码不触发
          reg: '^\\s*#?(?:原神)?(?:幻想剧诗(?:角色|可用角色|当期角色|本期角色|查询)?|幻想角色|幻想可用角色|幻想当期角色|幻想本期角色|幻想查询|幻想(?:角色|可用角色|当期角色|本期角色|查询|剧诗)?(?:20\\d{4}|20\\d{2}[-/.年]?\\d{1,2}月?))\\s*$',
          fnc: 'roleCombat',
        },
      ],
    });
  }

  async roleCombat(e) {
    await e.reply('正在获取幻想真境剧诗数据，请稍后...', true);
    const requestedMonth = parseMonth(e.msg || '');

    // 检测 @提及
    let targetQq = null;
    let targetName = null;
    let targetUid = null;
    const selfId = e.self_id || (e.bot || Bot)?.uin;
    for (const msg of e.message || []) {
      if (msg.type === 'at' && String(msg.qq) !== String(selfId)) {
        targetQq = msg.qq;
        break;
      }
    }
    // 将 @目标写回 e.at，确保 MysInfo/MysApi 查询的是被@的人而非发送者
    if (targetQq) e.at = String(targetQq);

    // 获取被@用户的昵称和UID
    if (targetQq && e.group) {
      try {
        const member = e.group.pickMember?.(targetQq);
        if (member?.nickname) {
          targetName = member.nickname;
        } else {
          const bot = e.bot || Bot;
          const info = await bot.getGroupMemberInfo?.(String(e.group_id), String(targetQq));
          if (info?.nickname) targetName = info.nickname;
        }
      } catch (_) {}
      if (!targetName) targetName = String(targetQq);

      // 获取被@用户的UID（兼容层，不依赖 genshin import）
      try {
        const noteUser = await createUser(targetQq, e);
        targetUid = noteUser?.getUid('gs');
      } catch (_) {}
    }

    let payload;
    try {
      payload = await loadRoleCombat(requestedMonth);
    } catch (err) {
      logger.error('[xhh][role_combat] 获取Nanoka数据失败:', err);
      return e.reply(`幻想真境剧诗数据获取失败：${err.message || err}`);
    }
    const data = extractCharacters(payload.raw);
    const monsters = extractMonsters(payload.raw);
    if (!data.elements.length || !data.opening.length || !data.invite.length) {
      return e.reply('本期幻想真境剧诗数据不完整，请稍后再试或更换数据源。');
    }

    // 获取查询目标的角色列表并过滤
    let userAvatars = null;
    let ckMissing = false;
    let queryUserName = targetName;
    let queryUserUid = targetUid;
    try {
      await prepareMysContext(e, 'gs');
      const mys = await MysApi.init(e, 'cookie');
      if (mys && mys.uid && await mys.checkCk()) {
        // 以 mys.uid 为准，确保过滤与展示的是同一个人（@目标已通过 e.at 传入）
        const player = Player.create(e);
        // 使用与#喵喵统计相同的方法获取角色数据
        const avatarRet = await player.refreshAndGetAvatarData({
          index: 2,
          detail: 1,
          talent: 1,
          rank: true,
          materials: false,
          retType: "array",
          sort: true,
          isRole: true
        }, 'gs');
        
        // 合并开幕角色（确保开幕角色总是显示）
        const openingIds = data.opening.map(c => c.id);
        const mergedAvatars = mergeStart(avatarRet, openingIds);
        
        userAvatars = mergedAvatars.map(a => ({
          id: a.id,
          name: a.name,
          elem: a.elem,
          star: a.star,
          level: a.level || 0,
        }));
        // 统一以 MysInfo 解析出的 uid 作为展示 uid，避免两条路径不一致
        queryUserUid = mys.uid;
        if (!queryUserName) queryUserName = e.user?.nickname || '当前用户';
      } else {
        // 有查询目标但拿不到可用 CK，无法读取角色列表
        ckMissing = true;
      }
    } catch (err) {
      ckMissing = true;
      logger.debug('[xhh][role_combat] 获取用户角色列表失败:', err.message);
    }

    // 过滤用户拥有的角色；无法读取角色时保持全量并标记，避免误导为"全部拥有"
    let filteredAvailable = data.available;
    let filterApplied = false;
    if (userAvatars) {
      const userCharMap = new Map(userAvatars.map(c => [c.id, c]));
      const inviteSet = new Set(data.invite.map(c => c.id));
      const elementSet = new Set(data.elements);
      const travelerIds = [10000005, 10000007];
      
      filteredAvailable = data.available.filter(c => {
        const userChar = userCharMap.get(c.id);
        const level = userChar?.level;
        // 主角特殊处理：需要匹配用户主角的实际元素
        if (travelerIds.includes(c.id)) {
          if (!userChar || userChar.level < 70) return false;
          return userChar.elem === c.elem && elementSet.has(c.elem);
        }
        // 检查是否满足条件：是特邀角色或元素匹配，且等级≥70，且不是人偶
        const isInvite = inviteSet.has(c.id);
        const isElementMatch = elementSet.has(c.elem);
        const isNotManekin = c.id !== 10000117 && c.id !== 10000118;
        return (isInvite || isElementMatch) && level !== undefined && level >= 70 && isNotManekin;
      });
      filterApplied = true;
    }

    // 获取自定义背景图（支持子文件夹；Windows 路径/file URL 兼容）
    let bgImage = '';
    try {
      const gsNames = new Set();
      try {
        Character.forEach(char => {
          if (char?.game === 'gs' && char.name) gsNames.add(char.name);
          return true;
        }, 'release', 'gs');
      } catch (_) {}
      bgImage = pickRoleCombatBgImage({
        logTag: 'xhh-TL/role_combat',
        filterDir: gsNames.size ? (name) => gsNames.has(name) : null,
      });
    } catch (err) {
      logger.error('[xhh][role_combat] 加载背景图失败:', err);
    }

    const tplFile = pluginDir + '/resources/role_combat/role_combat.html';
    const ppath = '../../../../plugins/xhh-TL/resources/';
    const renderData = {
      ...data,
      available: filteredAvailable,
      monsters,
      month: `${payload.month.slice(0, 4)}-${payload.month.slice(4)}`,
      requestedMonth: `${payload.requestedMonth.slice(0, 4)}-${payload.requestedMonth.slice(4)}`,
      range: `${payload.minMonth} - ${payload.maxMonth}`,
      version: payload.version,
      fallback: payload.fallback,
      generatedAt: moment().format('MM-DD HH:mm'),
      queryUser: queryUserName,
      queryUid: queryUserUid,
      filterApplied,
      ckMissing,
      bgImage,
    };
    const renderScale = getRenderScaleStyle(config(), 1.5);
    const renderResult = await e.runtime.render('xhh-TL', 'role_combat', renderData, {
      retType: 'base64',
      imgType: 'png',
      beforeRender({ data }) {
        return {
          ...data,
          imgType: 'png',
          sys: { scale: renderScale },
          ppath,
          tplFile,
          saveId: 'role_combat',
        };
      }
    });
    const image = extractRenderBuffer(renderResult);
    if (image) return e.reply(segment.image(image), true);
    return e.reply('渲染失败，请稍后再试');
  }
}
