/**
 * 提瓦特小助手「队伍伤害」计算封装
 *
 * 数据源：api.lelaer.com/ys/getTeamResult.php（微信小程序「提瓦特小助手」的伤害计算接口）
 * 面板数据来自 miao-plugin 的角色面板缓存（用户需先 #更新面板）。
 *
 * ── 接口实测结论（都是抓不到文档、只能试出来的，改动前先看这里）──────────────
 *
 * 1) 请求体：{ uid, server, role_data: [...] }，server 用小助手自己的写法
 *    （cn_gf01 / cn_qd01 / us / eur / asia / hk），见 teyvatServer()。
 *
 * 2) 服务端会拿 role_data **自己重算面板**，并不是照搬我们传的数值：
 *    - `attack` 完全被忽略；真正参与计算的是 `base_attack` + 圣遗物词条明细
 *      + 武器被动。传 attack=9999 结果一模一样。
 *    - `base_attack` 生效（改 1000→2000 面板攻击 1975→3225）。
 *    - `hp` / `defend` / `element` / `crit` / `crit_dmg` / `recharge` 是最终值，直接采用。
 *    - `weapon`（武器名）只用来查**被动**，武器白值与副词条服务端不算：
 *      换成不存在的武器名和换成白缨枪结果相同（都退化成“无被动”）。
 *      → 所以本地换武器必须自己修正 base_attack 与副词条，见 applyLoadoutMods()。
 *    - `weapon_class`（'精炼N阶'）生效，服务端按精炼档位套被动数值。
 *    - `role_class`（命座）、`ability1/2/3`（天赋等级）、`level` 均生效。
 *    - `artifacts`（如 '千岩牢固4' / 'A2+B2'）生效，服务端会套用 2/4 件套效果；
 *      名字不认识就当没有套装效果，但 artifacts_detail 里的词条照算。
 *    - `artifacts_detail[].maintips` 要用短名（'生命值'/'攻击力'/'火'/'暴击率'…），
 *      写 '火元素伤害加成' 这类长名不生效。
 *
 * 3) 自定义手法：顶层字段 `custom_combo`，格式是**扁平序列数组**：
 *      [角色序号, 技能码, 技能码, 角色序号, 技能码, ...]
 *    - 角色序号 = role_data 里的下标 + 1（1-based，字符串数字也认）；
 *      省略则沿用上一个角色，所以 [1,'e','q'] 表示 1 号角色 E 接 Q。
 *    - 技能码：`q`、`e`（默认 E）、`e1` 短按 E、`e2` 长按 E、`zj` 重击、
 *      `a1`…`aN` 普攻第 N 段（N 上限见返回的 custom[].skill 里 combo_num）。
 *    - 非法码（'a' 裸写 / 'A' 大写 / 'zj2' / 'e9'）会让服务端 500 且返回**空 body**，
 *      所以这里在本地先把码规范化 + 校验，见 normalizeSkillCode()。
 *    - 只传 1 个动作时服务端会忽略自定义、回落默认手法，需要 ≥2 个动作。
 *    - 不传 custom_combo 就是服务端自带的推荐手法（返回 combo_intro 里）。
 *
 * 4) 返回 result 关键字段：zdl_result(DPS) / zdl_tips0(总伤与轴长文案) /
 *    zdl_tips2(评级 ACE/S/A/B) / zdl_tips3(超过百分比) / role_list(每人面板摘要) /
 *    chart_data + chart_color(输出占比饼图) / recharge_info(充能与球数) /
 *    advice(逐条伤害，content 形如 `0.9s 钟离e爆发，暴击:5603,不暴击:2001,期望:4522`) /
 *    buff(逐条 buff) / combo_intro(手法文本) / custom(每个角色可选技能面板)。
 */

import fetch from 'node-fetch'
import lodash from 'lodash'
import { Character, Weapon, ArtifactSet } from '../../miao-plugin/models/index.js'

/** 小助手请求头（照小程序，缺 referer 会被拒） */
const TEYVAT_HEADERS = {
  'Content-Type': 'application/json',
  referer: 'https://servicewechat.com/wx2ac9dce11213c3a8/192/page-frame.html',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 12; SM-G977N Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/4375 MMWEBSDK/20221011 Mobile Safari/537.36 MMWEBID/4357 MicroMessenger/8.0.30.2244(0x28001E44) WeChat/arm64 Weixin GPVersion/1 NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android',
}

const TEAM_API = 'https://api.lelaer.com/ys/getTeamResult.php'

/** miao 属性 key → 小助手/词条中文短名 */
const ATTR_CN = {
  hp: '生命值',
  hpPlus: '生命值',
  atk: '攻击力',
  atkPlus: '攻击力',
  def: '防御力',
  defPlus: '防御力',
  mastery: '元素精通',
  recharge: '元素充能效率',
  cpct: '暴击率',
  cdmg: '暴击伤害',
  heal: '治疗加成',
  pyro: '火',
  hydro: '水',
  cryo: '冰',
  electro: '雷',
  anemo: '风',
  geo: '岩',
  dendro: '草',
  phy: '物理',
}

/** 小助手元素伤害字段 → miao 元素 key */
const DMG_FIELDS = {
  fire_dmg: 'pyro',
  water_dmg: 'hydro',
  ice_dmg: 'cryo',
  thunder_dmg: 'electro',
  wind_dmg: 'anemo',
  rock_dmg: 'geo',
  grass_dmg: 'dendro',
  physical_dmg: 'phy',
}

/** 圣遗物部位顺序（小助手要中文部位名） */
const ARTI_POS = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']

/** 元素 key → 中文（模板里按中文选背景） */
export const ELEM_CN = {
  pyro: '火',
  hydro: '水',
  cryo: '冰',
  electro: '雷',
  anemo: '风',
  geo: '岩',
  dendro: '草',
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const int = (v) => String(Math.round(num(v)))
const pct = (v) => `${Math.round(num(v) * 10) / 10}%`
const unpct = (v) => num(String(v ?? '').replace('%', ''))

/** uid → 小助手 server 写法 */
export function teyvatServer(uid) {
  const first = String(uid || '')[0]
  if (first === '5') return 'cn_qd01'
  if (first === '6') return 'us'
  if (first === '7') return 'eur'
  if (first === '8') return 'asia'
  if (first === '9') return 'hk'
  return 'cn_gf01'
}

/**
 * 请求队伍伤害
 * @param {object} body { uid, server, role_data, custom_combo? }
 * @param {number} [timeout] 毫秒
 * @returns {Promise<{ok: boolean, result?: object, msg?: string}>}
 */
export async function requestTeamDamage(body, timeout = 20000) {
  let text = ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const res = await fetch(TEAM_API, {
      method: 'POST',
      headers: TEYVAT_HEADERS,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)
    text = await res.text()
  } catch (err) {
    return { ok: false, msg: `提瓦特小助手接口请求失败：${err?.message || err}` }
  }

  // 手法里出现服务端不支持的动作时，PHP 直接崩掉、返回空 body
  if (!text.trim()) {
    return { ok: false, msg: '小助手拒绝了这套手法（可能某个动作该角色用不了，比如普攻段数超了）' }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch (_) {
    return { ok: false, msg: '提瓦特小助手返回了无法解析的内容' }
  }
  if (json.code !== 200 || !json.result) {
    return { ok: false, msg: json.info || json.tips || '提瓦特小助手接口返回错误' }
  }
  const r = json.result
  // 队伍不合法（人数不足 / 不支持）时 zdl_result 为空，提示在 zdl_tips1
  if (!r.zdl_result && r.zdl_tips1) return { ok: false, msg: r.zdl_tips1 }
  if (!r.zdl_result) return { ok: false, msg: '小助手没能算出这套队伍的伤害' }
  return { ok: true, result: r }
}

/* ────────────────────────────── 技能码 / 手法 ────────────────────────────── */

/**
 * 动作片段匹配表（按优先级，长写法在前）
 * 每项：[正则, (m) => 码数组]
 * 说明：
 * - `a1`…`a9` 里的数字是普攻**第几段**（小助手语义），不是次数
 * - `zj` / `q` 后面的数字是**次数**（这两个动作没有段位概念，`重击5` 就是连点 5 次重击）
 * - `e1` 短按 / `e2` 长按
 */
const ACTION_PATTERNS = [
  [/^(?:长按?|大)[eE]/, () => ['e2']],
  [/^(?:短按?|点|小)[eE]/, () => ['e1']],
  [/^(?:重击|蓄力攻击|蓄力|[zZ][jJ])\s*([1-9]\d?)?/, (m) => repeat('zj', m[1])],
  [/^(?:普攻|平[aA]|[aA])\s*([1-9])?/, (m) => [`a${m[1] || 1}`]],
  [/^(?:元素战技|战技)/, () => ['e']],
  [/^[eE]\s*([12])?/, (m) => [m[1] ? `e${m[1]}` : 'e']],
  [/^(?:大招|元素爆发|爆发|[qQ])\s*([1-9]\d?)?/, (m) => repeat('q', m[1])],
]

const MAX_REPEAT = 20

function repeat(code, countRaw) {
  const n = countRaw ? Number(countRaw) : 1
  if (!Number.isFinite(n) || n < 1 || n > MAX_REPEAT) return null
  return Array.from({ length: n }, () => code)
}

/**
 * 把一段动作文本拆成技能码序列，非法返回 null
 * 支持：单个动作（`e` / `长E` / `a3` / `重击`）、连写（`eq` / `a1a2` / `ezj`）、
 *      次数（`重击5` / `q2` / `a1*3` / `e2x2` / `q3次`）
 */
export function expandActionCodes(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  // 通用重复后缀：*N / xN / ×N / N次（作用于前面整段）
  const rep = text.match(/^(.+?)\s*(?:[*xX×]\s*([1-9]\d?)|([1-9]\d?)\s*次)$/)
  if (rep) {
    const base = expandActionCodes(rep[1])
    const n = Number(rep[2] || rep[3])
    if (!base || n < 1 || n > MAX_REPEAT || base.length * n > MAX_REPEAT * 2) return null
    return Array.from({ length: n }, () => base).flat()
  }

  const codes = []
  let rest = text
  while (rest) {
    let matched = false
    for (const [re, toCodes] of ACTION_PATTERNS) {
      const m = rest.match(re)
      if (!m || !m[0]) continue
      const part = toCodes(m)
      if (!part) return null
      codes.push(...part)
      rest = rest.slice(m[0].length).replace(/^[\s+·、]+/, '')
      matched = true
      break
    }
    if (!matched) return null
  }
  return codes.length ? codes : null
}

/**
 * 规范化单个技能码：兼容大小写与中文写法，非法或含多个动作时返回 ''
 * 合法输出：q / e / e1 / e2 / zj / a1..a9
 */
export function normalizeSkillCode(raw) {
  const codes = expandActionCodes(raw)
  return codes?.length === 1 ? codes[0] : ''
}

/** 技能码 → 展示名（本地兜底用，正常走接口返回的 combo_intro） */
export function skillCodeLabel(code) {
  if (code === 'q') return 'Q'
  if (code === 'e') return 'E'
  if (code === 'e1') return '短E'
  if (code === 'e2') return '长E'
  if (code === 'zj') return '重击'
  if (/^a\d$/.test(code)) return code.toUpperCase()
  return code
}

/**
 * 解析手法 token 列表
 * token 形如：班尼特e / 希诺宁e / a1 / q / 火神q / 钟离长E / 香菱重击 /
 *            班尼特eq（连写） / 重击5（次数） / a1*3
 * 省略角色名时沿用上一个角色（和小程序、图里的写法一致）
 *
 * @param {string[]} tokens
 * @param {{name: string, no: number}[]} team role_data 顺序（no 为 1-based）
 * @returns {{combo: (string|number)[], actions: string[], error?: string}}
 */
export function parseCombo(tokens, team) {
  const combo = []
  const actions = []
  let cur = 0

  const findNo = (name) => {
    const char = Character.get(name)
    const std = char?.name || name
    const hit = team.find((t) => t.name === std || t.name === name)
    return hit ? hit.no : 0
  }

  for (const token of tokens) {
    const raw = String(token || '').trim()
    if (!raw) continue

    // 先整体当动作试一次（纯 a1 / q / 重击5 / eq 这类）
    let codes = expandActionCodes(raw)
    let roleName = ''
    if (!codes) {
      // 角色名 + 动作：从右往左切，取最长能识别成角色名的前缀
      for (let i = raw.length - 1; i >= 1; i--) {
        const c = expandActionCodes(raw.slice(i))
        if (!c) continue
        const prefix = raw.slice(0, i)
        if (!Character.get(prefix) && !findNo(prefix)) continue
        codes = c
        roleName = prefix
        break
      }
    }
    if (!codes) return { combo: [], actions: [], error: `手法里的「${raw}」看不懂` }

    if (roleName) {
      const no = findNo(roleName)
      if (!no) return { combo: [], actions: [], error: `手法里的「${roleName}」不在这支队伍里` }
      if (no !== cur) {
        combo.push(no)
        cur = no
      }
    } else if (!cur) {
      // 首个动作没写角色名：默认队伍第一位
      cur = 1
      combo.push(1)
    }
    for (const code of codes) {
      combo.push(code)
      actions.push(`${team[cur - 1]?.name || ''}${skillCodeLabel(code)}`)
    }
  }

  if (!combo.length) return { combo: [], actions: [] }
  if (actions.length < 2) {
    return { combo: [], actions: [], error: '自定义手法至少要写 2 个动作，只写 1 个的话小助手会忽略' }
  }
  return { combo, actions }
}

/* ────────────────────────────── 换装解析 ────────────────────────────── */

const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

/** 天赋写法 → [a, e, q] */
function parseTalent(text) {
  const s = String(text).replace(/[^\d\-/,，]/g, '')
  const parts = s.split(/[-/,，]+/).filter(Boolean)
  if (parts.length >= 3) return parts.slice(0, 3).map((v) => Math.min(15, Math.max(1, Number(v))))
  const digits = parts.join('')
  // 101313 / 91010 这种连写：优先按 2 位一组，长度 3 时按 1 位一组
  if (digits.length === 6) {
    return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].map(Number)
  }
  if (digits.length === 3) return digits.split('').map(Number)
  if (digits.length === 4) {
    // 1013 → 无法判断，按「a=10, e=1, q=3」不合理，直接均分成两位+两位并把 a 沿用
    return [Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(2, 4))]
  }
  if (digits) {
    const v = Number(digits)
    return [v, v, v]
  }
  return null
}

/** '4千岩' / '千岩4' / '2追忆2如雷' / '千岩牢固4' / '绝缘'(不写件数按 4 件) → [{name, num}] */
function parseArtisSets(text) {
  const s = String(text).trim()
  if (!s) return null
  // 不带件数：整串就是套装名，按 4 件套算（用户嘴上说「换绝缘」基本都是指 4 件）
  if (!/\d/.test(s)) {
    const only = ArtifactSet.get(s)
    return only?.name ? [{ name: only.name, num: 4 }] : null
  }
  const chunks = s.match(/\d+[^\d]+|[^\d]+\d+/g)
  if (!chunks) return null
  const sets = []
  for (const chunk of chunks) {
    const m = chunk.match(/^(\d+)\s*(.+)$/) || chunk.match(/^(.+?)\s*(\d+)$/)
    if (!m) return null
    const [a, b] = [m[1], m[2]]
    const count = /^\d+$/.test(a) ? Number(a) : Number(b)
    const name = /^\d+$/.test(a) ? b : a
    const set = ArtifactSet.get(String(name).trim())
    if (!set?.name) return null
    if (![2, 4, 5].includes(count)) return null
    sets.push({ name: set.name, num: count === 5 ? 4 : count })
  }
  if (!sets.length) return null
  if (lodash.sumBy(sets, 'num') > 5) return null
  return sets
}

/**
 * 解析单个角色的换装描述（「换」之后的部分）
 * 支持：六命 / 6命 / 命座6 ； 精5 / 精炼5 ； 天赋101313 ； 90级 ；
 *       武器名（含别名，如 讨龙 / 息灾）； 专武（按角色名查 miao 的「X专武」别名）；
 *       圣遗物套装（4千岩 / 2追忆2如雷 / 绝缘）
 * @param {string[]} list 「换」分段后的描述
 * @param {string} [charName] 角色标准名，用于把裸写的「专武」补成「X专武」
 * @returns {{mods: object, unknown: string[]}}
 */
export function parseLoadoutMods(list, charName = '') {
  const mods = {}
  const unknown = []
  for (const rawItem of list) {
    const item = String(rawItem || '').trim()
    if (!item) continue

    // 命座
    let m = item.match(/^(?:命座)?\s*([0-6零〇一二三四五六])\s*命?$/)
    if (m && /命/.test(item)) {
      mods.cons = m[1] in CN_NUM ? CN_NUM[m[1]] : Number(m[1])
      continue
    }
    // 精炼
    m = item.match(/^(?:精炼?|r|R)\s*([1-5])\s*(?:阶|精)?$/) || item.match(/^([1-5])\s*精(?:炼)?$/)
    if (m) {
      mods.affix = Number(m[1])
      continue
    }
    // 天赋
    m = item.match(/^(?:天赋|技能)\s*([\d\-/,，]+)$/)
    if (m) {
      const t = parseTalent(m[1])
      if (t) {
        mods.talent = t
        continue
      }
    }
    // 等级
    m = item.match(/^(?:等级)?\s*(\d{1,2})\s*级$/)
    if (m) {
      mods.level = Math.min(90, Math.max(1, Number(m[1])))
      continue
    }
    // 专武：miao 的武器别名表里就收了「玛薇卡专武」这种写法，补上角色名去查即可
    if (/^(?:专武|专属武器|专属)$/.test(item)) {
      const own = charName ? Weapon.get(`${charName}专武`) : null
      if (own?.name) {
        mods.weapon = own.name
        continue
      }
      unknown.push(charName ? `${item}（没查到${charName}的专武，请直接写武器名）` : item)
      continue
    }
    // 武器（含别名）。放在圣遗物之前：武器名更具体，「息灾」这类不会被套装别名抢走；
    // 反过来「绝缘」这种只有套装叫得上名字的词，Weapon.get 会落空、再交给套装解析
    const weapon = Weapon.get(item)
    if (weapon?.name) {
      mods.weapon = weapon.name
      continue
    }
    // 圣遗物套装
    const sets = parseArtisSets(item)
    if (sets) {
      mods.artis = sets
      continue
    }
    unknown.push(item)
  }
  return { mods, unknown }
}

/** 武器副词条 key → 作用到 role_data 的方式 */
function applyWeaponBonus(roleData, key, value, sign) {
  const v = num(value) * sign
  if (!v) return
  switch (key) {
    case 'atkPct':
      // 服务端只认 base_attack，攻击% 折算成固定攻击（近似，误差在圣遗物攻击%的叠乘上）
      roleData.base_attack = int(num(roleData.base_attack) * (1 + v / 100))
      break
    case 'hpPct':
      roleData.hp = int(num(roleData.hp) + num(roleData.base_hp) * (v / 100))
      break
    case 'defPct':
      roleData.defend = int(num(roleData.defend) + num(roleData.base_defend) * (v / 100))
      break
    case 'cpct':
      roleData.crit = pct(unpct(roleData.crit) + v)
      break
    case 'cdmg':
      roleData.crit_dmg = pct(unpct(roleData.crit_dmg) + v)
      break
    case 'mastery':
      roleData.element = int(num(roleData.element) + v)
      break
    case 'recharge':
      roleData.recharge = pct(unpct(roleData.recharge) + v)
      break
    case 'phy':
      roleData.physical_dmg = pct(unpct(roleData.physical_dmg) + v)
      break
    default:
      break
  }
}

/** 武器等级上限（3 星及以下 70） */
const weaponMaxLevel = (star) => (num(star) >= 4 ? 90 : 70)

/** 武器类型 → 中文（提示用，别把 catalyst 这种英文丢给用户看） */
const WEAPON_TYPE_CN = {
  sword: '单手剑',
  claymore: '双手剑',
  polearm: '长柄武器',
  bow: '弓',
  catalyst: '法器',
}

/**
 * 把换装应用到 role_data（同时更新渲染用的 panel）
 * @returns {{labels: string[], warns: string[]}} labels 用于出图标注
 */
export function applyLoadoutMods(roleData, panel, mods, profile) {
  const labels = []
  const warns = []
  if (!mods || !Object.keys(mods).length) return { labels, warns }

  if (mods.cons !== undefined) {
    roleData.role_class = mods.cons
    if (panel) panel.cons = mods.cons
    labels.push(`${mods.cons}命`)
  }

  if (mods.level !== undefined) {
    roleData.level = mods.level
    if (panel) panel.level = mods.level
    labels.push(`Lv${mods.level}`)
  }

  if (mods.talent) {
    const [a, e, q] = mods.talent
    roleData.ability1 = a
    roleData.ability2 = e
    roleData.ability3 = q
    if (panel?.skills) {
      panel.skills.a.level = a
      panel.skills.e.level = e
      panel.skills.q.level = q
      panel.skills.a.style = a > (panel.skills.a.originLvl || 0) ? 'extra' : ''
      panel.skills.e.style = e > (panel.skills.e.originLvl || 0) ? 'extra' : ''
      panel.skills.q.style = q > (panel.skills.q.originLvl || 0) ? 'extra' : ''
    }
    labels.push(`天赋${a}/${e}/${q}`)
  }

  if (mods.weapon) {
    const newW = Weapon.get(mods.weapon)
    const oldW = Weapon.get(profile?.weapon?.name || roleData.weapon)
    if (!newW?.name) {
      warns.push(`没找到武器「${mods.weapon}」`)
    } else if (newW.type && profile?.weapon?.type && newW.type !== profile.weapon.type) {
      warns.push(`「${newW.name}」是${WEAPON_TYPE_CN[newW.type] || newW.type}，${roleData.role}用不了`)
    } else {
      const oldLevel = num(roleData.weapon_level) || 90
      const newLevel = Math.min(oldLevel, weaponMaxLevel(newW.star))
      const oldAttr = oldW?.calcAttr?.(oldLevel)
      const newAttr = newW.calcAttr?.(newLevel)
      // 白值差：服务端不算武器白值，得我们自己搬
      if (oldAttr?.atkBase && newAttr?.atkBase) {
        roleData.base_attack = int(num(roleData.base_attack) - oldAttr.atkBase + newAttr.atkBase)
      }
      // 副词条：先退掉旧武器的，再加上新武器的
      if (oldAttr?.attr?.key) applyWeaponBonus(roleData, oldAttr.attr.key, oldAttr.attr.value, -1)
      if (newAttr?.attr?.key) applyWeaponBonus(roleData, newAttr.attr.key, newAttr.attr.value, 1)

      roleData.weapon = newW.name
      roleData.weapon_level = newLevel
      if (panel?.weapon) {
        panel.weapon.name = newW.name
        panel.weapon.rarity = newW.star
        panel.weapon.level = newLevel
        panel.weapon.imgPath = `${newW.type}/${newW.name}`
      }
      labels.push(newW.name)
    }
  }

  if (mods.affix !== undefined) {
    roleData.weapon_class = `精炼${mods.affix}阶`
    if (panel?.weapon) panel.weapon.affix = mods.affix
    labels.push(`精${mods.affix}`)
  }

  if (mods.artis) {
    roleData.artifacts = mods.artis.map((s) => `${s.name}${s.num}`).join('+')
    if (panel) {
      panel.relicSet = {}
      for (const s of mods.artis) panel.relicSet[s.name] = s.num
    }
    labels.push(mods.artis.map((s) => `${s.num}${s.name}`).join('+'))
  }

  return { labels, warns }
}

/* ────────────────────────── miao 面板 → 小助手 role_data ────────────────────────── */

/**
 * miao profile → 小助手 role_data 项
 * 字段与部位名都要照小助手的写法，长名 / 英文 key 一律不认。
 */
export function profileToRoleData(profile, uid) {
  const attr = profile.attr || {}
  const base = profile.base || {}
  const artisMark = safeArtisMark(profile)

  const data = {
    uid: String(uid),
    role: profile.char?.name || profile.name,
    role_class: num(profile.cons),
    level: num(profile.level),
    weapon: profile.weapon?.name || '',
    weapon_level: num(profile.weapon?.level) || 90,
    weapon_class: `精炼${num(profile.weapon?.affix) || 1}阶`,

    hp: int(attr.hp),
    base_hp: int(base.hp),
    attack: int(attr.atk),
    base_attack: int(base.atk),
    defend: int(attr.def),
    base_defend: int(base.def),
    element: int(attr.mastery),

    crit: pct(attr.cpct),
    crit_dmg: pct(attr.cdmg),
    heal: pct(attr.heal),
    recharge: pct(attr.recharge),

    ability1: num(profile.talent?.a?.level) || 1,
    ability2: num(profile.talent?.e?.level) || 1,
    ability3: num(profile.talent?.q?.level) || 1,
  }

  // 元素伤害加成：只给本元素填 dmg，其余 0
  for (const [field, key] of Object.entries(DMG_FIELDS)) {
    if (field === 'physical_dmg') continue
    data[field] = pct(profile.elem === key ? attr.dmg : 0)
  }
  data.physical_dmg = pct(attr.phy)

  // 套装：'沉沦之心4' / 'A2+B2'
  data.artifacts = Object.entries(artisMark.sets || {})
    .map(([name, cnt]) => `${name}${cnt}`)
    .join('+')

  // 圣遗物词条明细
  const detail = []
  const artis = profile.artis?.artis || {}
  let idx = 0
  for (const key of Object.keys(artis)) {
    const arti = artis[key]
    if (!arti) continue
    const mark = artisMark.artis?.[key] || {}
    const item = {
      artifacts_name: arti.name || '',
      artifacts_type: ARTI_POS[idx] || '',
      level: num(arti.level),
      maintips: ATTR_CN[arti.main?.key] || '',
      mainvalue: String(mark.main?.value ?? '').replace(/,/g, ''),
    }
    const attrs = arti.attrs || []
    attrs.forEach((sub, i) => {
      const value = String(mark.attrs?.[i]?.value ?? '').replace(/,/g, '')
      item[`tips${i + 1}`] = `${ATTR_CN[sub.key] || ''}+${value}`
    })
    detail.push(item)
    idx++
  }
  data.artifacts_detail = detail
  return data
}

/** getArtisMark() 偶尔会因面板数据缺字段抛错，兜一下 */
function safeArtisMark(profile) {
  try {
    return profile.getArtisMark() || {}
  } catch (_) {
    return {}
  }
}

/**
 * miao profile → 出图用的角色面板
 * 与 role_data 分开：出图要图标路径、评分、套装件数这些接口不返回的东西。
 */
export function profileToPanel(profile) {
  const attr = profile.attr || {}
  const artisMark = safeArtisMark(profile)
  const talent = profile.talent || {}

  const mkSkill = (key, iconPrefix) => {
    const t = talent[key] || {}
    return {
      icon: `${iconPrefix}_${profile.char?.name}`,
      level: num(t.level) || 1,
      originLvl: num(t.original) || 0,
      style: num(t.level) > num(t.original) ? 'extra' : '',
    }
  }

  return {
    id: profile.char?.id,
    name: profile.char?.name,
    star: profile.char?.star || 5,
    element: ELEM_CN[profile.elem] || '',
    elemKey: profile.elem,
    cons: num(profile.cons),
    level: num(profile.level),
    weapon: {
      name: profile.weapon?.name || '',
      rarity: num(profile.weapon?.star) || 4,
      affix: num(profile.weapon?.affix) || 1,
      level: num(profile.weapon?.level) || 90,
      type: profile.weapon?.type || '',
      imgPath: `${profile.weapon?.type || ''}/${profile.weapon?.name || ''}`,
    },
    fightProp: {
      暴击率: num(attr.cpct),
      暴击伤害: num(attr.cdmg),
      生命值: num(attr.hp),
      攻击力: num(attr.atk),
      防御力: num(attr.def),
      元素精通: num(attr.mastery),
      治疗加成: num(attr.heal),
      元素充能效率: num(attr.recharge),
    },
    skills: {
      a: mkSkill('a', 'Skill_A'),
      e: mkSkill('e', 'Skill_S'),
      q: mkSkill('q', 'Skill_E'),
    },
    relicSet: artisMark.sets || {},
  }
}
