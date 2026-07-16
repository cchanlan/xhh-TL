/**
 * 小剧诗：个人通关关键关卡（第 3/6/8/10 幕 + 双圣牌）
 * 米游社 #剧诗 通关数据 + 队伍角色，样式对齐体力插件
 * 命令：#小剧诗 / #小剧诗上期 / #小剧诗@某人
 */

import moment from 'moment'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import lodash from 'lodash'
import { Character, MysApi, Player } from '../../miao-plugin/models/index.js'
import { prepareMysContext } from '../utils/runtimePatch.js'
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'

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
    fs.watch(configPath, () => {
      _configCache = readConfig()
    })
  }
} catch (_) {}

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
  const id = Number(round.round_id)
  return [3, 6, 8, 10].includes(id)
}

function faceUrl(face) {
  if (!face) return ''
  if (/^https?:\/\//i.test(face) || face.startsWith('file://') || face.startsWith('base64://')) {
    return face
  }
  // miao 相对路径：/meta-gs/... 或 meta-gs/...
  const rel = face.startsWith('/') ? face : `/${face}`
  return `file://${miaoRes}${rel}`
}

function resolveAvatarCard(avatar, avatarDataMap = {}) {
  const id = String(avatar.avatar_id || avatar.id || '')
  const own = avatarDataMap[id] || avatarDataMap[Number(id)] || {}
  // 全名优先，避免奇怪 abbr
  let name = avatar.name || own.name || own.abbr || id
  let face = own.face || own.qFace || ''
  let star = own.star || 4
  let elem = own.elem || ''
  let level = avatar.level || own.level || 0
  let cons = own.cons
  const type = Number(avatar.avatar_type || 1)
  if (id) {
    try {
      const char = Character.get(Number(id)) || new Character({ id: Number(id), name: avatar.name })
      if (char) {
        if (!name || name === id || /^\d+$/.test(name)) name = char.name || char.abbr || name
        else if (name === char.abbr && char.name) name = char.name
        face = face || char.face || char.qFace || ''
        star = char.star || star
        elem = char.elem || elem
      }
    } catch (_) {}
  }
  if (own.name && own.name.length >= (name?.length || 0)) name = own.name

  let weapon = null
  const ow = own.weapon || {}
  if (ow.name || ow.id || ow.img) {
    weapon = {
      name: ow.name || ow.abbr || '',
      abbr: ow.abbr || ow.name || '',
      affix: ow.affix,
      img: faceUrl(ow.img || ow.icon || ow.imgs?.icon || ''),
    }
  }

  let artis = null
  const set = own.artisSet
  if (set && (set.name || set.sName || (Array.isArray(set.names) && set.names.length) || (Array.isArray(set.imgs) && set.imgs.length))) {
    artis = {
      name: set.sName || set.name || (set.names || []).join('+') || '',
      imgs: (set.imgs || []).filter(Boolean).slice(0, 2).map(u => faceUrl(u)),
    }
  }

  const typeLabel = { 1: '', 2: '试用', 3: '助演' }[type] || ''
  return {
    id,
    name,
    face: faceUrl(face),
    star,
    elem,
    level,
    cons: cons == null || cons === '' ? 0 : cons,
    type,
    typeLabel,
    weapon,
    artis,
    talent: {
      a: own.talent?.a?.level ?? own.talent?.a?.original ?? '',
      e: own.talent?.e?.level ?? own.talent?.e?.original ?? '',
      q: own.talent?.q?.level ?? own.talent?.q?.original ?? '',
    },
  }
}

/**
 * 从米游社 detail 抽出关键关卡
 */
function buildKeyStages(lvs, avatarDataMap) {
  const rounds = lvs?.detail?.rounds_data || []
  const stages = []

  for (const round of rounds) {
    if (!isKeyRound(round)) continue

    const isTarot = !!round.is_tarot
    const roundId = Number(round.round_id)
    const tarotNo = Number(round.tarot_serial_no || 0)
    const title = isTarot
      ? `圣牌挑战 ${intToRoman(tarotNo || 1)}`
      : `第 ${roundId} 幕`
    // 不再显示「幕 3 / 圣牌 I」等角标，只保留完整标题
    const tag = ''
    const showTag = false

    const avatars = (round.avatars || []).map(a => resolveAvatarCard(a, avatarDataMap))
    const enemies = (round.enemies || []).map(en => ({
      name: en.name || en.Name || '未知',
      level: en.level || en.Level || '',
      icon: en.icon || en.Icon || '',
    }))

    let finishTime = ''
    if (round.finish_time) {
      finishTime = moment(new Date(Number(round.finish_time) * 1000)).format('MM-DD HH:mm')
    }

    stages.push({
      key: isTarot ? `tarot-${tarotNo || stages.length}` : `r-${roundId}`,
      title,
      tag,
      showTag,
      kind: isTarot ? 'tarot' : 'room',
      is_get_medal: !!round.is_get_medal,
      finish_time: finishTime,
      avatars,
      enemies,
      enemyNames: enemies.map(x => x.name).join(' / '),
    })
  }

  // 稳定排序：幕 3/6/8/10 再圣牌
  const roomOrder = { 3: 1, 6: 2, 8: 3, 10: 4 }
  stages.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'room' ? -1 : 1
    if (a.kind === 'room') {
      const ra = Number(a.key.replace('r-', ''))
      const rb = Number(b.key.replace('r-', ''))
      return (roomOrder[ra] || 99) - (roomOrder[rb] || 99)
    }
    return a.key.localeCompare(b.key)
  })

  return stages
}

/**
 * 与 #幻想角色（role_combat.js）同一套：config.role_combat_bg_folder
 * 只取原神角色子文件夹里的图片；过滤后为空则回退扫全部子目录
 */
function pickBgImage() {
  const bgFolder = config().role_combat_bg_folder
  if (!bgFolder) {
    logger.warn('[xhh][miniRoleCombat] 未配置 role_combat_bg_folder，无背景图')
    return ''
  }
  try {
    const absBgFolder = path.isAbsolute(bgFolder)
      ? bgFolder
      : path.join(pluginDir, bgFolder)
    if (!fs.existsSync(absBgFolder)) {
      logger.warn(`[xhh][miniRoleCombat] 背景目录不存在: ${absBgFolder}`)
      return ''
    }

    // 与 role_combat.js 一致：收集原神角色名
    const gsNames = new Set()
    try {
      Character.forEach(char => {
        if (char?.game === 'gs' && char.name) gsNames.add(char.name)
        return true
      }, 'release', 'gs')
    } catch (err) {
      logger.debug('[xhh][miniRoleCombat] Character 列表失败，将扫描全部子目录:', err?.message)
    }

    const collect = (onlyGs) => {
      const allImages = []
      for (const item of fs.readdirSync(absBgFolder)) {
        const fullPath = path.join(absBgFolder, item)
        if (!fs.statSync(fullPath).isDirectory()) continue
        if (onlyGs && gsNames.size > 0 && !gsNames.has(item)) continue
        const files = fs
          .readdirSync(fullPath)
          .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        for (const f of files) allImages.push(path.join(fullPath, f))
      }
      return allImages
    }

    let allImages = collect(true)
    // 过滤过严或 gsNames 为空时回退，避免背景空白
    if (!allImages.length) allImages = collect(false)
    if (!allImages.length) {
      logger.warn(`[xhh][miniRoleCombat] 背景目录无图片: ${absBgFolder}`)
      return ''
    }
    const randomFile = allImages[Math.floor(Math.random() * allImages.length)]
    return `file://${randomFile}`
  } catch (err) {
    logger.error('[xhh][miniRoleCombat] 加载背景图失败:', err)
    return ''
  }
}

function getVal(obj, pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export class miniRoleCombat extends plugin {
  constructor() {
    super({
      name: '[小花火]小剧诗',
      dsc: '幻想真境剧诗关键关卡通关速览',
      event: 'message',
      priority: -9998,
      rule: [
        {
          // #小剧诗 / #小幻想 / #小剧诗上期 / #上期小幻想
          reg: '^#*(上期)?小(剧诗|幻想)(上期)?$',
          fnc: 'mini',
        },
      ],
    })
  }

  async mini(e) {
    if (config().role_combat === false) return false

    const rawMsg = e.original_msg || e.msg || ''
    const isCurrent = !(/上期/.test(rawMsg))
    const periodText = isCurrent ? '本期' : '上期'

    // @ 他人
    let targetQq = null
    let targetName = null
    const selfId = e.self_id || (e.bot || Bot)?.uin
    for (const msg of e.message || []) {
      if (msg.type === 'at' && String(msg.qq) !== String(selfId)) {
        targetQq = msg.qq
        break
      }
    }
    if (targetQq) e.at = String(targetQq)

    if (targetQq && e.group) {
      try {
        const member = e.group.pickMember?.(targetQq)
        if (member?.card || member?.nickname) {
          targetName = member.card || member.nickname
        } else {
          const bot = e.bot || Bot
          const info = await bot.getGroupMemberInfo?.(String(e.group_id), String(targetQq))
          if (info?.card || info?.nickname) targetName = info.card || info.nickname
        }
      } catch (_) {}
      if (!targetName) targetName = String(targetQq)
    }

    await e.reply(`正在获取${periodText}小剧诗关键关卡…`, true)

    await prepareMysContext(e, 'gs')
    const mys = await MysApi.init(e, 'cookie')
    if (!mys || !await mys.checkCk()) {
      return e.reply(
        mys
          ? `UID: ${mys.uid} Cookie 失效，请重新登录或【#刷新ck】`
          : `请绑定 Cookie 后再使用 #小剧诗`,
      )
    }

    const uid = mys.uid
    const player = Player.create(e)

    let resRole
    let resDetail
    let lvs
    try {
      resRole = await mys.getRoleCombat(true)
      lvs = getVal(resRole, isCurrent ? 'data.0' : 'data.1')
      if (!lvs || !lvs.has_detail_data) {
        return e.reply(`暂未获得${periodText}幻想真境剧诗挑战数据…`)
      }
      resDetail = await mys.getCharacter()
      if (!resDetail?.avatars || resDetail.avatars.length <= 3) {
        return e.reply('角色信息获取失败')
      }
      delete resDetail._res
      delete resRole._res
    } catch (err) {
      logger.error('[xhh][miniRoleCombat] 拉取剧诗失败:', err)
      return e.reply(`获取失败：${err?.message || err}`)
    }

    player.setMysCharData(resDetail)

    // 关键关卡用到的自有角色 id
    const needIds = []
    for (const round of lvs?.detail?.rounds_data || []) {
      if (!isKeyRound(round)) continue
      for (const a of round.avatars || []) {
        if (Number(a.avatar_type) === 1 && a.avatar_id) {
          needIds.push(String(a.avatar_id))
        }
      }
    }
    const uniqIds = lodash.uniq(needIds)

    // 刷 mys 详情（武器/圣遗物）+ 天赋
    try {
      if (uniqIds.length) {
        await player.refresh({ detail: 1, talent: 1, ids: uniqIds })
      }
    } catch (err) {
      logger.debug('[xhh][miniRoleCombat] refresh detail 失败:', err?.message)
      try { await player.refreshTalent(uniqIds) } catch (_) {}
    }

    const avatarDataMap = {}
    try {
      const ret = await player.refreshAndGetAvatarData({
        ids: uniqIds,
        detail: 0,
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
      const ownAvatarData = player.getAvatarData(uniqIds) || {}
      if (Array.isArray(ownAvatarData)) {
        for (const a of ownAvatarData) avatarDataMap[String(a.id)] = a
      } else {
        for (const [k, v] of Object.entries(ownAvatarData)) avatarDataMap[String(k)] = v
      }
    }

    // 补全 artisSet
    for (const id of uniqIds) {
      const sid = String(id)
      const cur = avatarDataMap[sid]
      if (cur?.artisSet?.names?.length || cur?.artisSet?.imgs?.length) continue
      try {
        const av = player.getAvatar?.(id) || player.getAvatar?.(Number(id))
        if (!av) continue
        const ds = av.getDetail?.() || {}
        avatarDataMap[sid] = { ...(cur || {}), ...ds }
      } catch (_) {}
    }

    const stages = buildKeyStages(lvs, avatarDataMap)
    if (!stages.length) {
      return e.reply(
        `${periodText}尚未通关关键关卡（第 3/6/8/10 幕或圣牌），或数据为空。`,
      )
    }

    const stat = lvs.stat || {}
    const month = lvs.schedule?.start_date_time?.month
      || lvs.schedule?.month
      || moment().month() + 1
    const difficultyMap = { 1: '简单', 2: '普通', 3: '困难', 4: '卓越', 5: '月谕' }
    const difficulty = difficultyMap[stat.difficulty_id] || '未知'
    const totalTime = lvs.detail?.fight_statisic?.total_use_time ?? stat.total_use_time ?? '-'

    const bgImage = pickBgImage()
    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = targetName || e.sender?.card || e.sender?.nickname || String(qq)

    const tplFile = pluginDir + '/resources/role_combat/mini_role_combat.html'
    const ppath = '../../../../plugins/xhh-TL/resources/'
    const renderScale = getRenderScaleStyle(config(), 2.2)

    const renderData = {
      stages,
      stageCount: stages.length,
      periodText,
      month,
      difficulty,
      totalTime,
      coin: stat.coin_num ?? '-',
      medal: (stat.get_medal_round_list || []).filter(x => x === 1).length,
      medalTotal: (stat.get_medal_round_list || []).length || '-',
      uid,
      qq,
      qqname,
      bgImage,
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'mini_role_combat', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            sys: { scale: renderScale },
            ...data,
            ppath,
            tplFile,
            saveId: 'mini_role_combat',
            _miao_path: ppath,
          }
        },
      })
      if (renderResult && Buffer.isBuffer(renderResult.file)) {
        return e.reply(segment.image(renderResult.file), true)
      }
      if (renderResult === true || renderResult?.message_id) return true
      return e.reply('渲染失败，请稍后再试')
    } catch (err) {
      logger.error('[xhh][miniRoleCombat] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
