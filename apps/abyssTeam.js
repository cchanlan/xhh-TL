/**
 * 原神 #深渊配队
 * 从 miao-plugin fork 抄来的深渊配队建议，改用体力插件（毛玻璃）风格渲染。
 *
 * 数据源：提瓦特小助手 api.yshelper.com（result[3] 为配队组合列表）。
 * 算法沿用 miao-plugin：把「上半队」与「下半队」两两拼成完整 4+4 双队，
 * 按出场数据 + 本人练度打分，取每层 Top4。无 CK 也能出通用榜（不含练度）。
 *
 * 命令：#深渊配队 / #深渊组队 / #深渊配对
 * 支持 @某人：用被 @ 的人的账号练度来推荐。
 */

import moment from 'moment'
import lodash from 'lodash'
import { Character } from '../../miao-plugin/models/index.js'
import { config, getRenderScaleStyle, pluginDir } from '../utils/pluginConfig.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { getAbyssRank, pickTeamList, pickHasList } from '../utils/yshelperApi.js'
import { resolveTargetQq, resolveDisplayName, faceUrl, pickGsBgImage, loadAvatarData } from '../utils/gsHelper.js'

/**
 * 把 yshelper 的配队数据整理成 { floor: 12, up:[{item,rate}], down:[...] }
 * item 为逗号分隔的角色 id 串。
 */
function buildFloorData(data) {
  const teamList = pickTeamList(data)
  if (!teamList) return null

  // has_list.avatar(图片URL) -> 角色 id
  const urlToId = {}
  for (const ds of pickHasList(data)) {
    const char = Character.get(ds.name)
    if (char && ds.avatar) urlToId[ds.avatar] = char.id
  }

  const floorData = { floor: 12, up: [], down: [] }
  for (const ds of teamList) {
    const ids = []
    for (const role of ds.role || []) {
      const id = urlToId[role.avatar]
      if (id) ids.push(String(id))
    }
    if (!ids.length) continue
    const item = ids.join(',')
    if (ds.up_use_num > 0) floorData.up.push({ item, rate: ds.up_use_num })
    if (ds.down_use_num > 0) floorData.down.push({ item, rate: ds.down_use_num })
  }
  if (!floorData.up.length && !floorData.down.length) return null
  return floorData
}

/**
 * miao-plugin 深渊配队核心算法：
 * 半队按练度打分并去重 -> 上下半两两拼成完整双队 -> 取 Top4。
 * 返回 { ret: {12: [team...]}, avatarMap }
 */
function computeTeams(floorDataList, avatarData) {
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

  const getTeamCfg = (str) => {
    const teams = str.split(',')
    teams.sort()
    let teamMark = 0
    lodash.forEach(teams, (a) => {
      if (!avatarRet[a]) {
        teamMark = -1
        noAvatar[a] = true
      }
      if (teamMark !== -1) teamMark += avatarRet[a] * 1
    })
    if (teamMark === -1) teamMark = 1
    return { key: teams.join(','), mark: teamMark }
  }

  const hasSame = (t1, t2) => {
    for (let i = 0; i < t1.length; i++) if (t2.includes(t1[i])) return true
    return false
  }

  const data = {}
  lodash.forEach(floorDataList, (ds) => {
    const floor = ds.floor
    if (!data[floor]) data[floor] = { up: {}, down: {}, teams: [] }
    lodash.forEach(['up', 'down'], (halfKey) => {
      lodash.forEach(ds[halfKey], (row) => {
        const cfg = getTeamCfg(row.item)
        if (!cfg) return
        if (!data[floor][halfKey][cfg.key]) {
          data[floor][halfKey][cfg.key] = { count: 0, mark: 0, hasTeam: cfg.mark > 1 }
        }
        data[floor][halfKey][cfg.key].count += row.rate
        data[floor][halfKey][cfg.key].mark += row.rate * cfg.mark
      })
    })

    let temp = []
    lodash.forEach(['up', 'down'], (halfKey) => {
      lodash.forEach(data[floor][halfKey], (d, team) => {
        temp.push({
          team,
          teamArr: team.split(','),
          half: halfKey,
          count: d.count,
          mark: d.mark,
          mark2: 1,
          hasTeam: d.hasTeam,
        })
      })
      temp = lodash.sortBy(temp, 'mark')
      data[floor].teams = temp.reverse()
    })
  })

  const ret = {}
  lodash.forEach(data, (floorData, floor) => {
    ret[floor] = {}
    const ds = ret[floor]
    lodash.forEach(floorData.teams, (t1) => {
      if (t1.mark2 <= 0) return true
      lodash.forEach(floorData.teams, (t2) => {
        if (t1.mark2 <= 0) return true
        if (t1.half === t2.half || t2.mark2 <= 0) return true
        const teamKey = t1.half === 'up' ? t1.team + '+' + t2.team : t2.team + '+' + t1.team
        if (ds[teamKey]) return true
        if (hasSame(t1.teamArr, t2.teamArr)) return true
        ds[teamKey] = {
          up: t1.half === 'up' ? t1 : t2,
          down: t1.half === 'up' ? t2 : t1,
          count: Math.min(t1.count, t2.count),
          mark: t1.hasTeam && t2.hasTeam ? t1.mark + t2.mark : t1.count + t2.count,
        }
        t1.mark2--
        t2.mark2--
        return false
      })
      if (lodash.keys(ds).length >= 20) return false
    })
  })

  lodash.forEach(ret, (ds, floor) => {
    let arr = lodash.sortBy(lodash.values(ds), 'mark').reverse().slice(0, 4)
    lodash.forEach(arr, (team) => {
      team.up.teamArr = Character.sortIds(team.up.teamArr)
      team.down.teamArr = Character.sortIds(team.down.teamArr)
    })
    ret[floor] = arr
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

/** 把 computeTeams 结果整理成模板友好的层列表 */
function buildFloors(ret, avatarMap) {
  const toAvatars = (arr) =>
    (arr || []).map((id) => {
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

  const floors = []
  lodash.forEach(ret, (teams, floor) => {
    floors.push({
      floor,
      teams: (teams || []).map((t) => ({
        count: Math.round(t.count || 0),
        up: toAvatars(t.up?.teamArr),
        down: toAvatars(t.down?.teamArr),
      })),
    })
  })
  floors.sort((a, b) => Number(b.floor) - Number(a.floor))
  return floors
}

export class abyssTeam extends plugin {
  constructor() {
    super({
      name: '[小火花]原神深渊配队',
      dsc: '原神深渊配队建议（提瓦特小助手数据 + 本人练度）',
      event: 'message',
      priority: config().abyss_team_priority ?? -98,
      rule: [
        {
          reg: '^\\s*#?深渊(配队|组队|配对)\\s*$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().abyss_team === false) return false

    const targetQq = resolveTargetQq(e)
    if (targetQq) e.at = targetQq

    await replyProgress(e, '正在获取深渊配队建议…')

    // 拉数据源
    let data
    try {
      data = await getAbyssRank()
    } catch (err) {
      logger.error('[xhh][abyssTeam] 数据源失败:', err)
      return e.reply('深渊配队数据获取失败，请稍后重试~')
    }
    const floorData = buildFloorData(data)
    if (!floorData) return e.reply('暂无可用的深渊配队数据，请稍后重试~')

    // 取本人练度（有 CK 更准；无 CK 用通用榜）
    const { hasCk, avatarData } = await loadAvatarData(e, { talent: true, logTag: 'xhh][abyssTeam' })

    const { ret, avatarMap } = computeTeams([floorData], avatarData)
    const floors = buildFloors(ret, avatarMap)
    if (!floors.length || !floors.some((f) => f.teams.length)) {
      return e.reply('暂无可用的深渊配队方案~')
    }

    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = await resolveDisplayName(e, qq)
    const bgImage = pickGsBgImage('xhh-TL/abyssTeam')
    const renderScale = getRenderScaleStyle(config(), 2.0)
    // 深渊配队主题：留空则跟随全部深渊主题
    const cfg = config()
    const themeRaw = String(cfg.abyss_team_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const tplFile = pluginDir + '/resources/abyss_team/abyss_team.html'
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
      floors,
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'abyss_team', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath,
            tplFile,
            saveId: 'abyss_team',
          }
        },
      })
      const image = await toWebp(extractRenderBuffer(renderResult))
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][abyssTeam] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
