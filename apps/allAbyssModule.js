/**
 * 全部深渊功能：混沌回忆、虚构叙事、末日幻影三合一渲染
 * 使用方法：发送 *全部深渊 或 深渊总览 等指令
 * 兼容：原版 miao-plugin 和 ccxhan 分支版本
 */

import moment from 'moment';
import lodash from 'lodash';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { getRenderScaleStyle, config, pluginDir } from '../utils/pluginConfig.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { replyQuote } from '../utils/replyHelper.js'

// miao-plugin 模块（动态导入）
let MysApi, Player, Character, Common;
let miaoLoaded = false;

async function loadMiaoModules() {
  if (miaoLoaded) return true;
  try {
    const miaoModels = await import('../../miao-plugin/models/index.js');
    const miaoComponents = await import('../../miao-plugin/components/index.js');
    MysApi = miaoModels.MysApi;
    Player = miaoModels.Player;
    Character = miaoModels.Character;
    Common = miaoComponents.Common;
    miaoLoaded = true;
    return true;
  } catch (err) {
    console.error('[xhh-TL][allAbyss] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

/**
 * 兼容层：为原版 miao-plugin 补充星铁深渊 API
 * 原版只有 getSpiralAbyss，分支版本有 getChallengeChaos/Story/Boss
 */
function ensureChallengeMethods(mysInstance) {
  if (!mysInstance) return mysInstance;

  // 如果分支版本已有这些方法，直接返回
  if (mysInstance.getChallengeChaos && mysInstance.getChallengeStory && mysInstance.getChallengeBoss && mysInstance.getChallengePeak) {
    return mysInstance;
  }

  // 为原版 miao-plugin 添加兼容方法
  if (!mysInstance.getChallengeChaos) {
    mysInstance.getChallengeChaos = async function(type = 1) {
      return await this.getData('spiralAbyss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeStory) {
    mysInstance.getChallengeStory = async function(type = 1) {
      return await this.getData('challengeStory', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeBoss) {
    mysInstance.getChallengeBoss = async function(type = 1) {
      return await this.getData('challengeBoss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengePeak) {
    mysInstance.getChallengePeak = async function(type = 1) {
      return await this.getData('challengePeak', { schedule_type: type === 2 ? 3 : 1 });
    };
  }

  // 原版 miao-plugin 可能没有 checkCk 方法
  if (!mysInstance.checkCk) {
    mysInstance.checkCk = async function() {
      try {
        return !!(this.ck || this.ckInfo?.ck);
      } catch (_) {
        return false;
      }
    };
  }

  return mysInstance;
}

// 元素图标映射
function elemIcon(element) {
  const elemMap = {
    physical: 'elem-phy',
    fire: 'elem-fire',
    ice: 'elm-ice',
    lightning: 'elem-elec',
    wind: 'elem-wind',
    quantum: 'elem-auantum',
    imaginary: 'elem-imaginary'
  };
  return elemMap[element] ? `meta-sr/public/icons/${elemMap[element]}.webp` : '';
}

// 时间格式化
function timeCalc(t) {
  if (!t) return '';
  const date = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return `${date} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// 处理深渊数据
function processChallengeData(res, tag, type) {
  if (!res || typeof res !== 'object') return null;

  const isStory = tag === 'story';
  const isBoss = tag === 'boss';
  const toNum = val => Number(val) || 0;

  let floors = Array.isArray(res?.all_floor_detail) ? res.all_floor_detail : [];
  logger.info(`[xhh-TL][allAbyss] ${tag} 原始楼层数据: ${floors.length} 个, 楼层: ${floors.map(f => f?.floor || f?.name || '未知').join(', ')}`);

  // 根据不同类型过滤楼层
  if (tag === 'chaos') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2));
  } else if (tag === 'story') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2)).slice(0, 4);
  } else if (tag === 'boss') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1?.avatars?.length || f?.node_2?.avatars?.length || f?.node_3?.avatars?.length));
  }

  if (floors.length === 0) return null;

  const normalizeNode = (node) => {
    if (!node) return null;
    const avatars = lodash.map(Array.isArray(node.avatars) ? node.avatars : [], a => {
      if (!a?.id) return a;
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
    return { ...node, avatars, score: node.score || 0, time: timeCalc(node.challenge_time) };
  };

  let group;
  if (tag === 'story') {
    group = res?.groups?.[type - 1];
  } else if (tag === 'boss') {
    group = res?.groups?.[0];
  } else {
    group = res?.groups?.[type - 1];
  }

  return {
    group: group || {},
    battleNum: res?.battle_num,
    totalStar: toNum(res?.star_num),
    extraStar: toNum(res?.extra_star_num),
    totalScore: res?.score || 0,
    bestFloor: res?.max_floor,
    floors: lodash.map(floors, floor => {
      const node1 = normalizeNode(floor?.node_1);
      const node2 = normalizeNode(floor?.node_2);
      const node3 = normalizeNode(floor?.node_3);
      const isFast = floor?.is_fast;
      const extraStar = toNum(floor?.extra_star_num);
      const score = isStory && isFast ? 0 : toNum(node1?.score) + toNum(node2?.score) + toNum(node3?.score);
      const star = toNum(floor?.star_num);
      return {
        ...floor,
        name: floor?.name || (tag === 'chaos' ? '混沌回忆' : tag === 'story' ? '虚构叙事' : '末日幻影'),
        star: Math.max(0, star - extraStar),
        extraStar,
        score,
        roundNum: isStory && isFast ? 0 : floor?.round_num,
        isFast,
        node1,
        node2,
        node3
      };
    })
  };
}

// 处理异相仲裁数据
function processPeakData(res) {
  if (!res || typeof res !== 'object') return null;

  const record = res?.challenge_peak_records?.[0];
  if (!record?.has_challenge_record) return null;

  const recordBrief = res?.challenge_peak_best_record_brief || {};
  const bossInfo = record?.boss_info || {};
  const bossRecord = record?.boss_record || {};
  const mobInfos = record?.mob_infos || [];
  const mobRecords = record?.mob_records || [];

  const normalizeAvatars = (avatars) => {
    if (!avatars) return [];
    return lodash.map(avatars, a => {
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
  };

  return {
    nickname: res?.role?.nickname || '',
    bossName: bossInfo.name || '将杀王棋',
    bossIcon: bossInfo.icon || '',
    bossStars: bossRecord?.star_num || 0,
    mobStars: recordBrief.mob_stars || 0,
    totalStars: (bossRecord?.star_num || 0) + (recordBrief.mob_stars || 0),
    bossRound: bossRecord?.round_num || 0,
    bossAvatars: normalizeAvatars(bossRecord?.avatars),
    mobs: mobInfos.map((info, idx) => {
      const mobRecord = mobRecords[idx] || {};
      return {
        index: idx + 1,
        name: info.name || `关卡${idx + 1}`,
        icon: info.icon || '',
        round: mobRecord?.round_num || 0,
        stars: mobRecord?.star_num || 0,
        avatars: normalizeAvatars(mobRecord?.avatars)
      };
    })
  };
}

/* ============ 模块网格：把四个模式归一化成同尺寸的战绩格 ============
 * 桌面版排版是「12 栅格 + 每格 span 3」的模块网格：
 * 一行固定 4 格，格子上下左右都落在同一套网格线上。
 * 每个模式的格数补齐到 4 的倍数（不足的用 filler 信息格填），
 * 这样任何数据量下都不会出现半空的一行。
 */
const GRID_COLS = 4

// 关卡名去掉「星启模式」后缀，后缀单独做角标
function splitFloorName(raw) {
  const name = String(raw || '')
  const m = name.match(/^(.*?)(星启模式)$/)
  return m ? { name: m[1], starMode: true } : { name, starMode: false }
}

function pickBuff(node) {
  const buff = node?.buff || node?.maze_buff || (Array.isArray(node?.buff_list) ? node.buff_list[0] : null)
  if (!buff) return null
  return {
    icon: buff.icon || '',
    name: buff.name_mi18n || buff.name || '关卡效果',
    desc: buff.desc_mi18n || buff.desc || ''
  }
}

// 一个模式的战绩格：来自 floors[].node1/2/3
function tilesFromFloors(data) {
  const tiles = []
  lodash.forEach(data?.floors || [], floor => {
    const { name, starMode } = splitFloorName(floor?.name)
    const nodes = [floor?.node1, floor?.node2, floor?.node3]
    const valid = nodes.filter(n => n?.avatars?.length)
    lodash.forEach(valid, (node, idx) => {
      tiles.push({
        floorName: name,
        starMode,
        floorStar: Number(floor?.star) || 0,
        floorExtraStar: Number(floor?.extraStar) || 0,
        nodeLabel: `节点${nodes.indexOf(node) + 1}`,
        first: idx === 0,
        nodeCount: valid.length,
        round: floor?.roundNum,
        isFast: !!floor?.isFast,
        score: Number(node?.score) || 0,
        time: node?.time || '',
        avatars: node.avatars,
        buff: pickBuff(node)
      })
    })
  })
  return tiles
}

// 异相仲裁：Boss 一格 + 每个精英怪一格
function tilesFromPeak(peak) {
  if (!peak) return []
  const tiles = []
  if (peak.bossAvatars?.length) {
    tiles.push({
      floorName: peak.bossName || '将杀王棋',
      starMode: false,
      floorStar: Number(peak.bossStars) || 0,
      floorExtraStar: 0,
      nodeLabel: 'Boss',
      first: true,
      nodeCount: 1,
      round: peak.bossRound,
      score: 0,
      time: '',
      avatars: peak.bossAvatars,
      buff: null
    })
  }
  lodash.forEach(peak.mobs || [], mob => {
    if (!mob?.avatars?.length) return
    tiles.push({
      floorName: mob.name,
      starMode: false,
      floorStar: Number(mob.stars) || 0,
      floorExtraStar: 0,
      nodeLabel: `关卡${mob.index}`,
      first: true,
      nodeCount: 1,
      round: mob.round,
      score: 0,
      time: '',
      avatars: mob.avatars,
      buff: null
    })
  })
  return tiles
}

// 出场角色统计：填充格用，顺带能看出这期主力
function countAvatars(tiles, avatarData) {
  const hit = {}
  lodash.forEach(tiles, t => lodash.forEach(t.avatars || [], a => {
    if (!a?.id) return
    hit[a.id] = hit[a.id] || { id: a.id, n: 0 }
    hit[a.id].n += 1
  }))
  return lodash.orderBy(Object.values(hit), ['n'], ['desc']).slice(0, 10).map(x => {
    const av = avatarData?.[x.id]
    return { id: x.id, n: x.n, face: av?.face || '', name: av?.abbr || av?.name || '', star: av?.star || 5 }
  })
}

// 战绩清单：每场一行（关卡 / 节点 / 星数 / 分数），行数跟着场数走，能把填充格撑满
function floorSummary(sec) {
  let last = ''
  return lodash.map(sec.tiles, t => {
    const head = t.floorName !== last
    const row = {
      name: head ? t.floorName : '',
      node: t.nodeLabel,
      starMode: head && t.starMode,
      star: head ? t.floorStar : 0,
      extraStar: head ? t.floorExtraStar : 0,
      score: t.score || 0,
      time: t.time || (t.round != null ? `轮次 ${t.round}` : '')
    }
    last = t.floorName
    return row
  })
}

// 补齐到整行：不足的格子放信息卡（出场角色 / 战绩清单 / 本期节点 / 统计周期）
// 每个模式第一格固定放哪张卡、后面按什么顺序补，都按主人定的来
const FILLER_SEQ = {
  chaos: ['chars', 'floors', 'period'],
  boss: ['bosses', 'chars', 'floors', 'period'],
  story: ['chars', 'period', 'floors'],
  peak: ['bossimg']
}
const FILLER_FALLBACK = ['chars', 'floors', 'period']

function makeFiller(kind, sec, avatarData) {
  if (kind === 'chars') {
    const chars = countAvatars(sec.tiles, avatarData)
    return chars.length ? { kind, title: '本模式出场', chars } : null
  }
  if (kind === 'floors') {
    const floors = floorSummary(sec)
    return floors.length ? { kind, title: '战绩清单', floors, showScore: floors.some(f => f.score > 0) } : null
  }
  if (kind === 'bosses') {
    return sec.bosses?.length ? { kind, title: '本期节点', bosses: sec.bosses } : null
  }
  if (kind === 'bossimg') {
    return sec.bossImg ? { kind, title: '本期 Boss', img: sec.bossImg, name: sec.best, star: sec.star } : null
  }
  if (kind === 'period') {
    return {
      kind,
      title: '本期概况',
      period: sec.period,
      star: sec.star,
      extraStar: sec.extraStar,
      rows: lodash.compact([
        sec.best ? { k: '最高关卡', v: sec.best } : null,
        sec.battle != null ? { k: '挑战次数', v: `${sec.battle} 次` } : null,
        sec.totalScore ? { k: '总分', v: String(sec.totalScore) } : null,
        { k: '关卡 / 场次', v: `${sec.floorCount} 关 · ${sec.tiles.length} 场` }
      ])
    }
  }
  return null
}

function buildFillers(sec, need, avatarData) {
  if (need <= 0) return []
  const seq = FILLER_SEQ[sec.key] || []
  // breakRow 的模式（异相仲裁）只用指定的那几张卡，宁可留白也不塞别的
  const order = sec.breakRow ? seq : lodash.uniq([...seq, ...FILLER_FALLBACK])
  const out = []
  for (const kind of order) {
    if (out.length >= need) break
    const f = makeFiller(kind, sec, avatarData)
    if (f) out.push(f)
  }
  // 种类不够就让排版用透明占位补，别把同一张卡印两遍
  return out
}

/* 按行铺格：每行 cols 格，规则是「信息卡靠左、战绩格靠右」
 * 第一行 = 指定的信息卡 + 最高难度那一关的各节点（不满就继续补信息卡）
 * 之后   = 剩下的信息卡 + 其余关卡的节点连续排
 * 异相仲裁例外（主人指定）：第一行只放 Boss 图 + Boss 战绩并且居中，
 * 精英关另起一行、平分整行宽度。
 */
const SPAN_TOTAL = 12
const SPAN_BY_COUNT = { 1: 12, 2: 6, 3: 4, 4: 3, 6: 2 }

function layoutItems(sec, cols) {
  const groups = []
  lodash.forEach(sec.tiles, t => {
    const g = groups.find(x => x.name === t.floorName)
    if (g) g.list.push(t)
    else groups.push({ name: t.floorName, list: [t] })
  })
  const unit = Math.round(SPAN_TOTAL / cols)
  const fq = [...(sec.fillers || [])]
  const items = []
  const gap = span => items.push({ gap: true, span })

  if (sec.breakRow) {
    // 第一行：Boss 图 + Boss 战绩，左右留白居中
    const row1 = []
    if (fq.length) row1.push({ filler: fq.shift(), span: unit })
    lodash.forEach(groups[0]?.list || [], t => row1.push({ tile: t, span: unit }))
    const pad = Math.max(0, cols - row1.length)
    const left = Math.floor(pad / 2)
    for (let i = 0; i < left; i++) gap(unit)
    items.push(...row1)
    for (let i = 0; i < pad - left; i++) gap(unit)
    // 其余关卡：一行一行铺，每行的格子平分整行宽度
    const rest = lodash.flatten(groups.slice(1).map(g => g.list))
    for (let i = 0; i < rest.length; i += cols) {
      const row = rest.slice(i, i + cols)
      const span = SPAN_BY_COUNT[row.length] || unit
      lodash.forEach(row, t => items.push({ tile: t, span }))
      if (!SPAN_BY_COUNT[row.length]) {
        for (let k = row.length; k < cols; k++) gap(unit)
      }
    }
    return items
  }

  if (fq.length) items.push({ filler: fq.shift(), span: unit })
  lodash.forEach(groups[0]?.list || [], t => items.push({ tile: t, span: unit }))
  while (items.length % cols !== 0 && fq.length) items.push({ filler: fq.shift(), span: unit })
  while (fq.length) items.push({ filler: fq.shift(), span: unit })
  lodash.forEach(lodash.flatten(groups.slice(1).map(g => g.list)), t => items.push({ tile: t, span: unit }))
  // 信息卡种类不够时最后一行用透明占位补齐，别让整行只填一半
  while (items.length % cols !== 0) gap(unit)
  return items
}

// 每个模式要几张信息卡：第一行按「信息卡 + 首关节点」凑整，其余节点再单独凑整
function fillerNeed(sec, cols) {
  if (sec.breakRow) return (FILLER_SEQ[sec.key] || []).length
  const firstLen = sec.tiles.filter(t => t.floorName === sec.tiles[0]?.floorName).length
  const restLen = sec.tiles.length - firstLen
  const head = (cols - ((1 + firstLen) % cols)) % cols
  const tail = (cols - (restLen % cols)) % cols
  return 1 + head + tail
}

function buildSections({ chaosData, bossData, storyData, peakData, avatarData }) {
  const raw = [
    { key: 'chaos', name: '忘却之庭', sub: '混沌回忆', data: chaosData },
    { key: 'boss', name: '末日幻影', sub: '末日幻影', data: bossData },
    { key: 'story', name: '虚构叙事', sub: '虚构叙事', data: storyData },
    { key: 'peak', name: '异相仲裁', sub: '异相仲裁', data: peakData }
  ]
  const sections = []
  for (const item of raw) {
    if (!item.data) continue
    const isPeak = item.key === 'peak'
    const tiles = isPeak ? tilesFromPeak(item.data) : tilesFromFloors(item.data)
    if (!tiles.length) continue
    const group = item.data?.group || {}
    const bosses = lodash.compact([
      group.upper_boss && { label: '节点1', icon: group.upper_boss.icon },
      group.lower_boss && { label: '节点2', icon: group.lower_boss.icon },
      group.tierce_boss && { label: '节点3', icon: group.tierce_boss.icon }
    ])
    const firstFloor = tiles[0]?.floorName
    sections.push({
      key: item.key,
      name: item.name,
      sub: item.sub,
      tiles,
      hasBuff: tiles.some(t => t.buff),
      star: isPeak ? (Number(item.data.totalStars) || 0) : (Number(item.data.totalStar) || 0),
      extraStar: isPeak ? 0 : (Number(item.data.extraStar) || 0),
      best: isPeak ? (item.data.bossName || '') : (item.data.bestFloor || ''),
      battle: isPeak ? null : item.data.battleNum,
      // 总分只算最高难度那一关，把低难度的旧场次也加进来没意义
      totalScore: isPeak ? 0 : lodash.sumBy(tiles.filter(t => t.floorName === firstFloor), t => t.score || 0),
      floorCount: isPeak ? tiles.length : (item.data.floors?.length || 0),
      bosses: isPeak ? [] : bosses,
      bossImg: isPeak ? (item.data.bossIcon || '') : '',
      // 异相仲裁：Boss 关和精英关分行放，空位用占位格
      breakRow: isPeak,
      period: isPeak ? '' : `${timeCalc(group.begin_time)} - ${timeCalc(group.end_time)}`
    })
  }
  // 列数：数据少的时候别硬撑 4 列，否则整行都是填充格
  const total = lodash.sumBy(sections, s => s.tiles.length)
  const cols = Math.max(1, Math.min(GRID_COLS, total))
  for (const sec of sections) {
    sec.fillers = buildFillers(sec, fillerNeed(sec, cols), avatarData)
    sec.items = layoutItems(sec, cols)
  }
  return { sections, cols }
}

// 处理开拓者ID兼容
function matchTrailblazerId(playerAvatarIds, apiId) {
  let id = apiId * 1;
  let baseId = id % 2 === 0 ? id - 1 : id;
  return [baseId, baseId + 1].find(i => playerAvatarIds.includes(i + "")) || apiId;
}

// 全部深渊功能：混沌、虚构、末日、异相四合一
export async function allAbyss(e) {
    try {
      // 锅巴开关：关闭则不响应（与 gsAllAbyss/hardTeam/holdRate 一致）
      if (config().all_abyss === false) return false;

      // 加载 miao-plugin 模块
      const loaded = await loadMiaoModules();
      if (!loaded || !MysApi || !Common) {
        e.reply('miao-plugin 模块加载失败，请检查插件是否正确安装');
        return false;
      }

      // 初始化 MysApi
      e.isSr = true;
      await prepareMysContext(e, 'sr');
      let mys = await MysApi.init(e, 'all');
      if (!mys || !await mys.checkCk()) {
        e.reply(mys ? `UID: ${mys.uid} Cookie 失效，请【#刷新ck】，仍不行则【#扫码登录】` : '请先【#扫码登录】或绑定 CK 后再使用 *全部深渊');
        return false;
      }

      // 兼容原版 miao-plugin（补充星铁深渊 API）
      mys = ensureChallengeMethods(mys);

      const uid = mys.uid;
      const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
      const player = Player.create(e);

      // 从锅巴配置读取渲染模式
      const renderMode = config().all_abyss_render_mode || 'desktop';
      const isMobile = renderMode === 'mobile';
      // 获取背景图路径
      const msg = e.original_msg || e.msg || '';
      const bgImageMatch = msg.match(/背景[：:]?\s*(.+)/);
      const bgImage = bgImageMatch ? bgImageMatch[1].trim() : '';

      // 获取四个深渊模式的数据
      let chaosRes, storyRes, bossRes, peakRes;
      try {
        [chaosRes, storyRes, bossRes, peakRes] = await Promise.all([
          mys.getChallengeChaos(type),
          mys.getChallengeStory(type),
          mys.getChallengeBoss(type),
          mys.getChallengePeak(type)
        ]);
      } catch (err) {
        logger.error('[xhh-TL][allAbyss] 获取深渊数据失败:', err);
        e.reply('获取深渊数据失败，请稍后重试');
        return false;
      }

      // 处理混沌回忆数据
      const chaosData = processChallengeData(chaosRes, 'chaos', type);
      // 处理虚构叙事数据
      const storyData = processChallengeData(storyRes, 'story', type);
      // 处理末日幻影数据
      const bossData = processChallengeData(bossRes, 'boss', type);
      // 处理异相仲裁数据
      const peakData = processPeakData(peakRes);

      // 检查是否有数据
      if (!chaosData && !storyData && !bossData && !peakData) {
        e.reply(`暂未获得${type === 2 ? '上期' : '本期'}深渊挑战数据...`);
        return false;
      }

      // 获取角色信息
      const avatarIds = [];
      const playerAvatarIds = player.getAvatarIds();
      const addAvatarId = (a) => {
        if (!a?.id) return a;
        if (!avatarIds.includes(a.id)) avatarIds.push(a.id);
        const char = Character.get(a.id, true);
        if (char) {
          a.name = a.name || char.name;
          a.abbr = a.abbr || char.abbr;
        }
        return a;
      };
      const addPeakAvatarId = (a) => {
        if (!a?.id) return a;
        if (a.id > 8000) a.id = matchTrailblazerId(playerAvatarIds, a.id);
        return addAvatarId(a);
      };

      // 收集所有角色ID
      if (chaosData?.floors) {
        lodash.forEach(chaosData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (storyData?.floors) {
        lodash.forEach(storyData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (bossData?.floors) {
        lodash.forEach(bossData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2, floor.node3], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (peakData) {
        lodash.forEach(peakData.bossAvatars, addPeakAvatarId);
        lodash.forEach(peakData.mobs, mob => lodash.forEach(mob.avatars, addPeakAvatarId));
      }

      // 刷新角色天赋
      try {
        if (!mys.isSelfCookie) {
          const _mys = await MysApi.init(e, 'cookie');
          if (_mys && await _mys.checkCk()) {
            await player.refreshProfile(2, true);
          }
        } else {
          await player.refreshProfile(2, true);
        }
        await player.refreshTalent(avatarIds);
      } catch (err) {
        logger.debug('[xhh-TL][allAbyss] 刷新角色信息失败:', err.message);
      }

      const avatarData = player.getAvatarData(avatarIds);
      lodash.forEach(avatarData, (av) => {
        if (!av?.talent) return;
        av.talentCount = Object.keys(av.talent).length;
        lodash.forEach(av.talent, (t, key) => {
          const talentMaxMap = { a: 7, e: 12, q: 12, t: 12, me: 7, mt: 7, j: 12 };
          t.max = talentMaxMap[key] || 12;
        });
      });

      // 使用三合一模板渲染
      const templateName = isMobile ? 'all-abyss-mobile' : 'all-abyss';
      const renderScale = getRenderScaleStyle(config(), isMobile ? 2.0 : 1.2);
      const tplFile = pluginDir + `/resources/${templateName}.html`;
      const ppath = '../../../../plugins/xhh-TL/resources/';
      // 桌面版是「12 栅格 + 每格 span 3」的模块网格：一行 4 格，格宽固定，
      // 画布宽度只跟列数有关（数据少时列数会降），跟模式数无关。
      const TILE_WIDTH = 370;
      const TILE_GAP = 8;
      const BODY_PADDING = 24; // .all-abyss-body 左右 padding 各 12
      const { sections, cols: gridCols } = buildSections({ chaosData, bossData, storyData, peakData, avatarData });
      const pageWidth = Math.round(
        BODY_PADDING + gridCols * TILE_WIDTH + Math.max(0, gridCols - 1) * TILE_GAP
      );
      const renderData = {
        chaosData,
        storyData,
        bossData,
        peakData,
        sections,
        gridCols,
        gridSpan: Math.round(12 / gridCols),
        pageWidth,
        avatars: avatarData,
        save_id: uid,
        uid,
        type,
        nickname: player.name || '开拓者',
        mysFailed: false,
        Array: (num) => num ? Array(num) : [],
        elemIcon,
        timeCalc
      };
      try {
        const renderResult = await e.runtime.render('xhh-TL', templateName, renderData, {
          retType: 'base64',
          imgType: 'png',
          beforeRender({ data }) {
            return {
              ...data,
              imgType: 'png',
              sys: { scale: renderScale },
              ppath,
              tplFile,
              saveId: templateName,
            };
          }
        });
        const image = await toWebp(extractRenderBuffer(renderResult));
        if (image) return replyQuote(e, segment.image(image));
        throw new Error('渲染结果中没有图片数据');
      } catch (err) {
        logger.error('[xhh-TL][allAbyss] 渲染三合一深渊失败:', err);
        e.reply('深渊数据渲染失败，请稍后重试');
        return false;
      }

      return true;
    } catch (err) {
      console.error('[xhh-TL][allAbyss] error:', err);
      e.reply('深渊查询出现错误，请稍后重试');
      return false;
    }
}
