/**
 * 体力阈值推送
 *
 * 每个用户在群里各自设定「体力阈值」，体力恢复到该值(含)以上时，
 * 机器人在该群 @用户 并发一张体力立绘卡片（复用 TL 的查询与出图）。
 *
 * - 原神 / 星铁 / 绝区零 / 鸣潮分开指令、分开阈值、分开推送
 *   · 原神看「原粹树脂」(current_resin)
 *   · 星铁看「开拓力」(current_stamina)
 *   · 绝区零看「电量」(energy.progress.current)
 *   · 鸣潮看「结晶波片」(current_stamina)，数据走库街区（凭证借 gsuid_core 鸣潮插件），
 *     需锅巴先打开「启用鸣潮体力」
 * - 仅在群里 @ 提醒
 * - 达到阈值只 @ 一次；体力回落到阈值以下后自动重新武装，下次满足再提醒
 * - 两种监控范围：
 *   · 主号推送（默认）：只盯当前主 UID
 *   · 全推送：盯该游戏下绑定的全部 UID，每个号各自独立提醒（「全id推送」为兼容别名）
 *
 * 指令（群聊内，谁发就绑定谁；「开启/打开」前缀可省，关闭词前置后置都认）：
 *   #原神体力推送 130      —— 主 UID 原粹树脂达到 130 时提醒
 *   #星铁体力推送 200      —— 主 UID 开拓力达到 200 时提醒
 *   #绝区零体力推送 220    —— 主 UID 电量达到 220 时提醒
 *   #开启鸣潮体力推送 200  —— 主 UID 结晶波片达到 200 时提醒
 *   #原神体力全推送 130    —— 全部原神 UID 各自达到 130 时分别提醒
 *   #星铁体力全推送 200
 *   #绝区零体力全推送 220
 *   #鸣潮体力全推送 200
 *   #原神体力推送关闭 / #原神体力全推送关闭
 *   #星铁体力推送关闭 / #星铁体力全推送关闭
 *   #绝区零体力推送关闭 / #绝区零体力全推送关闭
 *   #关闭鸣潮体力推送 / #鸣潮体力全推送关闭
 *   #体力推送列表          —— 查看自己的订阅
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { TL } from './TL.js'
import { createUser } from '../utils/userBind.js'
import { config, getRenderScaleStyle, pluginDir } from '../utils/pluginConfig.js'
import { listWavesAccounts, fetchWavesStamina, isWavesTlEnabled, getWavesEnvError } from '../utils/wavesData.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { registerReminderHooks, scheduleTimers, refreshUidTimers, timerStats, timerSnapshot, evaluateSnapshot } from '../utils/resinTimer.js'
import { guardModule } from '../utils/modules.js'

const DATA_DIR = path.join(pluginDir, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'resin_push.json')

const DEFAULT_CRON = '*/10 * * * *' // 每 10 分钟检查一次

// 各游戏元信息：名称、单位、阈值合法上限、当前值/上限取值函数
// zzz 电量嵌套在 energy.progress 下，故统一用取值函数抹平差异
// name: 指令里可用的游戏别名（正则片段）
const GAME_META = {
  gs: {
    label: '原神', name: '原神', unit: '原粹树脂', cap: 200, example: 130,
    getCur: (item) => Number(item?.current_resin) || 0,
    getMax: (item) => Number(item?.max_resin) || 0,
    hasField: (item) => item?.current_resin !== undefined && item?.current_resin !== null,
  },
  sr: {
    label: '星铁', name: '星铁', unit: '开拓力', cap: 300, example: 200,
    getCur: (item) => Number(item?.current_stamina) || 0,
    getMax: (item) => Number(item?.max_stamina) || 0,
    hasField: (item) => item?.current_stamina !== undefined && item?.current_stamina !== null,
  },
  zzz: {
    label: '绝区零', name: '绝区零|zzz', unit: '电量', cap: 240, example: 220,
    getCur: (item) => Number(item?.energy?.progress?.current) || 0,
    getMax: (item) => Number(item?.energy?.progress?.max) || 0,
    hasField: (item) => item?.energy?.progress?.current !== undefined && item?.energy?.progress?.current !== null,
  },
  // 鸣潮不走米游社：账号/凭证读 gsuid_core 鸣潮插件的库，体力直接问库街区
  ww: {
    label: '鸣潮', name: '鸣潮|mc', unit: '结晶波片', cap: 240, example: 200,
    getCur: (item) => Number(item?.current_stamina) || 0,
    getMax: (item) => Number(item?.max_stamina) || 0,
    hasField: (item) => item?.current_stamina !== undefined && item?.current_stamina !== null,
  },
}

const GAMES = ['gs', 'sr', 'zzz', 'ww']

// 指令正则：「开启/打开」前缀可省，关闭词前置（#关闭鸣潮体力推送）后置（#鸣潮体力推送关闭）都认
const setReg = (game, all) =>
  `^\\s*#?(?:开启|打开)?(?:${GAME_META[game].name})体力${all ? '全(?:id)?' : ''}推送\\s*(\\d{1,3})\\s*$`
const offReg = (game, all) => {
  const body = `(?:${GAME_META[game].name})体力${all ? '全(?:id)?' : ''}推送`
  return `^\\s*#?(?:(?:关闭|关掉|取消|停止)${body}|${body}\\s*(?:关闭|关|取消|停止))\\s*$`
}

// 「全id推送」为每个游戏独立的一套订阅：监控该 QQ 名下所有绑定 UID，
// 每个 UID 各自记录 armed 状态（达到阈值只提醒一次，回落后自动重新武装）。
// 存储键：gs_all / sr_all / zzz_all
const ALL_KEY = (game) => `${game}_all`

// ============ 配置读写 ============
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

/**
 * 结构：
 * {
 *   // 主 UID 推送（只监控该 QQ 该游戏的主 UID）
 *   gs:  { "<qq>": { threshold: 130, group: "123", armed: true } },
 *   sr:  { "<qq>": { threshold: 200, group: "123", armed: true } },
 *   zzz: { "<qq>": { threshold: 220, group: "123", armed: true } },
 *   // 全 id 推送（监控该 QQ 该游戏名下所有绑定 UID，各 UID 独立 armed）
 *   gs_all:  { "<qq>": { threshold: 130, group: "123", uids: { "<uid>": { armed: true } } } },
 *   sr_all:  { ... },
 *   zzz_all: { ... }
 * }
 */
function loadSubs() {
  const empty = () => {
    const o = {}
    for (const g of GAMES) {
      o[g] = {}
      o[ALL_KEY(g)] = {}
    }
    return o
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
      const subs = {}
      for (const g of GAMES) {
        subs[g] = data[g] || {}
        subs[ALL_KEY(g)] = data[ALL_KEY(g)] || {}
      }
      return subs
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 读取配置失败: ${err.message}`)
  }
  return empty()
}

function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 保存配置失败: ${err.message}`)
  }
}

// ============ 插件 ============
export class resinPush extends plugin {
  constructor() {
    const cfg = config()
    const cron = cfg.resin_push_cron || DEFAULT_CRON

    super({
      name: '[小火花]体力阈值推送',
      dsc: '体力达到阈值自动@提醒',
      event: 'message',
      priority: -Infinity,
      rule: [
        // 全推送（关闭）— 需在「主 UID 推送」之前匹配，避免被通用式吞掉；「全id」保留为兼容别名
        { reg: offReg('gs', true), fnc: 'offGsAll' },
        { reg: offReg('sr', true), fnc: 'offSrAll' },
        { reg: offReg('zzz', true), fnc: 'offZzzAll' },
        { reg: offReg('ww', true), fnc: 'offWwAll' },
        // 全推送（设置）
        { reg: setReg('gs', true), fnc: 'setGsAll' },
        { reg: setReg('sr', true), fnc: 'setSrAll' },
        { reg: setReg('zzz', true), fnc: 'setZzzAll' },
        { reg: setReg('ww', true), fnc: 'setWwAll' },
        // 主 UID 推送（关闭）
        { reg: offReg('gs', false), fnc: 'offGs' },
        { reg: offReg('sr', false), fnc: 'offSr' },
        { reg: offReg('zzz', false), fnc: 'offZzz' },
        { reg: offReg('ww', false), fnc: 'offWw' },
        // 主 UID 推送（设置）
        { reg: setReg('gs', false), fnc: 'setGs' },
        { reg: setReg('sr', false), fnc: 'setSr' },
        { reg: setReg('zzz', false), fnc: 'setZzz' },
        { reg: setReg('ww', false), fnc: 'setWw' },
        { reg: '^\\s*#?(?:开启|打开)?(?:原神|星铁|绝区零|zzz|鸣潮|mc)?体力全?(?:id)?推送\\s*$', fnc: 'usage' },
        { reg: '^\\s*#?体力推送(?:列表|状态|查询)\\s*$', fnc: 'listSubs' },
      ],
    })

    if (cfg.resin_push_enable !== false) {
      this.task = {
        name: 'xhh-TL-体力阈值推送',
        cron,
        fnc: () => this.checkAll(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }

    // 参量质变仪 / 洞天宝钱到期提醒：把「发给谁、怎么发」注册给定时器模块，
    // 并重挂上次运行（含重启前）还没到期的定时器。数据由 TL 查询时喂给该模块。
    registerReminderHooks({
      targets: (game, uid) => this.reminderTargets(game, uid),
      send: (info) => this.sendReminder(info),
      verify: (info) => this.verifyReminder(info),
    })
    scheduleTimers()
  }

  // -------- 指令：设置 --------
  async setGs(e) {
    return this._set(e, 'gs')
  }

  async setSr(e) {
    return this._set(e, 'sr')
  }

  async setZzz(e) {
    return this._set(e, 'zzz')
  }

  async setWw(e) {
    return this._set(e, 'ww')
  }

  // -------- 指令：设置（全 id 推送）--------
  async setGsAll(e) {
    return this._setAll(e, 'gs')
  }

  async setSrAll(e) {
    return this._setAll(e, 'sr')
  }

  async setZzzAll(e) {
    return this._setAll(e, 'zzz')
  }

  async setWwAll(e) {
    return this._setAll(e, 'ww')
  }

  /** 功能总开关：锅巴里关闭 resin_push_enable 时，所有指令一并停用 */
  _pushDisabled(e) {
    if (config().resin_push_enable === false) {
      e.reply('体力推送功能已被管理员关闭~', quoteEnabled())
      return true
    }
    return false
  }

  /** 鸣潮专用前置校验：锅巴总开关 + gsuid_core 里是否有可用凭证。通过返回 null，否则返回提示文案 */
  async _wavesGuard(qq) {
    if (!isWavesTlEnabled()) {
      return '鸣潮体力未启用，请让管理员在锅巴「小火花体力小组件」里打开「启用鸣潮体力」'
    }
    if (!(await listWavesAccounts(qq)).length) {
      const envErr = getWavesEnvError()
      if (envErr) return `鸣潮体力暂时不可用，请稍后重试`
      return '没有可用的鸣潮账号，请先发「w登录」登录鸣潮后再开启推送~'
    }
    return null
  }

  /** 查询失败（返回字符串/false）时的用户提示；鸣潮不走米游社，文案单独一套 */
  _queryErrText(game, item) {
    const meta = GAME_META[game]
    if (game === 'ww') {
      if (item === '没有') {
        return '没有可用的鸣潮账号，请先发「w登录」登录鸣潮后再开启推送~'
      }
      return `鸣潮体力查询失败，请重新「w登录」后再试~`
    }
    if (item === '没有') {
      return `你还没有绑定${meta.label}账号，请先【#扫码登录】米游社后再开启体力推送~`
    }
    if (item === '过期') {
      return `你的${meta.label}米游社登录已过期，请【#刷新ck】，仍不行则【#扫码登录】后再开启体力推送~`
    }
    return `查询${meta.label}体力失败，请稍后再试~`
  }

  async _set(e, game) {
    if (this._pushDisabled(e)) return true
    const meta = GAME_META[game]
    if (!e.isGroup) {
      e.reply('体力推送只能在群里设置哦，请在需要接收提醒的群内发送该指令~', quoteEnabled())
      return true
    }
    const m = (e.msg || '').match(/(\d{1,3})/)
    const threshold = m ? Number(m[1]) : NaN
    if (!Number.isFinite(threshold) || threshold <= 0) {
      e.reply(`请带上阈值，例如：#${meta.label}体力推送 ${meta.example}`, quoteEnabled())
      return true
    }
    if (threshold > meta.cap) {
      e.reply(`阈值过大啦，${meta.unit}最多设到 ${meta.cap}`, quoteEnabled())
      return true
    }
    if (game === 'ww') {
      const guard = await this._wavesGuard(e.user_id)
      if (guard) {
        e.reply(guard, quoteEnabled())
        return true
      }
    }

    // 开启前先校验：必须真能查到自己该游戏的体力（已#扫码登录 stoken）才允许订阅，
    // 否则要么根本没绑（不该推送），要么会被兜底 CK 顶成别人的号（串号）。
    let item
    try {
      item = await this.queryItem(new TL(), game, { qq: e.user_id, groupId: e.group_id, e })
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 设置校验查询失败 ${e.user_id}: ${err.message}`)
      e.reply('查询体力失败，请稍后再试~', quoteEnabled())
      return true
    }
    if (!item || typeof item === 'string') {
      e.reply(this._queryErrText(game, item), quoteEnabled())
      return true
    }
    if (!meta.hasField(item)) {
      e.reply(`暂时查不到你的${meta.unit}，请确认已正确绑定后再试~`, quoteEnabled())
      return true
    }

    const subs = loadSubs()
    // 主号推送与全推送互斥：同游戏两者同开会让主 UID 被两条循环各推一次（重复@发图）。
    // 开主号推送即清掉该游戏的全推送订阅。
    const hadAll = !!subs[ALL_KEY(game)][String(e.user_id)]
    delete subs[ALL_KEY(game)][String(e.user_id)]
    subs[game][String(e.user_id)] = {
      threshold,
      group: String(e.group_id),
      // uid 供「质变仪/洞天宝钱到期提醒」反查订阅者用（该提醒按账号定时，得知道发回哪个群）
      uid: String(item.uid || ''),
      armed: true,
    }
    saveSubs(subs)
    // 订阅变更 → 该账号的到期提醒定时器可能刚有主（或换了群），立刻重算一次
    if (game === 'gs') {
      try { refreshUidTimers('gs', item.uid) } catch (_) {}
    }
    e.reply(
      `✅ 已开启${meta.label}体力推送\n当${meta.unit} ≥ ${threshold} 时，会在本群@你并发送体力图\n（达到后只提醒一次，回落后自动重新监控）${hadAll ? `\n（已自动关闭原${meta.label}体力全推送）` : ''}`,
      true,
    )
    return true
  }

  /** 全 id 推送：监控该 QQ 名下所有绑定 UID，每个 UID 各自到阈值各自 @ 一次 */
  async _setAll(e, game) {
    if (this._pushDisabled(e)) return true
    const meta = GAME_META[game]
    if (!e.isGroup) {
      e.reply('体力推送只能在群里设置哦，请在需要接收提醒的群内发送该指令~', quoteEnabled())
      return true
    }
    const m = (e.msg || '').match(/(\d{1,3})/)
    const threshold = m ? Number(m[1]) : NaN
    if (!Number.isFinite(threshold) || threshold <= 0) {
      e.reply(`请带上阈值，例如：#${meta.label}体力全推送 ${meta.example}`, quoteEnabled())
      return true
    }
    if (threshold > meta.cap) {
      e.reply(`阈值过大啦，${meta.unit}最多设到 ${meta.cap}`, quoteEnabled())
      return true
    }
    if (game === 'ww') {
      const guard = await this._wavesGuard(e.user_id)
      if (guard) {
        e.reply(guard, quoteEnabled())
        return true
      }
    }

    // 枚举该 QQ 该游戏名下所有绑定 UID，逐个校验能否查到体力（已#扫码登录 stoken）
    // 鸣潮的账号列表来自 gsuid_core 鸣潮插件的库，不走米游社绑定
    const tl = new TL()
    let uidList
    try {
      if (game === 'ww') {
        uidList = (await listWavesAccounts(e.user_id)).map((a) => String(a.uid)).filter(Boolean)
      } else {
        const noteUser = await createUser(e.user_id, e)
        uidList = (noteUser.getUidList(game) || []).map((x) => String(x.uid || x)).filter(Boolean)
      }
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 全id枚举失败 ${e.user_id}: ${err.message}`)
      e.reply('查询绑定 UID 失败，请稍后再试~', quoteEnabled())
      return true
    }
    if (!uidList.length) {
      e.reply(this._queryErrText(game, '没有'), quoteEnabled())
      return true
    }

    const validUids = []
    for (const uid of uidList) {
      try {
        const item = await this.queryItem(tl, game, { qq: e.user_id, groupId: e.group_id, uid, e })
        if (item && typeof item !== 'string' && meta.hasField(item)) {
          validUids.push(uid)
        }
      } catch (err) {
        logger?.error?.(`[xhh-TL][体力推送] 全id校验 ${uid} 失败: ${err.message}`)
      }
    }
    if (!validUids.length) {
      e.reply(
        game === 'ww'
          ? '暂时查不到你的鸣潮体力，请重新「w登录」后再试'
          : `暂时查不到你的${meta.label}体力，请试【#刷新ck】，仍不行则【#扫码登录】`,
        true,
      )
      return true
    }

    const subs = loadSubs()
    // 与主号推送互斥：开全推送即清掉该游戏的主号推送订阅（主 UID 已含在全推送里）。
    const hadMain = !!subs[game][String(e.user_id)]
    delete subs[game][String(e.user_id)]
    const uids = {}
    for (const uid of validUids) uids[uid] = { armed: true }
    subs[ALL_KEY(game)][String(e.user_id)] = {
      threshold,
      group: String(e.group_id),
      uids,
    }
    saveSubs(subs)
    // 订阅变更 → 重算这些账号的到期提醒定时器（全推送已存 uids，无需额外字段）
    if (game === 'gs') {
      try { scheduleTimers() } catch (_) {}
    }
    e.reply(
      `✅ 已开启${meta.label}体力全推送（共 ${validUids.length} 个 UID）\n任一 UID 的${meta.unit} ≥ ${threshold} 时，会在本群@你并发送该 UID 的体力图\n（每个 UID 达到后各提醒一次，回落后自动重新监控）${hadMain ? `\n（已自动关闭原${meta.label}体力推送）` : ''}`,
      true,
    )
    return true
  }

  // -------- 指令：关闭 --------
  async offGs(e) {
    return this._off(e, 'gs')
  }

  async offSr(e) {
    return this._off(e, 'sr')
  }

  async offZzz(e) {
    return this._off(e, 'zzz')
  }

  async offWw(e) {
    return this._off(e, 'ww')
  }

  async offGsAll(e) {
    return this._offAll(e, 'gs')
  }

  async offSrAll(e) {
    return this._offAll(e, 'sr')
  }

  async offZzzAll(e) {
    return this._offAll(e, 'zzz')
  }

  async offWwAll(e) {
    return this._offAll(e, 'ww')
  }

  async _off(e, game) {
    const meta = GAME_META[game]
    const subs = loadSubs()
    const qq = String(e.user_id)
    if (subs[game][qq]) {
      delete subs[game][qq]
      saveSubs(subs)
      // 关订阅后该账号可能已无人订阅 → 重算，清掉空转的到期提醒定时器
      if (game === 'gs') {
        try { scheduleTimers() } catch (_) {}
      }
      e.reply(`已关闭${meta.label}体力推送`, quoteEnabled())
    } else {
      e.reply(`你还没有开启${meta.label}体力推送`, quoteEnabled())
    }
    return true
  }

  async _offAll(e, game) {
    const meta = GAME_META[game]
    const subs = loadSubs()
    const qq = String(e.user_id)
    const key = ALL_KEY(game)
    if (subs[key][qq]) {
      delete subs[key][qq]
      saveSubs(subs)
      if (game === 'gs') {
        try { scheduleTimers() } catch (_) {}
      }
      e.reply(`已关闭${meta.label}体力全推送`, quoteEnabled())
    } else {
      e.reply(`你还没有开启${meta.label}体力全推送`, quoteEnabled())
    }
    return true
  }

  // -------- 指令：用法 --------
  async usage(e) {
    if (this._pushDisabled(e)) return true
    // 只打了游戏名没带阈值（如 #开启鸣潮体力推送）时，直接给该游戏的示例，省得自己去菜单里找
    const hit = GAMES.find((g) => new RegExp(`(?:${GAME_META[g].name})体力`).test(e.msg || ''))
    if (hit) {
      const meta = GAME_META[hit]
      const isAll = /全(?:id)?推送/.test(e.msg || '')
      e.reply(
        `请带上阈值，例如：#${meta.label}体力${isAll ? '全' : ''}推送 ${meta.example}` +
          `（${meta.unit}上限 ${meta.cap}）\n关闭：#${meta.label}体力${isAll ? '全' : ''}推送关闭`,
        true,
      )
      return true
    }
    e.reply(
      [
        '📌 体力阈值推送用法',
        '#原神体力推送 130   原粹树脂达到130时@你并发图',
        '#星铁体力推送 200   开拓力达到200时@你并发图',
        '#绝区零体力推送 220 电量达到220时@你并发图',
        '#鸣潮体力推送 200   结晶波片达到200时@你并发图（需先在锅巴开「启用鸣潮体力」）',
        '#原神体力全推送 130   监控名下所有原神UID，各自达标各自发图',
        '（星铁/绝区零/鸣潮同理：#星铁体力全推送 200 / #绝区零体力全推送 220 / #鸣潮体力全推送 200）',
        '关闭：#原神体力推送关闭（或 #关闭原神体力推送），星铁/绝区零/鸣潮同理',
        '#原神体力全推送关闭 / #星铁体力全推送关闭 / #绝区零体力全推送关闭 / #鸣潮体力全推送关闭',
        '#体力推送列表        查看你的订阅',
        '（需在群里设置，仅在该群@提醒；达到后提醒一次，回落后自动恢复监控）',
      ].join('\n'),
      true,
    )
    return true
  }

  // -------- 指令：列表 --------
  async listSubs(e) {
    const subs = loadSubs()
    const qq = String(e.user_id)
    const lines = ['📋 你的体力推送订阅：']
    let has = false
    for (const game of GAMES) {
      const meta = GAME_META[game]
      const sub = subs[game][qq]
      if (sub) {
        has = true
        lines.push(
          `· ${meta.label}：${meta.unit} ≥ ${sub.threshold}（群 ${sub.group}）${sub.armed ? '' : ' [已提醒，待回落]'}`,
        )
        // 原神额外展示质变仪/洞天宝钱的到期提醒状态
        if (game === 'gs') {
          const tip = this._timerTip(sub.uid)
          if (tip) lines.push(`  ${tip}`)
        }
      }
      const allSub = subs[ALL_KEY(game)][qq]
      if (allSub) {
        has = true
        const uidEntries = Object.entries(allSub.uids || {})
        const armedCnt = uidEntries.filter(([, u]) => u.armed).length
        lines.push(
          `· ${meta.label}[全推送]：${meta.unit} ≥ ${allSub.threshold}（群 ${allSub.group}，${uidEntries.length} 个UID，${armedCnt} 个监控中）`,
        )
      }
    }
    if (!has) lines.push('（暂无，发送 #原神体力推送 130 试试）')
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  // ============ 定时检查 ============
  async checkAll() {
    const cfg = config()
    if (cfg.resin_push_enable === false) return
    const subs = loadSubs()

    // 只收集本轮的 armed 翻转，末尾重新 loadSubs 做字段级合并写回，
    // 避免长循环期间用户改订阅（关闭/改阈值，独立落盘）被旧快照整体覆盖。
    // 直接订阅：{ key, qq, armed }；全 id：{ key, qq, uid, armed }
    const armedChanges = []
    // 老订阅没有 uid 字段（到期提醒反查订阅者要用），本轮拿到真实 uid 后补上
    const uidChanges = []
    const scale = getRenderScaleStyle(cfg, 1.0)
    const tl = new TL()

    // 同一轮去重：同一 QQ 的同一真实账号只推一次。
    // 「主号推送」监控主 UID，「全推送」监控名下全部 UID（必然含主 UID），
    // 两者同开时主 UID 会被两条循环各推一次 → 重复@发图。
    // key 用 qq+game+真实账号：优先 item._ownerSid（凭证属主 stuid，由 TL.note 挂载），
    // 缺失时退回请求 UID 保持旧行为。用属主而非请求 UID 是因为原神体力 widget 接口
    // 不带 uid、只认 stoken 所属账号——全推送里两个不同 UID 若选到同一把凭证，
    // 拿到的其实是同一个账号的体力，按请求 UID 判重永远撞不上。
    // 不同 QQ 共用同一账号时仍各自@（key 含 qq，互不影响）。
    const pushedUids = new Set()
    const pushKey = (qq, game, id) => `${qq}:${game}:${id}`
    const realId = (item, fallbackUid) => String(item?._ownerSid || fallbackUid)

    for (const game of GAMES) {
      const meta = GAME_META[game]
      // 鸣潮总开关（锅巴「启用鸣潮体力」）关掉时整段跳过，免得每轮白读一遍 core 的库
      if (game === 'ww' && !isWavesTlEnabled()) continue
      for (const qq of Object.keys(subs[game])) {
        const sub = subs[game][qq]
        if (!sub || !sub.group) continue
        try {
          const item = await this.queryItem(tl, game, { qq, groupId: sub.group })
          // 字符串一律是错误说明（'没有'/'过期'/鸣潮的接口报错），本轮跳过不动 armed
          if (!item || typeof item === 'string') continue

          // 老订阅回填 uid（供到期提醒反查订阅者），拿到真实 uid 就补一次
          const realUid = String(item.uid || '')
          if (game === 'gs' && realUid && String(sub.uid || '') !== realUid) {
            sub.uid = realUid
            uidChanges.push({ game, qq, uid: realUid })
          }

          const cur = meta.getCur(item)

          // 回落到阈值以下 → 重新武装
          if (cur < sub.threshold) {
            if (!sub.armed) {
              sub.armed = true
              armedChanges.push({ key: game, qq, armed: true })
            }
            continue
          }

          // 达到阈值且仍处于武装状态 → 推送一次
          if (sub.armed) {
            const ok = await this.pushOne(tl, qq, game, sub, item, scale)
            if (ok) {
              // 主号推送先跑：标记该真实账号已推，后面全推送循环遇到同账号直接跳过
              pushedUids.add(pushKey(qq, game, realId(item, item.uid)))
              sub.armed = false
              armedChanges.push({ key: game, qq, armed: false })
            }
          }
        } catch (err) {
          logger?.error?.(`[xhh-TL][体力推送] ${meta.label} ${qq} 检查失败: ${err.message}`)
        }
      }

      // 全 id 推送：逐个 UID 独立判断/武装/推送
      const allSubs = subs[ALL_KEY(game)]
      for (const qq of Object.keys(allSubs)) {
        const allSub = allSubs[qq]
        if (!allSub || !allSub.group || !allSub.uids) continue
        for (const uid of Object.keys(allSub.uids)) {
          const state = allSub.uids[uid]
          if (!state) continue
          try {
            const item = await this.queryItem(tl, game, { qq, groupId: allSub.group, uid })
            if (!item || typeof item === 'string') continue

            const cur = meta.getCur(item)

            // 回落到阈值以下 → 重新武装
            if (cur < allSub.threshold) {
              if (!state.armed) {
                state.armed = true
                armedChanges.push({ key: ALL_KEY(game), qq, uid, armed: true })
              }
              continue
            }

            // 达到阈值且仍处于武装状态 → 推送一次
            if (state.armed) {
              // 同一 QQ 的该真实账号本轮已被「主号推送」推过 → 跳过，避免重复@发图。
              // 仍照常把 armed 置 false 落盘，行为与推送后一致（回落再重新武装），
              // 否则每轮都会尝试推一次、每轮被拦，状态永远停在 armed。
              const rid = realId(item, uid)
              if (pushedUids.has(pushKey(qq, game, rid))) {
                state.armed = false
                armedChanges.push({ key: ALL_KEY(game), qq, uid, armed: false })
                continue
              }
              const ok = await this.pushOne(tl, qq, game, allSub, item, scale, uid)
              if (ok) {
                pushedUids.add(pushKey(qq, game, rid))
                state.armed = false
                armedChanges.push({ key: ALL_KEY(game), qq, uid, armed: false })
              }
            }
          } catch (err) {
            logger?.error?.(`[xhh-TL][体力推送] ${meta.label}[全id] ${qq}/${uid} 检查失败: ${err.message}`)
          }
        }
      }
    }

    // 写回前重新读盘做字段级合并：本轮长循环期间用户可能已改/删订阅（各自独立落盘），
    // 只把本轮算出的 armed 变更合并进最新文件，且跳过已被删除的 key，避免旧快照整体覆写丢更新
    if (armedChanges.length || uidChanges.length) {
      const latest = loadSubs()
      for (const c of armedChanges) {
        if (c.uid) {
          // 全 id 订阅：定位到 uids[uid].armed
          const node = latest[c.key]?.[c.qq]
          if (node?.uids?.[c.uid]) node.uids[c.uid].armed = c.armed
        } else {
          // 单 UID 订阅
          const node = latest[c.key]?.[c.qq]
          if (node) node.armed = c.armed
        }
      }
      // 老订阅回填 uid（同上，只补字段，不动其他）
      for (const c of uidChanges) {
        const node = latest[c.game]?.[c.qq]
        if (node) node.uid = c.uid
      }
      saveSubs(latest)
    }

    // 每轮收尾重算到期提醒定时器：兜住「刚打开总开关」「老订阅刚回填 uid」
    // 「用户刚订阅」等情况，最迟 10 分钟内自动跟上
    try { scheduleTimers() } catch (err) {
      logger?.debug?.(`[xhh-TL][到期提醒] 重算定时器失败: ${err?.message}`)
    }
  }

  /**
   * 查一个订阅目标的体力
   * - gs/sr/zzz：走 TL.note（定时场景用「假 e + Runtime」，uid 为空即主 UID）
   * - ww：不走米游社，凭证读 gsuid_core 鸣潮插件的库后直接问库街区
   * @param {object} opts { qq, groupId, uid 指定 UID（全推送用）, e 交互场景传真实事件 }
   * @returns {Promise<object|string|false>} item，或错误说明字符串
   */
  async queryItem(tl, game, { qq, groupId, uid = null, e = null } = {}) {
    if (game === 'ww') return this.queryWaves(qq, uid)
    const ev = e || this.makeFakeE(qq, groupId)
    // allowDetail=false：定时轮询不补拉「要额外打接口」的明细（原神质变仪走 dailyNote，
    // 该接口有风控且按 cron 反复打毫无意义）。明细只在用户主动查询时才发请求，
    // 这里仍会命中用户查询留下的 30 分钟缓存，所以推送图该有还是有。
    return tl.note(ev, game, true, null, uid, { allowDetail: false })
  }

  /** 鸣潮体力：uid 为空时取绑定列表第一个（主 UID）；返回 item 或错误说明字符串 */
  async queryWaves(qq, uid = null) {
    if (!isWavesTlEnabled()) return '鸣潮体力未启用'
    const accounts = await listWavesAccounts(qq)
    if (!accounts.length) return getWavesEnvError() || '没有'
    const acc = uid ? accounts.find((a) => String(a.uid) === String(uid)) : accounts[0]
    // 指定 UID 已从 core 的库里消失（解绑/换绑）→ 与「没绑」同处理，本轮跳过
    if (!acc) return '没有'
    const timeoutMs = Math.max(5, Number(config().waves_tl_timeout) || 15) * 1000
    return fetchWavesStamina(acc, timeoutMs)
  }

  /** 出图并在群里 @ 用户发送；forceUid 指定时用于日志/渲染定位（全 id 推送） */
  async pushOne(tl, qq, game, sub, item, scale, forceUid = null) {
    const meta = GAME_META[game]
    const fakeE = this.makeFakeE(qq, sub.group)

    // 轮询那一步只问了体力值本身（结果带 _detailSkipped 标记，见 TL.note），到真要出图
    // 了才补一次带明细的查询：等级昵称、活动日历、质变仪这几个额外接口只在推送时打一次。
    // 补不到就用手上的基础数据出图，别让整条推送栽在这一步。
    if (item?._detailSkipped && game !== 'ww') {
      try {
        const full = await tl.note(fakeE, game, true, null, forceUid)
        if (full && typeof full === 'object') item = full
      } catch (err) {
        logger?.debug?.(`[xhh-TL][体力推送] 补明细失败 ${qq}: ${err?.message}`)
      }
    }

    // 群昵称
    let qqname = String(qq)
    try {
      const member = fakeE.group?.pickMember?.(qq)
      if (member?.card || member?.nickname) qqname = member.card || member.nickname
    } catch (_) {}

    let imgSeg = null
    try {
      imgSeg = await tl.renderPortraitCard(fakeE, game, item, { qq, qqname }, scale)
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 渲染失败 ${qq}: ${err.message}`)
    }
    if (!imgSeg) return false

    const cur = meta.getCur(item)
    const max = meta.getMax(item)
    const full = max > 0 && cur >= max
    const tip = full
      ? `你的${meta.unit}已经满啦(${cur}/${max})，快去消耗吧~`
      : `你的${meta.unit}已达到 ${cur}${max ? '/' + max : ''}，别溢出啦~`

    try {
      const group = fakeE.group || Bot.pickGroup(Number(sub.group))
      await group.sendMsg([segment.at(Number(qq)), ` ${tip}\n`, imgSeg])
      // 带上 UID 与真实账号：多账号/全推送排查重复推送时，光有 QQ 分不清是哪个号。
      // uid=请求的 UID，sid=实际返回数据的凭证属主（两者不一致即说明选号串了）。
      const logUid = forceUid || item?.uid || '?'
      const sid = item?._ownerSid
      logger?.mark?.(
        `[xhh-TL][体力推送] 已推送 ${meta.label} 给 ${qq}@群${sub.group} uid=${logUid}${sid ? ` sid=${sid}` : ''}`,
      )
      return true
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 发送失败 ${qq}@群${sub.group}: ${err.message}`)
      return false
    }
  }

  // -------- 参量质变仪 / 洞天宝钱到期提醒 --------

  /**
   * 反查：这个真实账号（uid）有哪些人订阅了体力推送。
   * 同步纯读盘 —— 定时器到点时要立刻拿到，不能 await。
   * 同时覆盖「主号推送」（sub.uid 匹配）与「全推送」（sub.uids 里有该 uid）。
   * @returns {Array<{qq:string, group:string}>}
   */
  reminderTargets(game, uid) {
    if (game !== 'gs') return []
    const u = String(uid || '')
    if (!u) return []
    const subs = loadSubs()
    const out = []
    for (const qq of Object.keys(subs.gs)) {
      const sub = subs.gs[qq]
      if (!sub?.group) continue
      if (String(sub.uid || '') !== u) continue
      out.push({ qq, group: sub.group })
    }
    for (const qq of Object.keys(subs.gs_all)) {
      const sub = subs.gs_all[qq]
      if (!sub?.group || !sub.uids?.[u]) continue
      out.push({ qq, group: sub.group })
    }
    return out
  }

  /**
   * 到点复核：拿一份**此刻的真身**，确认该提醒是不是真的到了。
   *
   * 为什么非做不可：定时器的到点时刻是照 dailyNote 的倒计时字段算的，
   * 而洞天宝钱的 home_coin_recovery_time 会和实际库存脱钩 —— 实测 cur 卡在
   * 990/2400 一个多小时不动，倒计时却一秒不差地走向归零。照倒计时推送就是
   * 「没满却 @ 人说满了」（2026-09-30 04:08 那条假推送）。
   *
   * 复核走用户查询同一条路（带明细、跳过视图缓存），判据回到唯一可信的 cur>=max。
   *
   * ⚠️ 查询失败（风控 1034 / 凭证过期 / 网络抖动）**不等于「已满」**。
   * 早期这里对失败返回 null、上层按「放行发送」处理 —— 那是错的：查不到就用
   * 「我不知道」推出「满了」，跟这次 bug 是同一个毛病。现在失败时退回到
   * **记录里存的上次快照**判断：快照说没满就按它接着等，快照也说满了才放行。
   * 实在一点信息都没有（快照也没有）才返回 null。
   *
   * @returns {{ready:boolean, dueAt?:number|null, snap?:object}|null}
   *   null = 连兜底快照都没有，判不了（会退化成旧的「照倒计时发」行为）
   */
  async verifyReminder({ game, uid, type }) {
    if (game !== 'gs' || !uid) return null
    // 用订阅者本人去查：凭证是按 QQ+UID 选的，复核必须走同一条鉴权路径，
    // 否则拿到的可能是别人的号（原神 widget 不带 uid、只认 stoken 属主）。
    const targets = this.reminderTargets(game, uid)
    const t = targets[0]
    if (!t) return null

    let data = null
    try {
      const fakeE = this.makeFakeE(t.qq, t.group)
      // forceNoteDetail：连 30 分钟视图缓存也跳过。缓存里只有质变仪的 ok/text，
      // 没有洞天宝钱的 home_coin_recovery_time —— 命中缓存就和没复核一样。
      data = await new TL().note(fakeE, 'gs', true, null, uid, { forceNoteDetail: true })
    } catch (err) {
      logger?.debug?.(`[xhh-TL][到期提醒] 复核查询失败 ${uid}: ${err?.message}`)
      data = null
    }

    if (data && typeof data === 'object') {
      const evalAll = evaluateSnapshot(game, uid, data)
      const v = evalAll?.[type]
      if (v) return { ready: v.ready, dueAt: v.dueAt, snap: evalAll.snap }
      // 这份快照里没有该类信息（比如还没获得质变仪）→ 落到下面走兜底
    }

    // 查询没拿到有效信息 → 用记录里上次查询留下的快照兜底判断。
    // 它必然滞后，但判「满没满」够用：宝钱只会往上涨，旧快照说没满就是没满。
    const fallback = this.snapshotVerdict(uid, type)
    if (fallback) {
      logger?.debug?.(
        `[xhh-TL][到期提醒] 复核没拿到新数据，用记录快照判定 ${type} uid=${uid} → ${fallback.ready ? '放行' : '继续等'}`,
      )
    }
    return fallback
  }

  /**
   * 兜底判据：拿订阅记录里那份**上次查询的快照**判该提醒到没到。
   * 仅在复核查询失败时用（见 verifyReminder）。判不了返回 null。
   *
   * 判读逻辑直接复用 evaluateSnapshot —— 快照的结构和接口响应同源
   * （recordResinTimer 就是挑着存的这几个字段），没必要另写一套必然漂移的判据。
   */
  snapshotVerdict(uid, type) {
    let snap = null
    try {
      snap = timerSnapshot('gs', String(uid))
    } catch (_) {
      return null
    }
    if (!snap || typeof snap !== 'object') return null

    const evalAll = evaluateSnapshot('gs', String(uid), snap)
    const v = evalAll?.[type]
    if (!v) return null
    return { ready: v.ready, dueAt: v.dueAt, snap: evalAll.snap }
  }

  /**
   * 到期提醒：@用户 + 一张提醒卡（横幅 + 单条）。
   * 出图用的是记录里存下来的快照（见 resinTimer 的 dueAt 记录），不重查接口。
   *
   * ⚠️ 全部目标都失败时必须把错误抛出去，让 resinTimer.fire() 重试。
   * 典型场景是「重启补发」：scheduleTimers() 在插件构造期跑，那时适配器还没连上、
   * Bot 还是 undefined。这里若把异常吞掉，fire() 会以为发成功而落盘 fired，提醒就永久丢了。
   */
  async sendReminder({ uid, type, targets, item }) {
    const text =
      type === 'homeCoin'
        ? '你的洞天宝钱已经满啦，快去洞天里取一下吧~'
        : '你的参量质变仪已经可以再次使用啦，记得用掉~'
    let ok = 0
    let lastErr = null
    for (const t of targets) {
      try {
        // Bot 是宿主注入的全局量，适配器连上之前不存在 —— 给个明确的错，别抛 TypeError
        if (typeof Bot === 'undefined' || !Bot?.pickGroup) throw new Error('适配器尚未连接')
        const group = Bot.pickGroup(Number(t.group))
        const fakeE = this.makeFakeE(t.qq, t.group)
        let imgSeg = null
        try {
          imgSeg = await new TL().renderRemindCard(fakeE, {
            type,
            item,
            displayInfo: { qq: t.qq, qqname: String(t.qq) },
          })
        } catch (err) {
          logger?.error?.(`[xhh-TL][到期提醒] 出图失败 ${type}: ${err.message}`)
        }
        // 顺序：@ → 图 → 文案。文案固定放图下面（主人明确要求，别再放上面）。
        // 文案前不加换行：图片是独立块，QQ 自己就会换行，再加 \n 会多空出一行。
        const segs = [segment.at(Number(t.qq))]
        if (imgSeg) segs.push('\n', imgSeg)
        segs.push(text)
        await group.sendMsg(segs)
        ok++
        logger?.mark?.(`[xhh-TL][到期提醒] 已提醒 ${type} uid=${uid} → ${t.qq}@群${t.group}${imgSeg ? '' : '（无图）'}`)
      } catch (err) {
        lastErr = err
        logger?.error?.(`[xhh-TL][到期提醒] 发送失败 ${t.qq}@群${t.group}: ${err.message}`)
      }
    }
    // 一个都没发出去 → 抛给 fire() 重试（别让提醒静默消失）
    if (!ok && lastErr) throw lastErr
  }

  /** 「体力推送列表」里附一行到期提醒状态；没记录/无 uid 时返回空串 */
  _timerTip(uid) {
    if (!uid) return ''
    let stats = null
    try { stats = timerStats('gs', uid) } catch (_) { return '' }
    if (!stats) return ''
    const fmt = (st) => {
      if (!st) return null
      if (st.state === 'fired') return '已提醒'
      if (!st.dueAt || st.dueAt <= Date.now()) return '即将提醒'
      return new Date(st.dueAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    const parts = []
    const tf = fmt(stats.transformer)
    const hc = fmt(stats.homeCoin)
    if (tf) parts.push(`质变仪 ${tf}`)
    if (hc) parts.push(`洞天宝钱 ${hc}`)
    return parts.length ? `⏰ ${parts.join(' / ')}` : ''
  }

  /** 构造一个带 runtime、reply 无副作用的假事件，供 TL 查询/渲染复用 */
  makeFakeE(qq, groupId) {
    const bot = Bot
    let group = null
    try {
      group = bot.pickGroup?.(Number(groupId))
    } catch (_) {}
    const fakeE = {
      user_id: qq,
      self_id: bot?.uin,
      isGroup: true,
      group_id: groupId,
      group,
      message: [],
      msg: '',
      reply: () => {}, // 定时场景下吞掉内部提示，避免误发
      sender: { nickname: String(qq) },
    }
    fakeE.runtime = new Runtime(fakeE)
    return fakeE
  }
}

export default resinPush

/**
 * 关掉 resin_push_enable 后，全部体力推送订阅指令不再响应。
 * 定时检查任务本身在构造函数里已按同一个键决定要不要注册，这里只管指令入口。
 */
guardModule(resinPush, 'resin_push', [
  'offGsAll', 'offSrAll', 'offZzzAll', 'offWwAll',
  'setGsAll', 'setSrAll', 'setZzzAll', 'setWwAll',
  'offGs', 'offSr', 'offZzz', 'offWw',
  'setGs', 'setSr', 'setZzz', 'setWw',
  'usage', 'listSubs',
])
