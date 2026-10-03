/**
 * 版本深渊 / 挑战查询
 * 数据：Alioth.wiki（https://alioth.wiki）
 * - 原神：深境螺旋 abyss / 幻想真境剧诗 theater / 幽境危战 stygian
 * - 星铁：混沌回忆 chaos / 虚构叙事 fiction / 末日幻影 as / 异相仲裁 arbitration
 * 渲染：深色门户卡片
 *
 * 指令示例：
 *   #版本深渊 / #下期深渊 / #版本剧诗 / #下期剧诗 / #版本危战 / #下期危战
 *   *版本混沌 / *版本虚构 / *版本末日 / *版本异相
 *   期数：可接「列表 / 上期 / 第N期 / 9月 / 202609」
 */

import fetch from 'node-fetch'
import moment from 'moment'
import path from 'path'
import sharp from 'sharp'
import plugin from '../../../lib/plugins/plugin.js'
import { config as cfg, pluginDir } from '../utils/pluginConfig.js'
import { replyProgress, replyQuote, quoteEnabled } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'
import { guardModule } from '../utils/modules.js'
import {
  ELEM_CN,
  ELEM_CLASS,
  aliothRich,
  aliothText,
  fetchIndex,
  fetchPhase,
  findIndexByMonth,
  fmtHp,
  giMonsterDb,
  leylineArtUrl,
  monsterIconUrl,
  pickLiveIndex,
  pickNextIndex,
} from '../utils/alioth.js'

// ---------------- 通用 ----------------

/** 数据源（出图页脚展示） */
const SOURCE = 'Alioth.wiki'

/** 危战要展示的难度 */
const LEYLINE_DIFF = 5

/** 深境螺旋只出 11 / 12 层 */
const TOWER_KEEP_FLOORS = [11, 12]

/** 期数展示范围（列表） */
const LIST_WINDOW = 12

/** 危战抗性展示顺序（alioth 用元素英文名做 key） */
const LEY_RES = [
  { key: 'Fire', cls: 'pyro', name: '火' },
  { key: 'Water', cls: 'hydro', name: '水' },
  { key: 'Grass', cls: 'dendro', name: '草' },
  { key: 'Elec', cls: 'electro', name: '雷' },
  { key: 'Wind', cls: 'anemo', name: '风' },
  { key: 'Ice', cls: 'cryo', name: '冰' },
  { key: 'Rock', cls: 'geo', name: '岩' },
  { key: 'Phys', cls: 'physical', name: '物理' },
]

function fmtRange(begin, end) {
  const b = begin ? moment(begin).format('MM-DD HH:mm') : '?'
  const e = end ? moment(end).format('MM-DD HH:mm') : '?'
  return `${b} ~ ${e}`
}

/**
 * 怪物/关卡名可能自带富文本，例如
 *   「深罪浸礼者·<color style='...'><b>雷</b></color>…驱役者」
 * 模板里 {{name}} 会把它转义成一片乱码，统一清成纯文本。
 */
function plainName(s = '') {
  return aliothText(s)
}

function fmtDay(begin) {
  return begin ? moment(begin).format('YYYY-MM-DD') : ''
}

/** 数据通道：live 正式服（默认） / latest 下期 */
function parseChannel(msg = '') {
  const s = String(msg)
  if (/正式|正式服|现网|live/i.test(s) && !/下期|beta|前瞻/i.test(s)) return 'live'
  if (/下期|beta|beta服|前瞻|前瞻服|最新包|latest/i.test(s)) return 'latest'
  if (/测试|测试服/i.test(s)) return 'latest'
  return 'live'
}

function channelLabel(channel) {
  return channel === 'latest' ? '下期' : '正式服'
}

/** 上期 / 第N期 → 回看偏移 */
function listOffset(msg = '') {
  if (/上期|上一期|上赛季|上一轮|previous|prev/i.test(msg)) return 1
  const m = String(msg).match(/(?:第)?(\d{1,3})期/)
  if (m) return Math.max(0, Number(m[1]) - 1)
  return 0
}

/**
 * 月份寻址：#版本深渊9月 / #版本深渊202609 / #版本深渊2026年9月
 * 返回 'YYYYMM'，没有则空串。
 * ⚠️ 两位数月份必须排在前面（`0?[1-9]` 会先把 `10` 吃成 `1`），
 * 这是 role_combat.js 踩过的坑，这里照抄同样的写法。
 */
function parseMonthArg(msg = '') {
  const s = String(msg)
  let m = s.match(/(20\d{2})\s*[-/.年]?\s*(1[0-2]|0?[1-9])\s*月?/)
  if (m) return `${m[1]}${String(Number(m[2])).padStart(2, '0')}`
  m = s.match(/20\d{4}/)
  if (m) return m[0]
  m = s.match(/(1[0-2]|0?[1-9])\s*月/)
  if (m) return `${moment().format('YYYY')}${String(Number(m[1])).padStart(2, '0')}`
  return ''
}

/** 指令 → 选期参数 */
function parsePick(msg = '') {
  const channel = parseChannel(msg)
  const month = parseMonthArg(msg)
  return { channel, month, offset: month ? 0 : listOffset(msg) }
}

/**
 * 选期：先定基准（正式=今天落在哪期；下期=时间上的下一期），
 * 再按 月份 / 回看偏移 落到具体一期。
 * rel = 相对基准的回看偏移，模板用 `上{rel}期` 角标。
 */
function resolvePick(idx, pick = {}) {
  const { channel = 'live', month = '', offset = 0 } = pick
  const phases = idx.phases
  const liveIdx = pickLiveIndex(phases)
  let baseIdx = liveIdx
  let note = ''
  if (channel === 'latest') {
    const n = pickNextIndex(phases, liveIdx)
    if (n >= 0) baseIdx = n
    else note = '还没有下一期数据，已展示当期'
  }

  let index = baseIdx
  if (month) {
    const mi = findIndexByMonth(phases, month)
    if (mi >= 0) {
      index = mi
    } else {
      note = `${month.slice(0, 4)} 年 ${Number(month.slice(4))} 月没有对应期数，已展示当期`
    }
  } else {
    index = Math.max(0, baseIdx - Math.max(0, offset))
  }

  return {
    index,
    baseIdx,
    phase: phases[index],
    base: phases[baseIdx],
    rel: baseIdx - index,
    total: phases.length,
    note,
    month,
  }
}

/** 期数列表（#版本深渊列表） */
async function listPeriods(modeKey, channel = 'live', filter = null) {
  const idx = await fetchIndex(modeKey)
  const list = filter ? { ...idx, phases: idx.phases.filter(filter) } : idx
  const sel = resolvePick(list, { channel })
  const ch = channelLabel(channel)
  const out = []
  for (let i = sel.baseIdx; i >= 0 && out.length < LIST_WINDOW; i--) {
    const p = list.phases[i]
    const rel = sel.baseIdx - i
    const tag = rel === 0 ? '【当期】' : `【上${rel}期】`
    const name = p.Name ? `${p.Name} ` : ''
    out.push(
      `${tag} ${p._id} ${name}${p._begin ? p._begin.format('YYYY-MM-DD') : ''} ~ ${
        p._end ? p._end.format('YYYY-MM-DD') : ''
      } · ${ch} v${p.Ver || '-'}`,
    )
  }
  return out
}

/** 元素 → { name, cls } */
function elemTag(e) {
  return { name: ELEM_CN[e] || String(e), cls: ELEM_CLASS[e] || '' }
}
function elemTags(arr) {
  return (arr || []).map(elemTag)
}

// ---------------- 原神 · 深境螺旋 ----------------

async function loadGiTower(pick) {
  const idx = await fetchIndex('abyss')
  const sel = resolvePick(idx, pick)
  const phase = sel.phase
  const detail = await fetchPhase('abyss', phase._id)
  const monDb = detail.Monsters || {}
  const bless = (detail.Blessings || [])[0] || {}

  const floors = []
  for (const f of detail.Floors || []) {
    // Chambers 里同一「间」分上半/下半两条，按 Index 归并
    const byIdx = new Map()
    for (const c of f.Chambers || []) {
      const key = String(c.Index)
      if (!byIdx.has(key)) {
        byIdx.set(key, { id: c.Index, level: c.Level, first: [], second: [] })
      }
      const room = byIdx.get(key)
      if (!room.level && c.Level) room.level = c.Level
      const side = c.Half === 1 ? room.first : room.second
      const seen = new Map(side.map((m) => [String(m.id), m]))
      for (const w of c.Waves || []) {
        for (const mm of w.Monsters || []) {
          const id = String(mm.ID)
          const hp = Number(mm.HP) || 0
          const hit = seen.get(id)
          if (hit) {
            // 同一只怪跨波次：取最高血量那档
            if (hp > (hit.hp || 0)) {
              hit.hp = hp
              hit.hpText = fmtHp(hp)
            }
            continue
          }
          const info = monDb[id] || {}
          const item = {
            id,
            name: plainName(info.Name) || id,
            icon: monsterIconUrl('gi', info.Icon),
            hp,
            hpText: fmtHp(hp),
            num: Number(mm.Num) || 1,
          }
          seen.set(id, item)
          side.push(item)
        }
      }
    }
    const disorder = String(f.Disorder || '')
      .split(/<br\s*\/?>/i)
      .map((s) => aliothText(s))
      .filter(Boolean)
    floors.push({
      id: String(f.Index),
      floorLabel: `第 ${f.Index} 层`,
      buff: disorder,
      rooms: [...byIdx.values()],
    })
  }

  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'tower',
    modeName: '深境螺旋',
    version: phase.Ver || '',
    channel: pick.channel,
    channelLabel: channelLabel(pick.channel),
    periodId: phase._id,
    title: bless.Name || `第 ${phase._id} 期`,
    timeRange: fmtRange(phase._begin, phase._end),
    buffTitle: bless.Name || '深渊祝福',
    buffDesc: aliothText(bless.Desc || ''),
    floors,
    offset: sel.rel,
    total: sel.total,
    source: SOURCE,
    note: sel.note,
  }
}

// ---------------- 原神 · 幻想真境剧诗 ----------------

/** 关键幕（其余幕不出图，和站点/原实现口径一致） */
const THEATER_KEY_CHAMBERS = [3, 6, 8, 10]

async function loadGiRoleCombat(pick) {
  const idx = await fetchIndex('theater')
  const sel = resolvePick(idx, pick)
  const phase = sel.phase
  const detail = await fetchPhase('theater', phase._id)
  const monDb = await giMonsterDb()
  const MP = detail.MP || {}
  const MD = detail.MonDesc || {}

  const mon = (id, icon) => {
    const info = monDb.get(String(id)) || {}
    return {
      id,
      name: plainName(info.Name) || String(id),
      icon: monsterIconUrl('gi', icon || info.Icon),
    }
  }

  const stages = []
  for (const c of detail.Chambers || []) {
    if (!THEATER_KEY_CHAMBERS.includes(Number(c._id))) continue
    for (const k of c.Configs || []) {
      const ids = MP[String(k)] || []
      const monsters = ids.map((id) => mon(id))
      if (!monsters.length) continue
      stages.push({
        tag: `第 ${c._id} 幕`,
        title: monsters[0].name,
        desc: aliothText(MD[String(k)] || ''),
        level: c.Level,
        monsters,
      })
    }
  }
  const roman = ['I', 'II', 'III', 'IV', 'V']
  ;(detail.Arcana || []).forEach((a, i) => {
    const monsters = (a.Monsters || []).map((m) => mon(m.ID, m.Icon))
    if (!monsters.length) return
    stages.push({
      tag: `圣牌 ${roman[i] || i + 1}`,
      title: monsters[0].name,
      desc: '',
      level: monsters[0]?.level || '',
      monsters,
    })
  })

  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'rolecombat',
    modeName: '幻想真境剧诗',
    version: phase.Ver || '',
    channel: pick.channel,
    channelLabel: channelLabel(pick.channel),
    periodId: phase._id,
    title: `第 ${phase._id} 幕季`,
    timeRange: fmtRange(phase._begin, phase._end),
    elements: (detail.Elem || []).map((e) => ELEM_CN[e] || String(e)).filter(Boolean),
    inviteIds: (detail.Invitation || []).map((x) => x.ID),
    buffAvatars: (detail.Initial || []).map((x) => ({ id: x.ID, desc: '' })),
    stages,
    offset: sel.rel,
    total: sel.total,
    source: SOURCE,
    note: sel.note,
  }
}

// ---------------- 原神 · 幽境危战 ----------------

/** 站点 tag 行：`<img src=...>元素反应 | <img src=...>元素角色` → chip 段落 */
async function parseTagLine(html = '', good = true) {
  const raw = String(html || '').trim()
  if (!raw) return null
  const segs = raw.split(/(<img[^>]*>|\|)/i)
  const items = []
  for (const seg of segs) {
    if (!seg) continue
    const im = seg.match(/^<img[^>]*src="([^"]+)"/i)
    if (im) {
      const icon = await assetToDataUri(im[1], { size: 48 })
      if (icon) items.push({ type: 'icon', icon })
      continue
    }
    if (seg.trim() === '|') {
      items.push({ type: 'sep', text: '|' })
      continue
    }
    const t = aliothText(seg)
    if (t) items.push({ type: 'text', text: t })
  }
  if (!items.length) return null
  return { items, good, bad: !good }
}

async function loadGiLeyline(pick) {
  const idx = await fetchIndex('stygian')
  const sel = resolvePick(idx, pick)
  const phase = sel.phase
  const detail = await fetchPhase('stygian', phase._id)

  const levels = Array.isArray(detail.Levels) ? detail.Levels : []
  const lvIdx = Math.max(
    0,
    levels.findIndex((l) => Number(l.Level) === LEYLINE_DIFF),
  )
  const level = levels[lvIdx] || levels.at(-1)
  if (!level) throw new Error('幽境危战难度数据为空')

  const monDb = detail.Monsters || {}
  const hpShow = new Map((detail.HPShow || []).map((x) => [String(x.ID), x]))

  const bosses = []
  for (const id of level.Monsters || []) {
    const m = monDb[String(id)] || {}
    const hs = hpShow.get(String(id))
    const hp = hs?.HP?.[lvIdx] ?? m.Stats?.HP ?? 0
    const tagLines = []
    const adv = await parseTagLine(m.Advantage, true)
    if (adv) tagLines.push(adv)
    const dis = await parseTagLine(m.Disadvantage, false)
    if (dis) tagLines.push(dis)
    bosses.push({
      bid: String(id),
      name: plainName(m.Name) || String(id),
      title: plainName(m.Title),
      art: await assetToDataUri(leylineArtUrl(m.Icon), { size: 420, fit: 'inside' }),
      hpText: fmtHp(hp),
      monsterLevel: Number(m.Level) || 0,
      resists: LEY_RES.map((r) => {
        const raw = Number(m.RES?.[r.key])
        const v = Number.isFinite(raw) ? raw : 0.1
        return { cls: r.cls, name: r.name, value: `${Math.round(v * 100)}%` }
      }),
      tagLines,
      mechanics: (m.Buff || []).map((b) => ({
        name: aliothText(b.Name || ''),
        descHtml: aliothRich(b.Desc || ''),
      })),
    })
  }
  if (!bosses.length) throw new Error('幽境危战强敌数据为空')

  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'leyline',
    modeName: '幽境危战',
    version: phase.Ver || '',
    channel: pick.channel,
    channelLabel: channelLabel(pick.channel),
    periodId: phase._id,
    dateBegin: fmtDay(phase._begin),
    dateEnd: fmtDay(phase._end),
    diffNo: LEYLINE_DIFF,
    diffLabel: `难度 ${LEYLINE_DIFF}`,
    monsterLevel: bosses[0]?.monsterLevel || 0,
    bosses,
    offset: sel.rel,
    total: sel.total,
    source: SOURCE,
    note: sel.note,
  }
}

// ---------------- 星铁 · 四个终局模式 ----------------

/**
 * 模式定义（对应 alioth 的 hsr/ch/{path}）
 * - chaos       混沌回忆   *版本混沌 / *版本深渊
 * - fiction     虚构叙事   *版本虚构
 * - as          末日幻影   *版本末日
 * - arbitration 异相仲裁   *版本异相
 */
const HSR_MODES = {
  chaos: { key: 'chaos', modeName: '星铁·混沌回忆' },
  fiction: { key: 'fiction', modeName: '星铁·虚构叙事' },
  as: { key: 'as', modeName: '星铁·末日幻影' },
  arbitration: { key: 'arbitration', modeName: '星铁·异相仲裁' },
  // 记忆紊流：混在混沌索引里，id 100~199 那一段（老期数，站点也留着）
  memory: {
    key: 'chaos',
    modeName: '星铁·记忆紊流',
    filter: (p) => Number(p._id) >= 100 && Number(p._id) < 200,
  },
}

/** 一个 stage 的波次 → 怪物列表 */
/**
 * 只给「boss」留弱点标签
 *
 * 站点给每只杂兵都带 Weak，全标出来的话每个胶囊后面挂一串「物理/火/冰/量子」，
 * 胶囊长短参差、还常被挤成两行，整列看着就是没对齐（主人点名过虚构/末日）。
 * 一列里血量最高的那只就是 boss，只它保留弱点。
 * 返回新数组，不动原对象。
 */
function bossOnlyWeak(list = []) {
  if (!Array.isArray(list) || list.length < 2) return list
  let bi = 0
  for (let i = 1; i < list.length; i++) {
    if ((Number(list[i].hp) || 0) > (Number(list[bi].hp) || 0)) bi = i
  }
  return list.map((m, i) => (i === bi ? m : { ...m, weak: [] }))
}

/**
 * 按波次分组
 *
 * 站点给的怪是按波次排的，直接铺成两列网格的话，同一波（W2）会被拆到上下两行，
 * 读起来像「W1 旁边坐着 W2」（主人点名过）。这里按 wave 收成一组，
 * 模板一波一行；只有一波时不带 W 标记。
 */
function groupByWave(list = []) {
  const map = new Map()
  for (const m of list) {
    const no = Number(m.wave) || 0
    if (!map.has(no)) map.set(no, { no, monsters: [] })
    map.get(no).monsters.push(m)
  }
  const groups = [...map.values()]
  if (groups.length <= 1) return [{ no: 0, monsters: list }]
  return groups
}

function hsrMonstersFromStage(stage, monDb) {
  const out = []
  const seen = new Map()
  const waves = Array.isArray(stage?.Waves)
    ? stage.Waves
    : stage?.Waves && typeof stage.Waves === 'object'
      ? [{ Wave: 1, Monsters: [stage.Waves] }]
      : []
  waves.forEach((w, wi) => {
    for (const mm of w.Monsters || []) {
      const id = String(mm.ID)
      const info = monDb[id] || {}
      const hp = Number(mm.HP) || 0
      const hit = seen.get(id)
      if (hit) {
        if (hp > hit.hp) {
          hit.hp = hp
          hit.hpText = fmtHp(hp)
        }
        continue
      }
      const item = {
        id,
        name: plainName(info.Name) || id,
        icon: monsterIconUrl('hsr', info.Icon),
        hp,
        hpText: fmtHp(hp),
        weak: (info.Weak || []).map((x) => ELEM_CN[x] || x),
        wave: waves.length > 1 ? wi + 1 : 0,
      }
      seen.set(id, item)
      out.push(item)
    }
  })
  return out
}

/** Floors + Stages → 模板楼层结构 */
function hsrFloors(modeKey, detail, monDb) {
  const stages = detail.Stages || {}
  const floors = []
  // 一列 = 某个 stage 的怪，按波次分组；半边不存在时给空壳
  const sideOf = (half) => {
    if (!half) return { list: [], groups: [] }
    let list = bossOnlyWeak(hsrMonstersFromStage(stages[String(half.StageID)], monDb))
    // 源站偶尔不给 Weak（末日的「蛊言妄念的蚀心兽」就是空数组），
    // 单怪列直接回落到该列推荐元素 —— 两者本来就该一致。
    const elems = (half.Elem || []).map((x) => ELEM_CN[x] || x)
    if (list.length === 1 && !(list[0].weak || []).length && elems.length) {
      list = [{ ...list[0], weak: elems }]
    }
    return { list, groups: groupByWave(list) }
  }

  const push = (floorNo, label, sides, extra = {}) => {
    const halves = sides.filter(Boolean)
    if (!halves.length) return
    floors.push({
      index: floors.length + 1,
      floorNo,
      floorLabel: label,
      name: label,
      group: detail.Buff?.Name || '',
      desc: extra.desc || '',
      countdown: 0,
      challenges: [],
      type1: elemTags(halves[0]?.Elem),
      type2: elemTags(halves[1]?.Elem),
      typeStar: elemTags(halves[2]?.Elem),
      left: sideOf(halves[0]).list,
      leftGroups: sideOf(halves[0]).groups,
      right: sideOf(halves[1]).list,
      rightGroups: sideOf(halves[1]).groups,
      star: sideOf(halves[2]).list,
      starGroups: sideOf(halves[2]).groups,
      hasSides: true,
      hasStar: halves.length > 2,
      hasTypes: true,
    })
  }

  for (const f of detail.Floors || []) {
    const sides = (f.Stages || []).slice().sort((a, b) => Number(a.Half) - Number(b.Half))
    push(f.Floor, `第 ${f.Floor} 层`, sides)
  }
  return floors
}

/** 赛季效果 / 增益分组 */
function hsrSeasonEffects(modeKey, detail) {
  const groups = []
  const flatten = (obj) => {
    if (!obj) return []
    const list = Array.isArray(obj) ? obj : Object.values(obj).flat()
    return (Array.isArray(list) ? list : [])
      .map((b) => ({ name: aliothText(b?.Name || ''), desc: aliothText(b?.Desc || b?.Desc2 || '') }))
      .filter((b) => b.name || b.desc)
  }
  if (modeKey === 'fiction') {
    const skills = flatten(detail.Skills)
    if (skills.length) groups.push({ label: '周期加持', buffs: skills })
    const nb = flatten(detail.NewBuffs)
    if (nb.length) groups.push({ label: '通用增益', buffs: nb })
  } else if (modeKey === 'as') {
    const sk = flatten(detail.Skills)
    if (sk.length) groups.push({ label: '环境效果', buffs: sk })
    const tg = flatten(detail.Tags)
    if (tg.length) groups.push({ label: '首领特性', buffs: tg })
  } else if (modeKey === 'arbitration') {
    const bf = flatten(detail.Buffs)
    if (bf.length) groups.push({ label: '赛季增益', buffs: bf })
  }
  return groups.slice(0, 4)
}

/**
 * 异相仲裁专用结构
 *
 * 这个模式不是「楼层 + 上下半」，而是：王棋两关（绝境 + 普通）+ 骑士三关。
 * 站点把机制写在 KingTags / KnightTags 里，按 Index 与关卡对应。
 * 排版上：王棋整宽两张在上，骑士三宫格在下。
 */
const ARB_CN = ['一', '二', '三', '四', '五']

function arbPayload(detail, monDb) {
  const stages = detail.Stages || {}
  const tagsOf = (tags, s, i) => {
    const hit =
      (tags || []).find((t) => Number(t.Index) === Number(s.Index)) || (tags || [])[i]
    return (hit?.Tags || []).map((t) => aliothText(t.Name)).filter(Boolean)
  }
  const colOf = (s) => {
    const stage = stages[String(s.StageID)] || {}
    return {
      level: Number(stage.Level) || 0,
      elems: elemTags(s.Elem),
      monsters: bossOnlyWeak(hsrMonstersFromStage(stage, monDb)),
    }
  }

  // 王棋：血量/等级更高的那关是「绝境」，排前面
  const kings = (detail.King || [])
    .map((s, i) => ({ ...colOf(s), tags: tagsOf(detail.KingTags, s, i) }))
    .filter((x) => x.monsters.length)
  kings.sort((a, b) => b.level - a.level)
  kings.forEach((k, i) => {
    k.label = kings.length > 1 && i === 0 ? '王棋 · 绝境' : '王棋'
  })

  const knights = (detail.Knight || [])
    .map((s, i) => ({
      label: `骑士（${ARB_CN[i] || i + 1}）`,
      ...colOf(s),
      tags: tagsOf(detail.KnightTags, s, i),
    }))
    .filter((x) => x.monsters.length)

  return { bosses: kings, knights }
}

async function loadHsrEndgame(modeKey, pick) {
  const mode = HSR_MODES[modeKey] || HSR_MODES.chaos
  const raw = await fetchIndex(mode.key)
  const idx = mode.filter ? { ...raw, phases: raw.phases.filter(mode.filter) } : raw
  if (!idx.phases.length) throw new Error(`${mode.modeName} 期数数据为空`)
  const sel = resolvePick(idx, pick)
  const phase = sel.phase
  const detail = await fetchPhase(mode.key, phase._id)
  const monDb = detail.Monsters || {}

  const buff = detail.Buff || {}
  return {
    game: 'hsr',
    gameName: 'HONKAI STAR RAIL',
    mode: mode.key,
    modeName: mode.modeName,
    version: phase.Ver || '',
    channel: pick.channel,
    channelLabel: channelLabel(pick.channel),
    periodId: phase._id,
    title: phase.Name || buff.Name || `第 ${phase._id} 期`,
    timeRange: fmtRange(phase._begin, phase._end),
    buffTitle: aliothText(buff.Name || ''),
    buffDesc: aliothText(buff.Desc || ''),
    seasonEffects: hsrSeasonEffects(mode.key, detail),
    floors: modeKey === 'arbitration' ? [] : hsrFloors(modeKey, detail, monDb),
    arb: modeKey === 'arbitration' ? arbPayload(detail, monDb) : null,
    offset: sel.rel,
    total: sel.total,
    source: SOURCE,
    note: sel.note,
  }
}

// ---------------- 图片内嵌 ----------------

/** alioth 静态资源 → dataURI（缓存，失败返回空串） */
const ASSET_CACHE_MAX = 600
const assetCache = new Map()
async function assetToDataUri(url, { size = 64, fit = 'contain' } = {}) {
  if (!url) return ''
  const key = `${url}|${size}|${fit}`
  if (assetCache.has(key)) return assetCache.get(key)
  let uri = ''
  try {
    const buf = await fetchImageBuffer(url)
    if (buf) {
      const out = await sharp(buf)
        .resize(size, size, {
          fit,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          kernel: sharp.kernel.lanczos3,
        })
        .png({ compressionLevel: 9 })
        .toBuffer()
      uri = `data:image/png;base64,${out.toString('base64')}`
    }
  } catch (_) {
    uri = ''
  }
  // 长跑进程里不能无限涨：超了先丢最旧的
  if (assetCache.size >= ASSET_CACHE_MAX) {
    assetCache.delete(assetCache.keys().next().value)
  }
  assetCache.set(key, uri)
  return uri
}

/** 抓图（带 UA/Referer，失败返回 null） */
async function fetchImageBuffer(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: 'https://alioth.wiki/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length ? buf : null
  } catch (_) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 把数据里所有 icon 字段换成内嵌 dataURI（出图不吃外链） */
async function hydrateIcons(data) {
  const walk = async (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const x of node) await walk(x)
      return
    }
    if (typeof node.icon === 'string' && node.icon) {
      node.icon = await assetToDataUri(node.icon, { size: 96 })
    }
    for (const k of Object.keys(node)) {
      if (k === 'icon') continue
      const v = node[k]
      if (v && typeof v === 'object') await walk(v)
    }
  }
  await walk(data)
  return data
}


// ---------------- Plugin ----------------

/** 指令尾部：列表 / 上期 / 第N期 / 月份（202609、2026年9月、9月） */
const CMD_TAIL =
  '(?:列表|一览)?(?:上期|上一期|第\\d{1,3}期|20\\d{6}|20\\d{4}|20\\d{2}[-/.年]\\d{1,2}月?|\\d{1,2}月)?'

export class nanokaAbyss extends plugin {
  constructor() {
    super({
      name: '[小火花]版本深渊',
      dsc: '原神/星铁版本深渊与挑战查询（Alioth.wiki）',
      event: 'message',
      priority: (cfg().abyss_priority ?? -98) + 1,
      rule: [
        {
          // #版本深渊=当期；#下期深渊=下一期；可接 列表 / 上期 / 第N期 / 9月
          reg: `^\\s*#?(?:下期深渊|下期螺旋|版本深渊|版本螺旋|螺旋版本|深渊版本)${CMD_TAIL}\\s*$`,
          fnc: 'giTower',
        },
        {
          reg: `^\\s*#?(?:下期剧诗|版本剧诗|剧诗版本)${CMD_TAIL}\\s*$`,
          fnc: 'giTheater',
        },
        {
          reg: `^\\s*#?(?:下期危战|版本危战|危战版本)${CMD_TAIL}\\s*$`,
          fnc: 'giHard',
        },
        {
          // 框架会把 * / 星铁 前缀标准化为「#星铁…」
          reg: `^\\s*(?:#|\\*)?(?:\\*|星铁|#\\*|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+(?:下期深渊|下期挑战|下期混沌|下期虚构|下期末日|下期异相|版本深渊|版本挑战|版本混沌|版本虚构|版本末日|版本异相|版本记忆|下期记忆)${CMD_TAIL}\\s*$`,
          fnc: 'hsrMaze',
        },
      ],
    })
  }

  async giTower(e) {
    const msg = e.msg || ''
    const pick = parsePick(msg)
    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods('abyss', pick.channel)
        return e.reply(
          `深境螺旋（${channelLabel(pick.channel)}）最近期数：\n${lines.join('\n')}\n——\n#版本深渊=当期 · #下期深渊=下一期`,
          true,
        )
      } catch (err) {
        logger?.error?.('[xhh-TL][版本深渊] 列表失败', err)
        return e.reply('获取列表失败，请稍后重试', quoteEnabled())
      }
    }
    return this.renderMode(e, () => loadGiTower(pick), 'gi-tower')
  }

  async giTheater(e) {
    const msg = e.msg || ''
    const pick = parsePick(msg)
    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods('theater', pick.channel)
        return e.reply(
          `幻想真境剧诗（${channelLabel(pick.channel)}）最近期数：\n${lines.join('\n')}\n——\n#版本剧诗=当期 · #下期剧诗=下一期`,
          true,
        )
      } catch (err) {
        logger?.error?.('[xhh-TL][版本剧诗] 列表失败', err)
        return e.reply('获取列表失败，请稍后重试', quoteEnabled())
      }
    }
    return this.renderMode(e, () => loadGiRoleCombat(pick), 'gi-theater')
  }

  async giHard(e) {
    const msg = e.msg || ''
    const pick = parsePick(msg)
    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods('stygian', pick.channel)
        return e.reply(
          `幽境危战（${channelLabel(pick.channel)}）最近期数：\n${lines.join('\n')}\n——\n#版本危战=当期 · #下期危战=下一期`,
          true,
        )
      } catch (err) {
        logger?.error?.('[xhh-TL][版本危战] 列表失败', err)
        return e.reply('获取列表失败，请稍后重试', quoteEnabled())
      }
    }
    return this.renderMode(e, () => loadGiLeyline(pick), 'gi-leyline', {
      tpl: 'leyline_luna',
      progress: '正在拉取幽境危战数据…',
      baseScale: 1.3,
    })
  }

  async hsrMaze(e) {
    const msg = e.msg || ''
    const pick = parsePick(msg)
    let modeKey = 'chaos'
    if (/虚构/.test(msg)) modeKey = 'fiction'
    else if (/末日|幻影/.test(msg)) modeKey = 'as'
    else if (/异相|仲裁|peak/i.test(msg)) modeKey = 'arbitration'
    else if (/记忆紊流|版本记忆|下期记忆/.test(msg)) modeKey = 'memory'
    else if (/混沌|深渊|挑战/.test(msg)) modeKey = 'chaos'

    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods(HSR_MODES[modeKey].key, pick.channel, HSR_MODES[modeKey].filter)
        return e.reply(
          `${HSR_MODES[modeKey].modeName}（${channelLabel(pick.channel)}）最近期数：\n${lines.join('\n')}`,
          true,
        )
      } catch (err) {
        logger?.error?.('[xhh-TL][版本深渊] 星铁列表失败', err)
        return e.reply('获取列表失败，请稍后重试', quoteEnabled())
      }
    }
    return this.renderMode(e, () => loadHsrEndgame(modeKey, pick), `hsr-${modeKey}`)
  }

  async renderMode(e, loader, saveId, opts = {}) {
    const tpl = opts.tpl || 'nanoka_abyss'
    await replyProgress(e, opts.progress || '正在拉取版本数据…')
    let data
    try {
      data = this.trimPayload(await loader())
      data = await hydrateIcons(data)
    } catch (err) {
      logger?.error?.('[xhh-TL][版本深渊]', err)
      return e.reply('数据获取失败，请稍后重试', quoteEnabled())
    }

    try {
      if (!e.runtime?.render) {
        return e.reply('出图服务不可用，请稍后重试', quoteEnabled())
      }
      const buf = await this.renderToBuffer(
        e,
        {
          ...data,
          generatedAt: moment().format('YYYY-MM-DD HH:mm'),
          saveId,
        },
        saveId,
        { tpl, baseScale: opts.baseScale },
      )
      return this.sendImage(e, buf)
    } catch (err) {
      logger?.error?.('[xhh-TL][版本深渊] render', err)
      return e.reply('渲染失败，请稍后重试', quoteEnabled())
    }
  }

  /**
   * 截断过长内容，避免超长图导致 NTQQ rich media transfer failed
   */
  trimPayload(data) {
    const out = { ...data }

    // 原神深渊：只出 11 / 12 层，从高到低
    if (Array.isArray(out.floors) && out.game === 'gi' && out.mode === 'tower') {
      const keep = out.floors.filter((f) => TOWER_KEEP_FLOORS.includes(Number(f.id)))
      out.floors = (keep.length ? keep : out.floors)
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
    }

    // 星铁：层号高→低，最多 4 块
    if (Array.isArray(out.floors) && out.game === 'hsr') {
      out.floors = out.floors
        .slice()
        .sort((a, b) => (b.floorNo || 0) - (a.floorNo || 0))
        .slice(0, 4)
        .map((f) => ({
          ...f,
          hasTypes: !!(f.type1?.length || f.type2?.length),
          hasSides: !!(f.left?.length || f.right?.length),
          hasStar: !!(f.hasStar || (f.star && f.star.length)),
        }))
    }

    if (Array.isArray(out.floors)) {
      out.floors = out.floors.map((f) => ({
        ...f,
        hasTypes: !!(f.type1?.length || f.type2?.length),
        hasSides: !!(f.left?.length || f.right?.length),
        desc: f.desc && f.desc.length > 180 ? `${f.desc.slice(0, 180)}…` : f.desc,
        challenges: (f.challenges || []).slice(0, 3),
      }))
    }

    // 剧诗：最多 8 块关键关卡
    if (Array.isArray(out.stages) && out.stages.length > 8) {
      out.stages = out.stages.slice(0, 8)
    }
    if (Array.isArray(out.stages)) {
      out.stages = out.stages.map((s) => ({
        ...s,
        desc: s.desc && s.desc.length > 320 ? `${s.desc.slice(0, 320)}…` : s.desc,
      }))
    }

    // 危战：压机制描述长度，避免图过高
    if (out.mode === 'leyline' && Array.isArray(out.bosses)) {
      out.bosses = out.bosses.map((b) => ({
        ...b,
        mechanics: (b.mechanics || []).map((m) => {
          const plain = String(m.descHtml || '').replace(/<[^>]+>/g, '')
          if (plain.length > 300) {
            return { ...m, descHtml: aliothRich(plain.slice(0, 300) + '…') }
          }
          return m
        }),
      }))
    }

    if (out.buffDesc && out.buffDesc.length > 280) {
      out.buffDesc = `${out.buffDesc.slice(0, 280)}…`
    }

    // 赛季效果：限制分组数与每组条目
    if (Array.isArray(out.seasonEffects)) {
      out.seasonEffects = out.seasonEffects
        .slice(0, 4)
        .map((g) => ({
          label: g.label,
          buffs: (g.buffs || []).slice(0, 4).map((b) => ({
            name: b.name,
            desc: b.desc && b.desc.length > 180 ? `${b.desc.slice(0, 180)}…` : b.desc,
          })),
        }))
        .filter((g) => g.buffs.length)
    }
    return out
  }

  async renderToBuffer(e, data, saveId, opts = {}) {
    const tpl = opts.tpl || 'nanoka_abyss'
    // reply:false → 拿 webp buffer，回复逻辑仍走本类 sendImage（含 jpeg 兜底）
    return renderTpl(e, {
      tpl,
      tplFile: path.join(pluginDir, `resources/${tpl}/${tpl}.html`),
      data,
      baseScale: opts.baseScale ?? 1.6,
      rem: true,
      saveId,
      reply: false,
    })
  }

  async sendImage(e, buf) {
    if (!buf) return replyQuote(e, '渲染失败，请稍后重试')
    // 单图引用触发消息
    try {
      return await replyQuote(e, segment.image(buf))
    } catch (err) {
      logger?.warn?.(`[xhh-TL][版本深渊] send fail, retry: ${err.message}`)
      try {
        const fallback = await sharp(buf)
          .jpeg({ quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true })
          .toBuffer()
        return await replyQuote(e, segment.image(fallback))
      } catch (err2) {
        return e.reply(`发图失败，请稍后重试`)
      }
    }
  }
}

// 关掉 nanoka_abyss_enable 后，#版本深渊 / #版本剧诗 / #版本危战 与
// *版本混沌 / *版本虚构 / *版本末日 / *版本异相 等全部不再响应
guardModule(nanokaAbyss, 'nanoka', ['giTower', 'giTheater', 'giHard', 'hsrMaze'])

export default nanokaAbyss
