/**
 * 原神 #角色持有率
 * 展示各角色在深渊参与者中的持有率（own_rate），改用体力插件（毛玻璃）风格渲染。
 *
 * 数据源：提瓦特小助手 api.yshelper.com/getAbyssRank.php（has_list.own_rate）。
 * 该持有率为「参与本期深渊统计的玩家」中的持有比例，样本量最大、最具代表性。
 * 按星级（5★ / 4★）分组，组内按持有率降序。
 * 绑定 CK 后：高亮你已持有的角色，未持有半透明显示。
 *
 * 命令：#角色持有率 / #持有率 / #角色拥有率
 * 支持 @某人：用被 @ 的人的账号来标记持有。
 */

import moment from 'moment'
import lodash from 'lodash'
import { Character } from '../../miao-plugin/models/index.js'
import { config, getRenderScaleStyle, pluginDir } from '../utils/pluginConfig.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { getAbyssRank, pickHasList } from '../utils/yshelperApi.js'
import { resolveTargetQq, resolveDisplayName, faceUrl, pickGsBgImage, loadAvatarData } from '../utils/gsHelper.js'

/**
 * 把 has_list 整理成按星级分组的持有率列表。
 * ownedIds：本人持有的角色 id 集合（无 CK 时为空）。
 * 返回 { groups:[{star, rate, avg, chars:[...]}], total, hasCk }
 */
function buildGroups(data, ownedIds) {
  const hasList = pickHasList(data)
  const rows = []
  for (const ds of hasList) {
    const char = Character.get(ds.name)
    if (!char) continue
    const rate = Number(ds.own_rate)
    if (!Number.isFinite(rate)) continue
    const star = ds.star || char.star || 4
    rows.push({
      id: String(char.id),
      name: char.name || ds.name,
      star,
      rate,
      face: faceUrl(char.face),
      owned: ownedIds.has(String(char.id)),
    })
  }
  if (!rows.length) return null

  const groups = []
  for (const star of [5, 4]) {
    const chars = rows
      .filter((r) => r.star === star)
      .sort((a, b) => b.rate - a.rate)
      .map((r) => ({ ...r, rateText: r.rate.toFixed(1) }))
    if (!chars.length) continue
    groups.push({
      star,
      count: chars.length,
      chars,
    })
  }
  return { groups, total: rows.length }
}

export class holdRate extends plugin {
  constructor() {
    super({
      name: '[小火花]原神角色持有率',
      dsc: '原神角色持有率（提瓦特小助手深渊统计）',
      event: 'message',
      priority: config().hold_rate_priority ?? -98,
      rule: [
        {
          reg: '^\\s*#?角色(持有率|拥有率|持有|拥有)\\s*$',
          fnc: 'query',
        },
        {
          reg: '^\\s*#?持有率\\s*$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().hold_rate === false) return false

    const targetQq = resolveTargetQq(e)
    if (targetQq) e.at = targetQq

    await replyProgress(e, '正在获取角色持有率…')

    // 拉数据源
    let data
    try {
      data = await getAbyssRank()
    } catch (err) {
      logger.error('[xhh][holdRate] 数据源失败:', err)
      return e.reply('角色持有率数据获取失败，请稍后重试~')
    }

    // 取本人持有（有 CK 才能标记）
    const { hasCk, avatarData } = await loadAvatarData(e, { logTag: 'xhh][holdRate' })
    const ownedIds = new Set(Object.keys(avatarData))

    const built = buildGroups(data, ownedIds)
    if (!built || !built.groups.length) {
      return e.reply('暂无可用的角色持有率数据，请稍后重试~')
    }

    // 本人已持有数量（仅统计榜单内角色）
    let ownedCount = 0
    if (hasCk) {
      for (const g of built.groups) for (const c of g.chars) if (c.owned) ownedCount++
    }

    const qq = targetQq || e.user_id || e.sender?.user_id || ''
    const qqname = await resolveDisplayName(e, qq)
    const bgImage = pickGsBgImage('xhh-TL/holdRate')
    const renderScale = getRenderScaleStyle(config(), 2.0)
    const cfg = config()
    const themeRaw = String(cfg.hold_rate_theme || cfg.gs_all_abyss_theme || 'light').toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const tplFile = pluginDir + '/resources/hold_rate/hold_rate.html'
    const ppath = '../../../../plugins/xhh-TL/resources/'

    const version = data.now_version || data.version || ''
    const renderData = {
      qq,
      qqname,
      bgImage,
      theme,
      version,
      hasCk,
      ownedCount,
      total: built.total,
      generatedAt: moment().format('MM-DD HH:mm'),
      lastUpdate: data.last_update || '',
      groups: built.groups,
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'hold_rate', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath,
            tplFile,
            saveId: 'hold_rate',
          }
        },
      })
      const image = await toWebp(extractRenderBuffer(renderResult))
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][holdRate] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}
