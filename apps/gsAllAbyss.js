/**
 * 原神 #全部深渊
 * 合并：深境螺旋 + 幽境危战 + 小剧诗关键关（3/6/8/10 + 圣牌）
 * 渲染风格对齐体力插件（Tl 毛玻璃）
 *
 * 命令：#全部深渊 / #全部深渊上期 / #上期全部深渊 / #原神全部深渊
 */

import moment from 'moment'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import lodash from 'lodash'
import { Character, MysApi, Player, HardChallenge } from '../../miao-plugin/models/index.js'
import { prepareMysContext } from '../utils/runtimePatch.js'
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'

const pluginDir = process.cwd() + '/plugins/xhh-TL'
const configPath = path.join(pluginDir, 'config', 'config.yaml') /* user config */
const miaoRes = process.cwd() + '/plugins/miao-plugin/resources'
let _configCache = null

function readConfig() {
  return readPluginConfig()
}

function config() {
  if (!_configCache) _configCache = readConfig()
  return _configCache
}

try {
  if (fs.existsSync(configPath)) {
    fs.watch(configPath, () => { _configCache = readConfig() })
  }
} catch (_) {}

function getVal(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function faceUrl(face) {
  if (!face) return ''
  if (/^https?:\/\//i.test(face) || face.startsWith('file://') || face.startsWith('base64://')) return face
  const rel = face.startsWith('/') ? face : `/${face}`
  return `file://${miaoRes}${rel}`
}

function resolveById(id, avatarDataMap = {}, extra = {}) {
  const sid = String(id)
  const own = avatarDataMap[sid] || avatarDataMap[Number(sid)] || {}
  // 优先接口/面板全名，避免 abbr 过短或奇怪（如哥伦比娅→少女）
  let name = extra.name || own.name || own.abbr || sid
  let face = own.face || own.qFace || ''
  let star = own.star || extra.rarity || 4
  let level = extra.level || own.level || 0
  let elem = own.elem || ''
  let cons = extra.cons ?? own.cons
  if (sid) {
    try {
      const char = Character.get(Number(sid))
      if (char) {
        // 全名优先；仅当没有中文全名时才用 abbr
        if (!name || name === sid || /^\d+$/.test(name)) {
          name = char.name || char.abbr || name
        } else if (name === char.abbr && char.name) {
          // 已是简称则升为全名，保证「丝柯克」「哥伦比娅」完整
          name = char.name
        }
        face = face || char.face || char.qFace || ''
        star = char.star || star
        elem = char.elem || elem
      }
    } catch (_) {}
  }
  // 仍是面板 abbr 且能拿到全名
  if (own.name && own.name.length >= (name?.length || 0)) name = own.name

  // 武器：米游社 detail / 面板均可能有
  let weapon = null
  const ow = own.weapon || {}
  if (ow.name || ow.id || ow.img) {
    let wImg = ow.img || ow.icon || ow.imgs?.icon || ''
    weapon = {
      name: ow.name || ow.abbr || '',
      abbr: ow.abbr || ow.name || '',
      level: ow.level,
      affix: ow.affix,
      star: ow.star,
      img: faceUrl(wImg),
    }
  }

  // 圣遗物套装
  let artis = null
  const set = own.artisSet
  if (set && (set.name || set.sName || (Array.isArray(set.names) && set.names.length) || (Array.isArray(set.imgs) && set.imgs.length))) {
    const names = set.names || []
    const imgs = (set.imgs || []).filter(Boolean).slice(0, 2).map(u => faceUrl(u))
    artis = {
      name: set.sName || set.name || names.join('+') || '',
      names,
      imgs,
    }
  }

  // 热度 UP（危战赋光）
  const isUp = !!(own.is_popularity || extra.is_popularity)

  return {
    id: sid,
    name,
    face: faceUrl(face),
    star,
    level,
    elem,
    cons: cons == null || cons === '' ? 0 : cons,
    typeLabel: extra.typeLabel || '',
    weapon,
    artis,
    isUp,
    talent: {
      a: own.talent?.a?.level ?? own.talent?.a?.original ?? '',
      e: own.talent?.e?.level ?? own.talent?.e?.original ?? '',
      q: own.talent?.q?.level ?? own.talent?.q?.original ?? '',
    },
  }
}

/** 去掉 HTML 色标，压成短词条 */
function cleanDescList(list, max = 8) {
  if (!Array.isArray(list)) return []
  return list
    .map(d => String(d || '')
      .replace(/\\n/g, ' ')
      .replace(/\/n/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    // 不截断单条长度，机制全文展示
    .slice(0, max)
}

function intToRoman(num) {
  if (num < 1 || num > 3999) return String(num)
  const thousands = ['', 'M', 'MM', 'MMM']
  const hundreds = ['', 'C', 'CC', 'CCC', 'CD', 'D', 'DC', 'DCC', 'DCCC', 'CM']
  const tens = ['', 'X', 'XX', 'XXX', 'XL', 'L', 'LX', 'LXX', 'LXXX', 'XC']
  const ones = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']
  return (
    thousands[Math.floor(num / 1000)] +
    hundreds[Math.floor((num % 1000) / 100)] +
    tens[Math.floor((num % 100) / 10)] +
    ones[num % 10]
  )
}

function isKeyRound(round) {
  if (!round) return false
  if (round.is_tarot) return true
  return [3, 6, 8, 10].includes(Number(round.round_id))
}

function pickBgImage() {
  const bgFolder = config().role_combat_bg_folder
  if (!bgFolder) return ''
  try {
    const abs = path.isAbsolute(bgFolder) ? bgFolder : path.join(pluginDir, bgFolder)
    if (!fs.existsSync(abs)) return ''
    const gsNames = new Set()
    try {
      Character.forEach(char => {
        if (char?.game === 'gs' && char.name) gsNames.add(char.name)
        return true
      }, 'release', 'gs')
    } catch (_) {}
    const collect = (onlyGs) => {
      const imgs = []
      for (const item of fs.readdirSync(abs)) {
        const full = path.join(abs, item)
        if (!fs.statSync(full).isDirectory()) continue
        if (onlyGs && gsNames.size && !gsNames.has(item)) continue
        for (const f of fs.readdirSync(full).filter(x => /\.(jpg|jpeg|png|webp)$/i.test(x))) {
          imgs.push(path.join(full, f))
        }
      }
      return imgs
    }
    let imgs = collect(true)
    if (!imgs.length) imgs = collect(false)
    if (!imgs.length) return ''
    return `file://${imgs[Math.floor(Math.random() * imgs.length)]}`
  } catch (err) {
    logger.error('[xhh][gsAllAbyss] 背景图失败:', err)
    return ''
  }
}

/** 深境螺旋：图二布局（大卡 8 人 + 三间小头像），风格仍用体力卡片 */
function buildAbyssSection(resAbyss, avatarDataMap, { showAllHigh = true } = {}) {
  if (!resAbyss || !Array.isArray(resAbyss.floors) || !resAbyss.floors.length) {
    return { ok: false, reason: '无深渊数据' }
  }
  let floors = resAbyss.floors.slice()
  const high = floors.filter(f => Number(f.index) >= 9)
  if (high.length) {
    if (showAllHigh) floors = high
    else floors = [high.reduce((a, b) => (Number(a.index) >= Number(b.index) ? a : b))]
  }
  // 12 层在上、11 层在下（层数从高到低）
  floors = floors.sort((a, b) => Number(b.index) - Number(a.index))

  const floorList = floors.map(floor => {
    const levels = (floor.levels || []).map(level => {
      const battles = (level.battles || []).map(battle => {
        const side = Number(battle.index) === 1 ? '上半' : '下半'
        const avatars = (battle.avatars || []).map(a =>
          resolveById(a.id || a.avatar_id, avatarDataMap, {
            level: a.level,
            rarity: a.rarity,
            name: a.name,
          }),
        )
        let time = ''
        if (battle.timestamp) {
          time = moment(new Date(Number(battle.timestamp) * 1000)).format('MM-DD HH:mm')
        }
        return { side, avatars, time }
      })
      const up = battles.find(b => b.side === '上半') || battles[0] || null
      const down = battles.find(b => b.side === '下半') || battles[1] || null
      return {
        index: level.index,
        star: level.star ?? 0,
        up,
        down,
        time: up?.time || down?.time || '',
        battles,
      }
    })

    // 展示用大卡队伍：优先用最后一间上下半（通常满配），凑满 8 人一排
    const lastLv = levels[levels.length - 1] || levels[0]
    const lineup = [
      ...((lastLv?.up?.avatars) || []),
      ...((lastLv?.down?.avatars) || []),
    ]

    return {
      index: floor.index,
      star: floor.star ?? 0,
      max_star: floor.max_star ?? 9,
      levels,
      lineup,
    }
  })

  // 深渊战绩条（米游社 rank）
  const fmtVal = (key, v) => {
    if (v == null || v === '') return '-'
    if (['dmg', 'takeDmg', 'damage', 'take_damage'].includes(key) || key === 'dmg' || key === 'takeDmg') {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return n >= 10000 ? `${(n / 10000).toFixed(1)} W` : String(n)
    }
    return `${v}次`
  }
  const pickRank = (arr, key) => {
    const row = Array.isArray(arr) && arr[0] ? arr[0] : null
    if (!row) return null
    const id = row.avatar_id || row.id
    const av = resolveById(id, avatarDataMap, { name: row.avatar_name || row.name })
    return {
      id,
      title: key,
      value: fmtVal(key, row.value),
      avatar: av,
    }
  }
  const stats = [
    { key: 'dmg', title: '最强一击', raw: resAbyss.damage_rank },
    { key: 'takeDmg', title: '最高承伤', raw: resAbyss.take_damage_rank },
    { key: 'defeat', title: '最多击破', raw: resAbyss.defeat_rank },
    { key: 'e', title: '元素战技', raw: resAbyss.normal_skill_rank },
    { key: 'q', title: '元素爆发', raw: resAbyss.energy_skill_rank },
  ].map(s => {
    const r = pickRank(s.raw, s.key)
    return r ? { ...r, title: s.title } : null
  }).filter(s => s && s.avatar?.face) // 无头像的空格不展示，减少留白


  return {
    ok: true,
    schedule: resAbyss.start_time
      ? moment(new Date(Number(resAbyss.start_time) * 1000)).format('M') + '月'
      : (resAbyss.schedule_id ? String(resAbyss.schedule_id) : ''),
    maxFloor: resAbyss.max_floor || '-',
    totalBattle: resAbyss.total_battle_times ?? '-',
    totalStar: resAbyss.total_star ?? floorList.reduce((s, f) => s + (Number(f.star) || 0), 0),
    floors: floorList,
    stats,
    onlyTop: !showAllHigh,
  }
}

/** 幽境危战：最佳记录 */
function buildHardSection(lvs, popularityList, avatarDataMap) {
  if (!lvs) return { ok: false, reason: '无危战数据' }

  function score(data) {
    if (data?.has_data) return data.best.difficulty * 1000 - data.best.second
    return 0
  }
  // 取 single / mp 更优
  const singleScore = score(lvs.single)
  const mpScore = score(lvs.mp)
  if (singleScore >= mpScore && lvs.single?.has_data) lvs.best = lvs.single
  else if (lvs.mp?.has_data) lvs.best = lvs.mp
  else if (lvs.single?.has_data) lvs.best = lvs.single
  else return { ok: false, reason: '无危战通关' }

  if (!lvs.best?.has_data) return { ok: false, reason: '无危战通关' }

  let hc
  try {
    hc = new HardChallenge(lvs, popularityList || [])
  } catch (err) {
    logger.error('[xhh][gsAllAbyss] HardChallenge 解析失败:', err)
    return { ok: false, reason: '危战解析失败' }
  }
  const data = hc.getData()
  // 合并假角色 + 赋光 UP
  let map = { ...avatarDataMap }
  try {
    map = hc.addFakeCharacters(map) || map
  } catch (_) {}
  try {
    if (typeof hc.applyPopularity === 'function') {
      map = hc.applyPopularity(map) || map
    }
  } catch (_) {}

  const challs = (data.challs || []).map(ch => {
    const avatars = (ch.avatars || []).map(a => {
      const av = resolveById(a.avatar_id, map, {
        level: a.level,
        name: a.name, // 接口全名优先
        cons: a.rank,
      })
      // UP 标记
      const mid = map[String(a.avatar_id)] || map[a.avatar_id]
      if (mid?.is_popularity) av.isUp = true
      return av
    })
    const m = ch.monster || {}
    // 完整机制文案（去 HTML 色标，保留多条）
    const descs = cleanDescList(
      Array.isArray(m.desc) ? m.desc : (m.desc ? [m.desc] : []),
      10,
    )
    // best dps
    const best = (ch.best_avatars || []).map((b, i) => {
      const av = resolveById(b.avatar_id, map)
      return {
        title: i === 0 ? '最强一击' : '最高总伤害',
        dps: b.dps,
        avatar: av,
      }
    })
    return {
      name: ch.name,
      second: ch.second,
      monster: {
        name: m.name || ch.name || '未知',
        level: m.level || '',
        icon: m.icon || '',
        descs,
      },
      avatars,
      best,
    }
  })

  const diffMap = { 1: '普通', 2: '进阶', 3: '困难', 4: '险恶', 5: '无畏', 6: '绝境' }
  return {
    ok: true,
    difficulty: data.best?.difficulty,
    difficultyName: diffMap[data.best?.difficulty] || String(data.best?.difficulty || '-'),
    second: data.best?.second ?? '-',
    start_time: data.start_time,
    end_time: data.end_time,
    challs,
  }
}

/** 小剧诗关键关 */
function buildRoleSection(lvs, avatarDataMap) {
  if (!lvs?.has_detail_data) return { ok: false, reason: '无剧诗数据' }
  const rounds = lvs.detail?.rounds_data || []
  const stages = []
  for (const round of rounds) {
    if (!isKeyRound(round)) continue
    const isTarot = !!round.is_tarot
    const roundId = Number(round.round_id)
    const tarotNo = Number(round.tarot_serial_no || 0)
    const title = isTarot
      ? `圣牌挑战 ${intToRoman(tarotNo || 1)}`
      : `第 ${roundId} 幕`
    const avatars = (round.avatars || []).map(a => {
      const type = Number(a.avatar_type || 1)
      return resolveById(a.avatar_id, avatarDataMap, {
        level: a.level,
        name: a.name,
        typeLabel: { 1: '', 2: '试用', 3: '助演' }[type] || '',
      })
    })
    const enemies = (round.enemies || []).map(en => ({
      name: en.name || '未知',
      level: en.level || '',
      icon: en.icon || '',
    }))
    let finishTime = ''
    if (round.finish_time) {
      finishTime = moment(new Date(Number(round.finish_time) * 1000)).format('MM-DD HH:mm')
    }
    stages.push({
      key: isTarot ? `t${tarotNo}` : `r${roundId}`,
      title,
      kind: isTarot ? 'tarot' : 'room',
      is_get_medal: !!round.is_get_medal,
      finish_time: finishTime,
      avatars,
      enemies,
    })
  }
  const roomOrder = { 3: 1, 6: 2, 8: 3, 10: 4 }
  stages.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'room' ? -1 : 1
    if (a.kind === 'room') {
      return (roomOrder[Number(a.key.slice(1))] || 99) - (roomOrder[Number(b.key.slice(1))] || 99)
    }
    return a.key.localeCompare(b.key)
  })
  if (!stages.length) return { ok: false, reason: '未打关键关' }

  const stat = lvs.stat || {}
  const difficultyMap = { 1: '简单', 2: '普通', 3: '困难', 4: '卓越', 5: '月谕' }
  return {
    ok: true,
    month: lvs.schedule?.start_date_time?.month || '-',
    difficultyName: difficultyMap[stat.difficulty_id] || '-',
    totalTime: lvs.detail?.fight_statisic?.total_use_time ?? stat.total_use_time ?? '-',
    coin: stat.coin_num ?? '-',
    stages,
  }
}

function collectAvatarIds(...idLists) {
  const set = new Set()
  for (const list of idLists) {
    for (const id of list || []) if (id) set.add(String(id))
  }
  return [...set]
}

export class gsAllAbyss extends plugin {
  constructor() {
    super({
      name: '[小花火]原神全部深渊',
      dsc: '原神深渊+危战+小剧诗三合一',
      event: 'message',
      // 高于星铁 *全部深渊，优先吃掉 #全部深渊
      priority: config().gs_all_abyss_priority ?? -99,
      rule: [
        {
          // #全部深渊 / #全部深渊上期 / #全部深渊 全层 / #全部深渊 9-12
          reg: '^#*(原神)?(上期)?全部深渊(上期)?(.*)？?$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().gs_all_abyss === false) return false
    // 星铁指令留给 *全部深渊，这里只处理带 # 或「原神」或纯「全部深渊」文本
    const raw = e.original_msg || e.msg || ''
    // 若明显是星铁语境且无 #，交给其他插件（兼容 *全部深渊）
    if (/^\*/.test(raw.trim()) || /星铁|混沌|虚构|末日|异相/.test(raw)) return false

    const isCurrent = !(/上期/.test(raw))
    const periodText = isCurrent ? '本期' : '上期'

    await e.reply(`正在获取${periodText}原神全部深渊…`, true)

    await prepareMysContext(e, 'gs')
    const mys = await MysApi.init(e, 'cookie')
    if (!mys || !await mys.checkCk()) {
      return e.reply(
        mys
          ? `UID: ${mys.uid} Cookie 失效，请重新登录或【#刷新ck】`
          : '请绑定 Cookie 后再使用 #全部深渊',
      )
    }
    const uid = mys.uid
    const player = Player.create(e)

    // 并行拉三类数据 + 角色列表
    let resAbyss, resHard, resHardPop, resRole, resDetail
    try {
      ;[resAbyss, resHard, resHardPop, resRole, resDetail] = await Promise.all([
        mys.getSpiralAbyss(isCurrent ? 1 : 2).catch(err => {
          logger.error('[xhh][gsAllAbyss] 深渊失败:', err)
          return null
        }),
        mys.getHardChallenge().catch(err => {
          logger.error('[xhh][gsAllAbyss] 危战失败:', err)
          return null
        }),
        mys.getHardChallengePopularity().catch(() => null),
        mys.getRoleCombat(true).catch(err => {
          logger.error('[xhh][gsAllAbyss] 剧诗失败:', err)
          return null
        }),
        mys.getCharacter().catch(() => null),
      ])
    } catch (err) {
      logger.error('[xhh][gsAllAbyss] 拉取失败:', err)
      return e.reply(`获取失败：${err?.message || err}`)
    }

    if (resDetail?.avatars?.length > 3) {
      try {
        delete resDetail._res
        player.setMysCharData(resDetail)
      } catch (_) {}
    }

    const hardLvs = getVal(resHard, isCurrent ? 'data.0' : 'data.1')
    const roleLvs = getVal(resRole, isCurrent ? 'data.0' : 'data.1')
    // 默认全层；#全部深渊 最高层 → 仅最高层
    const onlyTop = /最高层|仅最高|只最高/.test(raw)
    const showAllHigh = !onlyTop

    // 收集角色 id，统一取面板（含圣遗物套装需要 detail）
    const abyssIds = []
    if (resAbyss?.floors) {
      for (const f of resAbyss.floors) {
        for (const lv of f.levels || []) {
          for (const b of lv.battles || []) {
            for (const a of b.avatars || []) abyssIds.push(a.id || a.avatar_id)
          }
        }
      }
    }
    const hardIds = []
    if (hardLvs?.best?.challenge || hardLvs?.single?.best?.challenge || hardLvs?.mp?.best?.challenge) {
      const pickChalls = (node) => {
        for (const c of node?.challenge || node?.best?.challenge || []) {
          for (const t of c.teams || []) hardIds.push(t.avatar_id)
        }
      }
      pickChalls(hardLvs.single)
      pickChalls(hardLvs.mp)
      pickChalls(hardLvs.best)
    }
    const roleIds = []
    for (const r of roleLvs?.detail?.rounds_data || []) {
      if (!isKeyRound(r)) continue
      for (const a of r.avatars || []) {
        if (Number(a.avatar_type) === 1) roleIds.push(a.avatar_id)
      }
    }

    const allIds = collectAvatarIds(abyssIds, hardIds, roleIds)
    let avatarDataMap = {}
    try {
      // 先刷 mys 角色详情（含武器/圣遗物 mysArtis），再取 getDetail
      if (allIds.length) {
        try {
          // detail: 强制刷新 mys 详情；talent 天赋
          await player.refresh({
            detail: 1,
            talent: 1,
            ids: allIds,
          })
        } catch (err) {
          logger.debug('[xhh][gsAllAbyss] refresh detail 失败:', err?.message)
          try { await player.refreshTalent(allIds) } catch (_) {}
        }
      }

      // 优先用 refreshAndGetAvatarData 组装（含 artisSet）
      try {
        const ret = await player.refreshAndGetAvatarData({
          ids: allIds,
          detail: 0, // 刚刷过
          talent: 0,
          rank: false,
          materials: false,
          retType: 'object',
          sort: false,
        }, 'gs')
        if (ret && typeof ret === 'object') {
          for (const [k, v] of Object.entries(ret)) avatarDataMap[String(k)] = v
        }
      } catch (_) {
        const rawMap = player.getAvatarData(allIds) || {}
        if (Array.isArray(rawMap)) {
          for (const a of rawMap) avatarDataMap[String(a.id)] = a
        } else {
          for (const [k, v] of Object.entries(rawMap)) avatarDataMap[String(k)] = v
        }
      }

      // 补：对 map 里仍无 artisSet 的角色，从 Avatar 实例再取一次
      for (const id of allIds) {
        const sid = String(id)
        const cur = avatarDataMap[sid]
        if (cur?.artisSet?.names?.length || cur?.artisSet?.imgs?.length) continue
        try {
          const av = player.getAvatar?.(id) || player.getAvatar?.(Number(id))
          if (!av) continue
          const ds = av.getDetail?.() || {}
          // getDetail 已含 artisSet getter
          if (!ds.face && av.char) {
            const imgs = av.char.getImgs?.(av.costume) || {}
            ds.face = imgs.face || imgs.qFace
          }
          avatarDataMap[sid] = { ...(cur || {}), ...ds }
        } catch (_) {}
      }
    } catch (err) {
      logger.debug('[xhh][gsAllAbyss] 角色面板失败:', err?.message)
    }

    const abyss = buildAbyssSection(resAbyss, avatarDataMap, { showAllHigh })
    const hard = buildHardSection(
      hardLvs,
      resHardPop?.avatar_list || resHardPop?.data?.avatar_list || [],
      avatarDataMap,
    )
    const role = buildRoleSection(roleLvs, avatarDataMap)

    if (!abyss.ok && !hard.ok && !role.ok) {
      return e.reply(`暂未获得${periodText}深渊 / 危战 / 剧诗数据…`)
    }

    const qq = e.user_id || e.sender?.user_id || ''
    const qqname = e.sender?.card || e.sender?.nickname || String(qq)
    const bgImage = pickBgImage()
    const renderScale = getRenderScaleStyle(config(), 2.0)
    const tplFile = pluginDir + '/resources/gs_all_abyss/gs_all_abyss.html'
    const ppath = '../../../../plugins/xhh-TL/resources/'

    const renderData = {
      periodText,
      uid,
      qq,
      qqname,
      bgImage,
      generatedAt: moment().format('MM-DD HH:mm'),
      abyss,
      hard,
      role,
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'gs_all_abyss', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            imgType: 'png',
            sys: { scale: renderScale },
            ...data,
            ppath,
            tplFile,
            saveId: 'gs_all_abyss',
            _miao_path: ppath,
          }
        },
      })
      const image = extractRenderBuffer(renderResult)
      if (!image) throw new Error('渲染结果中没有图片数据')
      return e.reply(segment.image(image), true)
    } catch (err) {
      logger.error('[xhh][gsAllAbyss] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
