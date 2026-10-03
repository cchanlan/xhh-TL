import moment from 'moment';
import path from 'path';
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js';
import { createUser } from '../utils/userBind.js';
import { prepareMysContext } from '../utils/runtimePatch.js';
import { config, pickRoleCombatBgImage, pluginDir, toFileUrl } from '../utils/pluginConfig.js'
import { replyProgress } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'
import { guardModule } from '../utils/modules.js'

import { fetchIndex, fetchPhase, findIndexByMonth, giMonsterDb, aliothText } from '../utils/alioth.js'

const ELEMENT_MAP = {
  2: 'pyro', 3: 'hydro', 4: 'dendro', 5: 'electro', 6: 'cryo', 7: 'anemo', 8: 'geo',
  Fire: 'pyro', Water: 'hydro', Grass: 'dendro', Elec: 'electro', Ice: 'cryo', Wind: 'anemo', Rock: 'geo',
};
const ELEMENT_CN = { pyro: '火', hydro: '水', dendro: '草', electro: '雷', cryo: '冰', anemo: '风', geo: '岩' };
const ELEMENT_CLASS = { pyro: 'pyro', hydro: 'hydro', dendro: 'dendro', electro: 'electro', cryo: 'cryo', anemo: 'anemo', geo: 'geo' };
const START_MONTH = { year: 2024, month: 7 };

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
  // ⚠️ 月份交替的顺序必须是「两位数在前」：`0?[1-9]|1[0-2]` 会让 `202610` 先命中 `1`
  // （`0?` 可省），正则不会回溯去试 `10` —— 结果 10/11/12 月全被解析成 1 月。
  // 症状很隐蔽：指令正则照样匹配，但查到的是 1 月，不在数据包里就 fallback 到最新一期。
  let m = raw.match(/(20\d{2})(?:[-/.年]?)(1[0-2]|0?[1-9])(?:月)?\s*$/);
  if (m) return `${m[1]}${String(Number(m[2])).padStart(2, '0')}`;
  m = raw.match(/(20\d{2})[-/.年]?(\d{1,2})月?\s*$/);
  if (m) return `${m[1]}${m[2].padStart(2, '0')}`;
  return moment().format('YYYYMM');
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
  // Alioth 使用短角色 ID；角色元素、星级与头像继续复用喵喵元数据。
  const ids = list => list.map(v => {
    const id = Number(v.ID);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Alioth 剧诗角色 ID 无效');
    return id < 10000000 ? id + 10000000 : id;
  });
  if (!Array.isArray(raw.Initial) || !Array.isArray(raw.Invitation) || !Array.isArray(raw.Elem)) {
    throw new Error('Alioth 剧诗缺少角色或元素列表');
  }
  const elements = raw.Elem.map(v => {
    if (!ELEMENT_MAP[v]) throw new Error(`Alioth 剧诗未知元素：${v}`);
    return ELEMENT_MAP[v];
  });
  const characters = list => uniqById(ids(list).map(id => {
    const char = charById(id);
    // 不能用 filter(Boolean) 悄悄丢掉新角色，老版本喵喵缺数据时整期明确报错。
    if (!char?.name || !ELEMENT_CN[char.elem]) throw new Error(`喵喵角色元数据缺失：${id}`);
    return char;
  }));
  const opening = characters(raw.Initial);
  const invite = characters(raw.Invitation);
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

function extractMonsters(raw, monDb) {
  // 与 #版本剧诗 相同：Chambers.Configs → MP 怪物 ID，Arcana 为圣牌挑战。
  const stages = { 3: '第三幕', 6: '第六幕', 8: '第八幕', 10: '第十幕' };
  const namesOf = ids => [...new Set(ids.map(id => {
    const name = aliothText(monDb.get(String(id))?.Name || '');
    if (!name) throw new Error(`Alioth 剧诗怪物名称缺失：${id}`);
    return name;
  }))];
  const monsters = [];
  for (const c of raw.Chambers || []) {
    if (!stages[c._id]) continue;
    const ids = (c.Configs || []).flatMap(k => {
      const ids = raw.MP?.[String(k)];
      if (!Array.isArray(ids) || !ids.length) throw new Error(`Alioth 剧诗怪物配置缺失：${k}`);
      return ids;
    });
    if (ids.length) monsters.push({ stage: stages[c._id], names: namesOf(ids) });
  }
  (raw.Arcana || []).forEach((a, i) => {
    const ids = (a.Monsters || []).map(m => m.ID);
    if (ids.length) monsters.push({ stage: `圣牌挑战 ${['I', 'II', 'III', 'IV', 'V'][i] || i + 1}`, names: namesOf(ids) });
  });
  return monsters;
}

async function loadRoleCombat(month) {
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(String(month))) {
    throw Object.assign(new Error(`无效剧诗月份：${month}`), { code: 'INVALID_MONTH' });
  }
  const index = await fetchIndex('theater');
  const selected = findIndexByMonth(index.phases, month);
  const phase = index.phases[selected];
  // 只取请求月份，不使用 Latest 或最近已开始的一期代替缺失月份。
  if (!phase || phase._begin?.format('YYYYMM') !== month) {
    throw Object.assign(new Error(`Alioth 未收录剧诗月份：${month}`), { code: 'MONTH_NOT_FOUND' });
  }
  const raw = await fetchPhase('theater', phase._id);
  if (String(raw._id) !== String(phase._id)) throw new Error('Alioth 剧诗详情期号与索引不符');
  const monDb = await giMonsterDb();
  const months = index.phases.map(p => p._begin?.format('YYYYMM')).filter(Boolean);
  return {
    version: phase.Ver || '', minMonth: months[0], maxMonth: months[months.length - 1],
    month, requestedMonth: month, fallback: false, raw, monDb,
  };
}

export class role_combat extends plugin {
  constructor() {
    super({
      name: '[小火花]幻想真境剧诗',
      dsc: '原神幻想真境剧诗当期可用角色',
      event: 'message',
      priority: -9999,
      rule: [
        {
          // #下期幻想角色 / #下期幻想剧诗角色 — 以当前月为基准取下一期（下月）角色池
          // 注意：需排在通用规则之前，避免被 (?:原神)?幻想… 抢先匹配
          reg: '^\\s*#?(?:原神)?下期(?:幻想剧诗(?:角色|可用角色|当期角色|本期角色|查询)?|幻想角色|幻想可用角色|幻想当期角色|幻想本期角色|幻想查询|幻想剧诗|幻想)\\s*$',
          fnc: 'nextRoleCombat',
        },
        {
          // #幻想剧诗 / 幻想角色 / #幻想202607；仅允许可选月份后缀，其它尾巴不触发
          // 可选 #；仅允许已知后缀/月份，尾部乱码不触发
          reg: '^\\s*#?(?:原神)?(?:幻想剧诗(?:角色|可用角色|当期角色|本期角色|查询)?|幻想角色|幻想可用角色|幻想当期角色|幻想本期角色|幻想查询|幻想(?:角色|可用角色|当期角色|本期角色|查询|剧诗)?(?:20\\d{4}|20\\d{2}[-/.年]?\\d{1,2}月?))\\s*$',
          fnc: 'roleCombat',
        },
      ],
    });
  }

  async nextRoleCombat(e) {
    // 以当前月为基准 +1 个月，作为“下期”请求月份；数据未发布时明确提示该月暂无数据
    const cur = moment().format('YYYYMM');
    const nextMonth = indexToMonth(monthToIndex(cur) + 1);
    return this.queryRoleCombat(e, nextMonth);
  }

  async roleCombat(e) {
    // 指令入口只收事件，避免宿主传入的正则匹配结果被当作月份。
    return this.queryRoleCombat(e, parseMonth(e.msg || ''));
  }

  async queryRoleCombat(e, requestedMonth) {
    await replyProgress(e, '正在获取幻想真境剧诗数据，请稍后...');

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

    let payload, data, monsters;
    try {
      payload = await loadRoleCombat(requestedMonth);
      data = extractCharacters(payload.raw);
      monsters = extractMonsters(payload.raw, payload.monDb);
    } catch (err) {
      logger.error('[xhh][role_combat] 获取 Alioth.wiki 数据失败:', err);
      if (err.code === 'MONTH_NOT_FOUND') return e.reply(`${requestedMonth.slice(0, 4)}-${requestedMonth.slice(4)} 幻想真境剧诗暂无数据，请换个月份查询`);
      if (err.code === 'INVALID_MONTH') return e.reply('请使用有效月份，例如 #幻想角色202610');
      return e.reply(`幻想真境剧诗数据获取失败，请稍后重试`);
    }
    if (!data.elements.length || !data.opening.length || !data.invite.length) {
      return e.reply('本期幻想真境剧诗数据不完整，请稍后再试');
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

    const cfg = config();
    const themeRaw = String(cfg.role_combat_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase();
    const theme = themeRaw === 'dark' ? 'dark' : 'light';
    const tplFile = pluginDir + '/resources/role_combat/role_combat.html';
    const renderData = {
      ...data,
      theme,
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
    return renderTpl(e, {
      tpl: 'role_combat',
      tplFile,
      data: renderData,
      baseScale: 1.5,
      rem: true,
    });
  }
}

/**
 * role_combat 开关同时管住「幻想角色」与「小剧诗」。
 *
 * 历史遗留：这个键过去只在 miniRoleCombat.js 里被读，role_combat.js 一次都没读，
 * 于是锅巴里关掉「启用幻想真境剧诗 / 小剧诗」后 #小剧诗 停了、
 * #幻想角色 / #幻想剧诗 / #幻想202607 却照常出图 —— 说明与实现不符。
 * 小剧诗那一侧由 miniRoleCombat.js 自己守卫，这里补上幻想角色这半边。
 */
guardModule(role_combat, 'role_combat', ['nextRoleCombat', 'roleCombat'])
