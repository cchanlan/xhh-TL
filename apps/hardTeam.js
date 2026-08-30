/**
 * 原神 #危战配队
 * 幽境危战出场配队建议，改用体力插件（毛玻璃）风格渲染。
 *
 * 数据源：提瓦特小助手 api.yshelper.com/getAbyssRank2.php（幽境危战使用率统计）。
 * 与深渊不同：危战配队分「上半区 / 中半区 / 下半区」三关强敌，每个 combo
 * 本身就是完整 4 人队，不需要像深渊那样把上下半拼成 4+4 双队。
 * 因此这里对每个半区各取高频完整队，按出场热度 + 本人练度打分排序取 Top。
 * 无 CK 也能出通用榜（不含练度）。
 *
 * 命令：#危战配队 / #危战组队 / #危战配对 / #幽境危战配队
 * 支持 @某人：用被 @ 的人的账号练度来推荐。
 */

import moment from 'moment'
import lodash from 'lodash'
import { Character } from '../../miao-plugin/models/index.js'
import { config, getRenderScaleStyle, pluginDir } from '../utils/pluginConfig.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { getHardRank, pickTeamList, buildAvatarUrlNameMap } from '../utils/yshelperApi.js'
import { resolveTargetQq, resolveDisplayName, faceUrl, pickGsBgImage, loadAvatarData } from '../utils/gsHelper.js'

/** 三半区元数据：key 对应 combo 里的 xxx_use_num 字段 */
const HALVES = [
  { key: 'up', numKey: 'up_use_num', label: '上半区', cls: 'up' },
  { key: 'mid', numKey: 'mid_use_num', label: '中半区', cls: 'mid' },
  { key: 'down', numKey: 'down_use_num', label: '下半区', cls: 'down' },
]

/**
 * 把危战配队数据整理成 { up:[{ids,rate}], mid:[...], down:[...] }
 * ids 为角色 id 数组。头像 URL 通过 name 映射反查角色。
 */
function buildHalfData(data) {
  const teamList = pickTeamList(data)
  if (!teamList) return null

  // 头像 URL -> 角色中文名（has_list + result[1]/[2] 单体榜合并）
  const urlToName = buildAvatarUrlNameMap(data)

  const half = { up: [], mid: [], down: [] }
  for (const ds of teamList) {
    const ids = []
    for (const role of ds.role || []) {
      const name = urlToName[role.avatar]
      const char = name ? Character.get(name) : null
      if (char) ids.push(String(char.id))
    }
    if (!ids.length) continue
    for (const h of HALVES) {
      const num = ds[h.numKey]
      if (num > 0) half[h.key].push({ ids, rate: num })
    }
  }
  if (!half.up.length && !half.mid.length && !half.down.length) return null
  return half
}

/**
 * 对每个半区：把相同队伍去重合并出场次数，按练度打分排序取 Top。
 * 返回 { up:[team...], mid:[...], down:[...], avatarMap }
 * team = { count, ids:[排序后角色id] }
 */
function computeHalves(half, avatarData, topN = 6) {
  // 练度分：等级/武器取小 *100 + 天赋最大 *1000（对齐深渊配队算法）
  const avatarRet = {}
  const noAvatar = {}
  lodash.forEach(avatarData, (avatar) => {
    const t = avatar.originalTalent || avatar.talent || {}
    const tA = t?.a?.level ?? t?.a ?? 1
    const tE = t?.e?.level ?? t?.e ?? 1
    const tQ = t?.q?.level ?? t?.q ?? 1
    avatarRet[avatar.id] =
      Math.min(avatar.level || 1, avatar.weapon?.level || 1) * 100 +
      Math.max(tA || 1, tE || 1, tQ || 1) * 1000
  })

  const getTeamCfg = (ids) => {
    const arr = [...ids].sort()
    let mark = 0
    let hasTeam = true
    lodash.forEach(arr, (a) => {
      if (!avatarRet[a]) {
        hasTeam = false
        noAvatar[a] = true
      }
      if (hasTeam) mark += avatarRet[a] * 1
    })
    if (!hasTeam) mark = 1
    return { key: arr.join(','), mark, hasTeam }
  }

  const ret = {}
  lodash.forEach(HALVES, (h) => {
    const merged = {}
    lodash.forEach(half[h.key] || [], (row) => {
      const cfg = getTeamCfg(row.ids)
      if (!merged[cfg.key]) {
        merged[cfg.key] = { count: 0, mark: 0, hasTeam: cfg.hasTeam, cfgMark: cfg.mark }
      }
      merged[cfg.key].count += row.rate
      merged[cfg.key].mark += row.rate * cfg.mark
    })
    let arr = lodash.map(merged, (d, key) => ({
      ids: key.split(','),
      count: d.count,
      // 有练度时按热度*练度综合分；无 CK 时练度恒定，等价于按热度
      mark: d.hasTeam ? d.mark : d.count,
    }))
    arr = lodash.sortBy(arr, 'mark').reverse().slice(0, topN)
    lodash.forEach(arr, (team) => {
      team.ids = Character.sortIds(team.ids)
    })
    ret[h.key] = arr
  })

  // 角色卡：本人持有用面板数据，未持有用角色底数据（灰显）
  const avatarMap = {}
  lodash.forEach(avatarData, (ds) => {
    const char = Character.get(ds.id)
    avatarMap[ds.id] = {
      id: String(ds.id),
      name: ds.name || char?.name || String(ds.id),
      star: ds.star || char?.star || 4,
      level: ds.level || 0,
      cons: ds.cons || 0,
      face: faceUrl(char?.face || ds.face),
      owned: true,
    }
  })
  lodash.forEach(noAvatar, (d, id) => {
    const char = Character.get(id)
    if (!char) return
    avatarMap[id] = {
      id: String(id),
      name: char.name,
      star: char.star || 4,
      level: 0,
      cons: 0,
      face: faceUrl(char.face),
      owned: false,
    }
  })

  return { ret, avatarMap }
}

/** 把 computeHalves 结果整理成模板友好的半区列表 */
function buildSections(ret, avatarMap) {
  const toAvatars = (ids) =>
    (ids || []).map((id) => {
      const a = avatarMap[String(id)]
      if (a) return a
      const char = Character.get(id)
      return {
        id: String(id),
        name: char?.name || String(id),
        star: char?.star || 4,
        level: 0,
        cons: 0,
        face: faceUrl(char?.face),
        owned: false,
      }
    })

  const sections = []
  for (const h of HALVES) {
    const teams = (ret[h.key] || []).map((t) => ({
      count: Math.round(t.count || 0),
      roles: toAvatars(t.ids),
    }))
    if (!teams.length) continue
    sections.push({ label: h.label, cls: h.cls, teams })
  }
  return sections
}

export class hardTeam extends plugin {
  constructor() {
    super({
      name: '[小火花]原神危战配队',
      dsc: '幽境危战配队建议（提瓦特小助手数据 + 本人练度）',
      event: 'message',
      priority: config().hard_team_priority ?? -98,
      rule: [
        {
          reg: '^\\s*#?(?:幽境)?危战(配队|组队|配对)\\s*$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().hard_team === false) return false

    const targetQq = resolveTargetQq(e)
    if (targetQq) e.at = targetQq

    await replyProgress(e, '正在获取危战配队建议…')

    // 拉数据源
    let data
    try {
      data = await getHardRank()
    } catch (err) {
      logger.error('[xhh][hardTeam] 数据源失败:', err)
      return e.reply('危战配队数据获取失败，请稍后重试~')
    }
    const halfData = buildHalfData(data)
    if (!halfData) return e.reply('暂无可用的危战配队数据，请稍后重试~')

    // 取本人练度（有 CK 更准；无 CK 用通用榜）
    const { hasCk, avatarData } = await loadAvatarData(e, { talent: true, logTag: 'xhh][hardTeam' })

    const { ret, avatarMap } = computeHalves(halfData, avatarData)
    const sections = buildSections(ret, avatarMap)
    if (!sections.length || !sections.some((s) => s.teams.length)) {
      return e.reply('暂无可用的危战配队方案~')
    }

    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = await resolveDisplayName(e, qq)
    const bgImage = pickGsBgImage('xhh-TL/hardTeam')
    const renderScale = getRenderScaleStyle(config(), 2.0)
    // 危战配队主题：留空则跟随全部深渊主题
    const cfg = config()
    const themeRaw = String(cfg.hard_team_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const tplFile = pluginDir + '/resources/hard_team/hard_team.html'
    const ppath = '../../../../plugins/xhh-TL/resources/'

    const version = data.now_version || data.version || ''
    const renderData = {
      qq,
      qqname,
      bgImage,
      theme,
      version,
      hasCk,
      generatedAt: moment().format('MM-DD HH:mm'),
      lastUpdate: data.last_update || '',
      tips: data.tips || '',
      sections,
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'hard_team', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath,
            tplFile,
            saveId: 'hard_team',
          }
        },
      })
      const image = await toWebp(extractRenderBuffer(renderResult))
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][hardTeam] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
