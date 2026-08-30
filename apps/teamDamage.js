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
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'
import { faceUrl, resolveTargetQq, resolveDisplayName, pickGsBgImage } from '../utils/gsHelper.js'
import { createUser } from '../utils/userBind.js'
import {
  ELEM_CN,
  applyLoadoutMods,
  expandActionCodes,
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
  // 用 expandActionCodes 而不是单码判断：不然「班尼特eq」「重击5」这种连写会被当成队员名
  if (expandActionCodes(raw)) return true
  // 角色名 + 动作：如 班尼特e / 香菱重击 / 玛薇卡a1*3
  for (let i = raw.length - 1; i >= 1; i--) {
    if (!expandActionCodes(raw.slice(i))) continue
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
    // 手打的「@昵称」不会变成 at 段而是留在正文里，别把它当角色名（真 at 走 resolveTargetQq）
    .filter((s) => s && !s.startsWith('@'))

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
  // 传标准名进去：「换专武」要靠它拼成 miao 的「X专武」别名
  const stdName = Character.get(name)?.name || name
  const { mods, unknown } = parseLoadoutMods(parts, stdName)
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

/* ─────────────────────────── 帮助图内容 ─────────────────────────── */

/**
 * #队伍伤害帮助 的图文内容
 * 动作码与换装写法必须和 utils/teyvatDamage.js 里的 ACTION_PATTERNS / parseLoadoutMods 对齐，
 * 改解析规则时记得同步这里。
 */
const HELP_DATA = {
  basics: [
    { cmd: '#队伍伤害 钟离,班尼特,香菱,行秋', desc: '最简写法，手法用小助手的推荐轴' },
    { cmd: '#队伍伤害详情 钟离,班尼特,香菱,行秋', desc: '多出一张逐条伤害表（详情 / 过程 / 全图 都认）' },
    { cmd: '#队伍伤害 @某人 钟离,班尼特,香菱,行秋', desc: '算别人的面板' },
    { cmd: '#队伍伤害102515702 钟离,班尼特,香菱', desc: '直接指定 UID；队伍 1~4 人都行' },
  ],
  actions: [
    { code: 'e', mean: '元素战技', tip: '也可写 元素战技 / 战技' },
    { code: '长e / 短e', mean: '长按 / 短按 E', tip: '钟离、班尼特这类可长按的角色才有区别；也可写 e2 / e1' },
    { code: 'q', mean: '元素爆发', tip: '也可写 大招 / 爆发' },
    { code: '重击 / zj', mean: '重击（蓄力攻击）', tip: '也可写 蓄力' },
    { code: 'a1 ~ a6', mean: '普攻第 N 段', tip: 'aN 的 N 是段位，不是次数；裸写 a = a1' },
  ],
  actionRules: [
    '手法写在队伍后面，用空格或逗号隔开：<b>#队伍伤害 钟离,班尼特,香菱,行秋 钟离长e,班尼特q,香菱q,e</b>',
    '<b>不写角色名就沿用上一个角色</b>：<b>香菱q,e</b> = 香菱 Q 接 香菱 E',
    '同一个角色可以<b>连写</b>：<b>班尼特eq</b> = 班尼特 E 接 Q；<b>玛薇卡qa1</b> = Q 接普攻一段',
    '带<b>次数</b>：<b>重击5</b>（重击 5 次）、<b>q2</b>（Q 两次）、<b>a1*3</b> / <b>a1x3</b> / <b>a1 3次</b>',
    '⚠️ 只有 <b>重击 / q</b> 后面的数字是次数，<b>aN 的 N 是普攻第几段</b>，<b>e1 / e2</b> 是短按 / 长按',
    '至少要写 2 个动作；某角色用不了的动作（普攻段数超了之类）小助手会罢工，会提示你换写法',
  ],
  mods: [
    { code: '换六命 / 换6命 / 换命座6', mean: '命座 0~6' },
    { code: '换精5 / 换精炼5', mean: '武器精炼 1~5' },
    { code: '换天赋101313 / 换天赋10-13-13', mean: '天赋等级（普攻 / E / Q）' },
    { code: '换90级 / 换80级', mean: '角色等级' },
    { code: '换护摩之杖 / 换讨龙', mean: '换武器，支持 miao 的所有别名' },
    { code: '换专武', mean: '该角色的专属武器（没收录会提示你直接写武器名）' },
    { code: '换4千岩 / 换千岩4 / 换绝缘', mean: '圣遗物套装，不写件数按 4 件' },
    { code: '换2追忆2如雷', mean: '2+2 散搭' },
  ],
  modRules: [
    '换装接在角色名后面，<b>可以叠加</b>，一个角色写几个就都生效',
    '完整例子：<b>#队伍伤害 玛薇卡换专武换六命换天赋101313,茜特菈莉换4千岩,班尼特换精5,希诺宁</b>',
    '换武器时插件按 miao 的武器数据把<b>白值与副词条</b>（双爆 / 精通 / 充能等）换算过去，攻击力% 类按近似折算',
    '换套装只替换<b>套装效果</b>，圣遗物<b>词条沿用你现在的面板</b>，所以结果是估算，不是真的重新刷圣遗物',
    '武器类型不对（给行秋换法器）会提示并跳过该项，其余换装照常生效',
  ],
  notes: [
    '面板取 <b>miao-plugin 的角色面板缓存</b>，队里每个人都要先 <b>#更新面板</b>，缺谁会告诉你缺谁',
    '伤害由<b>提瓦特小助手</b>服务端计算，插件只负责组装面板、翻译手法与出图',
    '小助手只收录了部分配队套路：功能位太多、或找不到它认得的主 C 时会回「暂不支持该队伍」——<b>不是角色没认出来</b>，换个输出位即可',
    '想让 FanSky_Qs 的同名指令出图，把配置里的 team_damage 关掉即可',
  ],
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
          reg: '^\\s*#?队伍伤害(帮助|说明|教程|用法|怎么用|怎么玩)\\s*$',
          fnc: 'help',
        },
        {
          reg: '^\\s*#?队伍伤害(详情|过程|全图)?\\s*(\\d{9})?\\s*(.*)$',
          fnc: 'query',
        },
      ],
    })
  }

  /** #队伍伤害帮助：把手法与换装的全部写法出成一张图 */
  async help(e) {
    if (config().team_damage === false) return false

    const qq = e.user_id || ''
    const renderData = {
      ...HELP_DATA,
      qq,
      qqname: await resolveDisplayName(e, qq),
      bgImage: toDataUrl(pickGsBgImage('xhh-TL/teamDamage')),
      fontPanel: toFileUrl(path.join(MIAO_RES, 'common/font/HYWH-65W.ttf')),
      fontNum: toFileUrl(path.join(MIAO_RES, 'common/font/tttgbnumber.ttf')),
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    try {
      const renderResult = await e.runtime.render('xhh-TL', 'team_damage_help', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: getRenderScaleStyle(config(), 1.4) },
            ppath: '../../../../plugins/xhh-TL/resources/',
            tplFile: pluginDir + '/resources/team_damage/team_damage_help.html',
            saveId: 'team_damage_help',
          }
        },
      })
      const image = await toWebp(extractRenderBuffer(renderResult))
      if (!image) throw new Error('渲染结果中没有图片数据')
      return replyQuote(e, segment.image(image))
    } catch (err) {
      logger.error('[xhh][teamDamage] 帮助渲染失败:', err)
      return e.reply(`渲染失败：${err.message || err}`)
    }
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
          '全部写法看 #队伍伤害帮助',
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
        await e.reply(
          `${char.name} 的「换${unknown.join('换')}」看不懂\n` +
            '支持：换武器名（讨龙 / 息灾 / 专武）/ 换4千岩 / 换绝缘 / 换2追忆2如雷 / 换六命 / 换精5 / 换天赋101313 / 换90级',
          true,
        )
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
        await e.reply(
          `${parsed.error}\n` +
            '手法写法：角色名+动作，动作可写 e / 长e / 短e / q / 重击(zj) / a1~a6（普攻第N段）\n' +
            '同一角色连招可省略名字，也能连写或带次数：班尼特eq、重击5、a1*3',
          true,
        )
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
      // 「暂不支持该队伍」是小助手自己的配队库没收录这套，跟角色认不认识无关（实测：
      // 闲云 / 伊安珊 / 夏沃蕾 单独配常规队都能算，但两三个功能位凑一队就会被拒），
      // 直接抛原文用户会以为是插件不认角色，这里补一句说明
      if (/暂不支持该队伍/.test(res.msg || '')) {
        await e.reply(
          `小助手算不了这套队：${team.map((t) => t.name).join('|')}\n` +
            '它只收录了部分配队套路，队里功能位太多、或没有它认得的主 C 时就会拒绝（角色本身是认识的）。\n' +
            '把其中一位换成明确的输出位再试试~',
          true,
        )
        return true
      }
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
      const image = await toWebp(extractRenderBuffer(renderResult))
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
