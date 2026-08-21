/**
 * 原神 #队伍伤害
 *
 * 抄自 FanSky_Qs 的提瓦特小助手队伍伤害，搬到本插件并加了两件事：
 *   1. 自定义手法：`#队伍伤害 火神,茜特菈莉,班尼特,希诺宁 班尼特e,希诺宁e,a1,a2,班尼特q,火神q`
 *      —— 队伍写完，后面接动作序列；不写角色名就沿用上一个角色（和小程序一致）。
 *   2. 换装模拟：`#队伍伤害 丝柯克换六命换精5换天赋101313,莫娜换讨龙换4千岩`
 *      —— 支持换武器 / 换圣遗物套装 / 换命座 / 换精炼 / 换天赋 / 换等级。
 *
 * 面板取 miao-plugin 的角色面板缓存（需先 #更新面板）。
 * 接口细节与逆向结论写在 utils/teyvatDamage.js 顶部。
 */

import fs from 'fs'
import path from 'path'
import moment from 'moment'
import lodash from 'lodash'
import { ArtifactSet, Character, Player, Weapon } from '../../miao-plugin/models/index.js'
import { config, getRenderScaleStyle, pluginDir, toFileUrl, toDataUrl } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { faceUrl, resolveTargetQq, resolveDisplayName, pickGsBgImage } from '../utils/gsHelper.js'
import { createUser } from '../utils/userBind.js'
import {
  ELEM_CN,
  applyLoadoutMods,
  normalizeSkillCode,
  parseCombo,
  parseLoadoutMods,
  profileToPanel,
  profileToRoleData,
  requestTeamDamage,
  teyvatServer,
} from '../utils/teyvatDamage.js'

const MIAO_RES = path.join(process.cwd(), 'plugins/miao-plugin/resources')
const MIAO_META = path.join(MIAO_RES, 'meta-gs')

/** 旅行者没有固定面板，小助手也算不了 */
const TRAVELER = ['旅行者', '空', '荧', '萤']

/* ─────────────────────────── 输入解析 ─────────────────────────── */

/** 这个 token 是不是动作（手法）而不是队员 */
function isActionToken(token) {
  const raw = String(token || '').trim()
  if (!raw) return false
  if (normalizeSkillCode(raw)) return true
  // 角色名 + 动作：如 班尼特e / 香菱重击
  for (let i = raw.length - 1; i >= 1; i--) {
    if (!normalizeSkillCode(raw.slice(i))) continue
    if (Character.get(raw.slice(0, i))) return true
  }
  return false
}

/**
 * 把指令正文切成「队伍」与「手法」两段
 * 规则：从左往右扫，遇到第一个动作 token 起，后面全算手法。
 */
export function splitInput(text) {
  const tokens = String(text || '')
    .split(/[\s,，、。|]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const team = []
  const combo = []
  for (const token of tokens) {
    if (!combo.length && !isActionToken(token)) {
      team.push(token)
      continue
    }
    combo.push(token)
  }
  return { teamTokens: team, comboTokens: combo }
}

/** 队员 token → { name, mods }，token 形如「丝柯克换六命换精5」 */
export function parseMember(token) {
  const parts = String(token || '')
    .split('换')
    .map((s) => s.trim())
    .filter(Boolean)
  const name = parts.shift() || ''
  const { mods, unknown } = parseLoadoutMods(parts)
  return { name, mods, unknown }
}

/* ─────────────────────────── 图标路径 ─────────────────────────── */

/**
 * 图标统一走 miao 模型自带的相对路径（char.imgs / weapon.img / artiSet.img）
 * 自己拼路径的话技能图会踩坑：多数角色的 icons/ 下没有 talent-e.webp，
 * miao 是按 talentCons 换成 cons-3 / cons-5 的图，这套映射它已经做好了。
 */
function charImgs(name) {
  return Character.get(name)?.imgs || {}
}

function charFace(name) {
  const imgs = charImgs(name)
  return faceUrl(imgs.qFace || imgs.face || '')
}

function weaponIcon(weaponName) {
  const weapon = weaponName ? Weapon.get(weaponName) : null
  return weapon?.img ? faceUrl(weapon.img) : ''
}

function artifactIcon(setName) {
  const set = setName ? ArtifactSet.get(setName) : null
  if (set?.img) return faceUrl(set.img)
  const file = path.join(MIAO_META, 'artifact', 'imgs', setName, '1.webp')
  return fs.existsSync(file) ? toFileUrl(file) : ''
}

/** 技能图标：a 用武器类型图，e/q 命座改过就是命座图 */
function skillIcon(name, key) {
  const imgs = charImgs(name)
  return imgs[key] ? faceUrl(imgs[key]) : ''
}

/* ─────────────────────────── 返回值 → 视图 ─────────────────────────── */

/** '你的队伍9秒内造成总伤害32.3W，DPS为:' → { tm: '9秒', total: '32.3W' } */
function parseTotalTips(tips) {
  const clean = String(tips || '').replace(/你的队伍|，DPS为[:：]?/g, '')
  const [tm, total] = clean.split('秒内造成总伤害')
  return { tm: tm ? `${tm}秒` : '', total: total || '' }
}

/** 充能文本 '香菱共获取同色球1个，异色球6.5个，无色球3个' → 球数 */
function parseRecharge(text) {
  const s = String(text || '')
  const same = s.match(/同色球([\d.]+)个/)?.[1]
  const diff = s.match(/异色球([\d.]+)个/)?.[1]
  const none = s.match(/无色球([\d.]+)个/)?.[1]
  return {
    same: same ? Number(same) : 0,
    diff: diff ? Number(diff) : 0,
    none: none ? Number(none) : 0,
  }
}

/** advice → 伤害表 [时间, 动作, 暴击, 不暴击, 期望] */
function parseDamages(advice) {
  const rows = []
  for (const step of advice || []) {
    const content = String(step?.content || '')
    if (!content) continue
    const [time, rest = ''] = content.split(' ')
    const action = rest.split('，')[0] || ''
    const nums = rest.split('，')[1] || ''
    let crit = '-'
    let noCrit = '-'
    let avg = '-'
    if (nums) {
      const map = {}
      for (const part of nums.split(',')) {
        const [k, v] = part.split(/[:：]/)
        if (k && v !== undefined) map[k.trim()] = v.trim()
      }
      crit = map['暴击'] ?? '-'
      noCrit = map['不暴击'] ?? '-'
      avg = map['期望'] ?? map['伤害'] ?? '-'
      if (crit === '-' && noCrit === '-' && avg === '-') {
        // 只有一个数值（治疗/护盾这类）
        avg = nums.split(/[:：]/).pop() || '-'
      }
    }
    rows.push([time.replace('s', ''), action.toUpperCase(), crit, noCrit, avg])
  }
  return rows
}

/** buff → [时间, 名称, 效果] */
function parseBuffs(buffList) {
  const rows = []
  for (const buff of buffList || []) {
    const content = String(buff?.content || '')
    if (!content) continue
    const [time, rest = ''] = content.split(' ')
    const name = rest.split('-')[0] || ''
    const desc = rest.split('-').slice(1).join('-')
    rows.push([time.replace('s', ''), name, desc])
  }
  return rows
}

/** 输出占比饼图：conic-gradient + 标签坐标 */
function buildPie(chartData) {
  const items = (chartData || [])
    .map((v) => {
      const [name, dmg] = String(v.name || '').split('\n')
      return {
        name,
        damage: Number(String(dmg || '').replace('W', '')) || 0,
        text: dmg || '',
        color: v.label?.color || v.color || '#888',
      }
    })
    .filter((v) => v.name)
  const total = lodash.sumBy(items, 'damage') || 1
  const sorted = lodash.orderBy(items, ['damage'], ['desc'])

  const stops = []
  const labels = []
  let acc = 0
  for (const item of sorted) {
    const ratio = item.damage / total
    const start = acc * 360
    acc += ratio
    const end = acc * 360
    stops.push(`${item.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`)
    if (ratio > 0.06) {
      const mid = ((start + end) / 2) * (Math.PI / 180)
      labels.push({
        name: item.name,
        text: item.text,
        left: (50 + 32 * Math.sin(mid)).toFixed(2),
        top: (50 - 32 * Math.cos(mid)).toFixed(2),
      })
    }
  }
  return {
    gradient: `conic-gradient(${stops.join(', ')})`,
    labels,
    legend: sorted.map((v) => ({
      name: v.name,
      color: v.color,
      pct: `${Math.round((v.damage / total) * 1000) / 10}%`,
      text: v.text,
    })),
  }
}

/** 组装出图数据 */
export function buildView(raw, panels, modLabels) {
  const { tm, total } = parseTotalTips(raw.zdl_tips0)

  // 充能信息按角色名索引
  const RING = 2 * Math.PI * 10.5
  const rechargeMap = {}
  for (const item of raw.recharge_info || []) {
    const name = String(item.recharge || '').split('共获取')[0]
    if (!name) continue
    const ratio = Math.min(1, Math.max(0, Number(String(item.rate || '').replace('%', '')) / 100))
    rechargeMap[name] = {
      pct: item.rate || '',
      // 环里只放数字：'100%' 在 26 的 viewBox 里会被裁掉
      pctNum: String(item.rate || '').replace('%', ''),
      dash: `${(ratio * RING).toFixed(2)}, ${RING.toFixed(2)}`,
      ...parseRecharge(item.recharge),
    }
  }

  const avatars = []
  for (const role of raw.role_list || []) {
    const panel = panels[role.role] || {}
    const sets = Object.entries(panel.relicSet || {})
      .filter(([, num]) => num >= 2)
      .map(([name, num]) => ({ name, num: num >= 4 ? 4 : 2, icon: artifactIcon(name) }))

    avatars.push({
      name: role.role,
      star: role.role_star || panel.star || 5,
      face: charFace(role.role),
      elem: panel.element || '',
      cons: role.role_class ?? panel.cons ?? 0,
      level: String(role.role_level || panel.level || '').replace('Lv', ''),
      weapon: {
        name: panel.weapon?.name || role.weapon || '',
        icon: weaponIcon(panel.weapon?.name || role.weapon),
        rarity: panel.weapon?.rarity || 4,
        affix: panel.weapon?.affix || 1,
        level: panel.weapon?.level || 90,
      },
      sets,
      cp: lodash.round(panel.fightProp?.['暴击率'] ?? 0, 1),
      cd: lodash.round(panel.fightProp?.['暴击伤害'] ?? 0, 1),
      keyProp: role.key_ability || '',
      keyValue: role.key_value ?? '',
      recharge: rechargeMap[role.role] || { pct: '', pctNum: '', dash: `0, ${(2 * Math.PI * 10.5).toFixed(2)}`, same: 0, diff: 0, none: 0 },
      skills: ['a', 'e', 'q'].map((key) => ({
        icon: skillIcon(role.role, key),
        level: panel.skills?.[key]?.level ?? '',
        style: panel.skills?.[key]?.style || '',
      })),
      mods: modLabels[role.role] || [],
    })
  }

  const damages = parseDamages(raw.advice)
  // 手法写长了 advice 能有几十条，图会长到没法看，截断并在图上说明
  const DAMAGE_LIMIT = 60
  const damagesShown = damages.slice(0, DAMAGE_LIMIT)
  const damagesCut = damages.length - damagesShown.length
  // 最高一击：伤害表里暴击值最大的一条（按全量算，不受截断影响）
  let maxHit = null
  for (const row of damages) {
    const value = Number(String(row[2]).replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    if (!maxHit || value > maxHit.value) maxHit = { value, action: row[1], time: row[0] }
  }

  const pie = buildPie(raw.chart_data)
  // 主元素：输出占比最高的角色元素（跳过绽放这类非角色来源）
  let elem = ''
  for (const item of pie.legend) {
    const hit = panels[item.name]
    if (hit?.element) {
      elem = hit.element
      break
    }
  }

  return {
    uid: raw.uid || '',
    rank: raw.zdl_tips2 || '',
    dps: raw.zdl_result || '',
    tm,
    total,
    rankTip: String(raw.zdl_tips3 || '').replace(/^级别，?/, ''),
    elem,
    pie,
    avatars,
    actions: String(raw.combo_intro || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    buffs: parseBuffs(raw.buff),
    damages: damagesShown,
    damagesCut,
    maxHit,
  }
}

/* ─────────────────────────── 插件 ─────────────────────────── */

export class teamDamage extends plugin {
  constructor() {
    super({
      name: '[小火花]原神队伍伤害',
      dsc: '提瓦特小助手队伍伤害（支持自定义手法与换装模拟）',
      event: 'message',
      // 比 FanSky_Qs 的 3141 小，同名指令由本插件抢答
      priority: config().team_damage_priority ?? -98,
      rule: [
        {
          reg: '^\\s*#?队伍伤害(详情|过程|全图)?\\s*(\\d{9})?\\s*(.*)$',
          fnc: 'query',
        },
      ],
    })
  }

  async query(e) {
    if (config().team_damage === false) return false

    const match = e.msg.match(/^\s*#?队伍伤害(详情|过程|全图)?\s*(\d{9})?\s*(.*)$/)
    if (!match) return false
    const detail = !!match[1]
    let uid = match[2] || ''
    const body = String(match[3] || '').trim()

    if (!body) {
      await e.reply(
        [
          '用法：#队伍伤害 角色1,角色2,角色3,角色4',
          '自定义手法：#队伍伤害 钟离,班尼特,香菱,行秋 钟离e,班尼特q,香菱q,行秋q,行秋e',
          '换装模拟：#队伍伤害 香菱换六命换精5换天赋101313,行秋换讨龙换4千岩',
          '加「详情」出逐条伤害表：#队伍伤害详情 ...',
        ].join('\n'),
        true,
      )
      return true
    }

    // UID：指令里带 > @某人 > 自己
    const targetQq = resolveTargetQq(e)
    if (!uid) {
      try {
        const user = await createUser(targetQq || e.user_id, e)
        uid = user?.getUid?.('gs') || ''
      } catch (_) {}
      if (!uid && !targetQq) uid = e.user?.getUid?.('gs') || ''
    }
    if (!uid) {
      await e.reply(targetQq ? '这位还没绑定原神 UID~' : '你还没绑定原神 UID，也可以直接写：#队伍伤害100000000 角色…', true)
      return true
    }

    // 解析队伍 + 手法
    const { teamTokens, comboTokens } = splitInput(body)
    if (!teamTokens.length) {
      await e.reply('没认出队伍，写法：#队伍伤害 钟离,班尼特,香菱,行秋', true)
      return true
    }
    if (teamTokens.length > 4) {
      await e.reply('一支队伍最多 4 个人哦~', true)
      return true
    }

    const members = []
    for (const token of teamTokens) {
      const { name, mods, unknown } = parseMember(token)
      const char = Character.get(name)
      if (!char || char.game !== 'gs') {
        await e.reply(`认不出角色「${name}」`, true)
        return true
      }
      if (TRAVELER.includes(char.name)) {
        await e.reply('旅行者的伤害小助手算不了~', true)
        return true
      }
      if (unknown.length) {
        await e.reply(`「换${unknown.join('换')}」看不懂，支持：换武器名 / 换4千岩 / 换六命 / 换精5 / 换天赋101313 / 换90级`, true)
        return true
      }
      if (members.some((m) => m.char.id === char.id)) {
        await e.reply(`队伍里重复出现了「${char.name}」`, true)
        return true
      }
      members.push({ char, mods })
    }

    // 取面板
    const player = Player.create(String(uid))
    const roleData = []
    const panels = {}
    const modLabels = {}
    const missing = []
    const warns = []
    for (const member of members) {
      const profile = player.getProfile(member.char.id)
      if (!profile?.hasData) {
        missing.push(member.char.name)
        continue
      }
      const item = profileToRoleData(profile, uid)
      const panel = profileToPanel(profile)
      const { labels, warns: modWarns } = applyLoadoutMods(item, panel, member.mods, profile)
      roleData.push(item)
      panels[member.char.name] = panel
      if (labels.length) modLabels[member.char.name] = labels
      warns.push(...modWarns)
    }
    if (missing.length) {
      await e.reply(`UID${uid} 缺少 ${missing.join('|')} 的面板\n请先 #更新面板 再来~`, true)
      return true
    }

    const modSummary = Object.entries(modLabels).map(([name, labels]) => `${name}：${labels.join(' / ')}`)
    const tips = [`UID${uid}：${members.map((m) => m.char.name).join('|')}`]
    if (modSummary.length) tips.push(`换装：${modSummary.join('；')}`)
    if (warns.length) tips.push(`注意：${warns.join('；')}`)
    await replyProgress(e, tips.join('\n'))

    // 手法
    const team = roleData.map((item, idx) => ({ name: item.role, no: idx + 1 }))
    let custom = null
    if (comboTokens.length) {
      const parsed = parseCombo(comboTokens, team)
      if (parsed.error) {
        await e.reply(`${parsed.error}\n手法写法：角色名+动作，动作可写 e / 长e / 短e / q / zj / a1~a6，同一角色连招可省略名字`, true)
        return true
      }
      custom = parsed.combo
    }

    const requestBody = { uid: String(uid), server: teyvatServer(uid), role_data: roleData }
    if (custom?.length) requestBody.custom_combo = custom

    logger.info(
      `[xhh][teamDamage] UID${uid} ${team.map((t) => t.name).join('|')}${custom ? ` 手法:${custom.join(' ')}` : ''}`,
    )

    const res = await requestTeamDamage(requestBody, (config().team_damage_timeout ?? 20) * 1000)
    if (!res.ok) {
      await e.reply(res.msg, true)
      return true
    }

    // 出图
    const view = buildView(res.result, panels, modLabels)
    const qq = targetQq || e.user_id || ''
    const renderData = {
      ...view,
      qq,
      qqname: await resolveDisplayName(e, qq),
      detail,
      custom: !!custom?.length,
      modSummary,
      bgImage: toDataUrl(pickGsBgImage('xhh-TL/teamDamage')),
      elemBg: elemBgUrl(view.elem),
      fontPanel: toFileUrl(path.join(MIAO_RES, 'common/font/HYWH-65W.ttf')),
      fontNum: toFileUrl(path.join(MIAO_RES, 'common/font/tttgbnumber.ttf')),
      talentBg: talentBgUrl(view.elem),
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'team_damage', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: getRenderScaleStyle(config(), 1.4) },
            ppath: '../../../../plugins/xhh-TL/resources/',
            tplFile: pluginDir + '/resources/team_damage/team_damage.html',
            saveId: 'team_damage',
          }
        },
      })
      const image = extractRenderBuffer(renderResult)
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][teamDamage] 渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
  }
}

/** 元素背景（miao 自带的元素底图） */
function elemBgUrl(elemCn) {
  const key = lodash.findKey(ELEM_CN, (v) => v === elemCn)
  if (!key) return ''
  const file = path.join(MIAO_RES, 'common/bg', `bg-${key}.webp`)
  return fs.existsSync(file) ? toDataUrl(file) : ''
}

/** 天赋条背景 */
function talentBgUrl(elemCn) {
  const key = lodash.findKey(ELEM_CN, (v) => v === elemCn)
  if (!key) return ''
  const file = path.join(MIAO_RES, 'common/bg', `talent-${key}.webp`)
  return fs.existsSync(file) ? toFileUrl(file) : ''
}
