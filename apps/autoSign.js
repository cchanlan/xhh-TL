/**
 * 米游社自动签到（原神 / 星铁 / 绝区零）
 *
 * - 用户 opt-in 订阅：发 #原神自动签到 后才纳入每日自动签，仿体力推送的显式订阅
 * - 手动签到：#原神签到 / #星铁签到 / #绝区零签到 —— 立即签一次并回报结果
 * - 每日 cron 定时按「订阅群」分组：一次性把该群所有订阅者、所有游戏签完，
 *   汇总成一张统计图发到群里（不再逐用户 @ 回报）
 * - 所有签到相关指令仅支持群内使用，私聊一律拒绝
 * - 签到走 utils/signClient.js（稳定 device_id + 真 device_fp），弹验证码概率低
 *
 * 指令（仅群内）：
 *   #原神签到 / #星铁签到 / #绝区零签到        立即签一次
 *   #原神自动签到 / #原神自动签到开启          开启每日自动签（星铁/绝区零同理）
 *   #原神自动签到关闭                          关闭
 *   #签到列表 / #自动签到列表                  查看自己的订阅
 */

import fs from 'fs'
import path from 'path'
import moment from 'moment'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { createUser } from '../utils/userBind.js'
import { resolveAuth } from '../utils/runtimePatch.js'
import { signOne, GAME_LABEL } from '../utils/signClient.js'
import { runBbsVerify, solveBatchByLocalService } from '../utils/mysVerify.js'
import LiteMysApi from '../utils/mysClient.js'
import { config, pluginDir, pickHelpBgImage, toFileUrl, toDataUrl } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'

const DATA_DIR = path.join(pluginDir, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'auto_sign.json')

// 默认凌晨随机分钟，避开整点风控高峰
const DEFAULT_CRON = '23 0 * * *'

const GAMES = ['gs', 'sr', 'zzz']

const GAME_ALIAS = {
  gs: '(?:原神|ys)',
  sr: '(?:星铁|崩铁|星穹铁道|xt)',
  zzz: '(?:绝区零|zzz)',
}

// 汇总图各游戏行图标（resources/help/icons 下的 logo）
const GAME_ICON = {
  gs: 'help/icons/gs-logo.webp',
  sr: 'help/icons/sr-logo.webp',
  zzz: 'help/icons/zzz.webp',
}

// ============ 配置读写 ============
// 结构：{ gs: { "<qq>": { group: "123"|"" } }, sr: {...}, zzz: {...} }
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

function loadSubs() {
  const empty = () => {
    const o = {}
    for (const g of GAMES) o[g] = {}
    return o
  }
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
      const subs = {}
      for (const g of GAMES) subs[g] = data[g] || {}
      return subs
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][自动签到] 读取配置失败: ${err.message}`)
  }
  return empty()
}

function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][自动签到] 保存配置失败: ${err.message}`)
  }
}

export class autoSign extends plugin {
  constructor() {
    const cfg = config()
    const cron = cfg.auto_sign_cron || DEFAULT_CRON

    super({
      name: '[小火花]米游社自动签到',
      dsc: '原神/星铁/绝区零 每日自动签到',
      event: 'message',
      priority: -Infinity,
      rule: [
        // 自动签到（关闭）— 先于开启匹配
        { reg: `^\\s*#?${GAME_ALIAS.gs}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}自动签到\\s*(?:关闭|关|取消|停止)\\s*$`, fnc: 'offZzz' },
        // 自动签到（开启）
        { reg: `^\\s*#?${GAME_ALIAS.gs}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}自动签到\\s*(?:开启|开|打开)?\\s*$`, fnc: 'onZzz' },
        // 立即签到
        { reg: `^\\s*#?${GAME_ALIAS.gs}签到\\s*$`, fnc: 'signGs' },
        { reg: `^\\s*#?${GAME_ALIAS.sr}签到\\s*$`, fnc: 'signSr' },
        { reg: `^\\s*#?${GAME_ALIAS.zzz}签到\\s*$`, fnc: 'signZzz' },
        // 手动过码（主动清风险；可带游戏名指定，默认原神）
        // # 必带：这条会真去打接口跑过码，不能让「过码」这种裸词在群里误触发
        { reg: `^\\s*#(?:${GAME_ALIAS.gs}|${GAME_ALIAS.sr}|${GAME_ALIAS.zzz})?(?:米游社验证|手动过码|过码)\\s*$`, fnc: 'manualVerify' },
        // 列表
        { reg: '^\\s*#?(?:自动)?签到(?:列表|状态|查询)\\s*$', fnc: 'listSubs' },
      ],
    })

    if (cfg.auto_sign_enable !== false) {
      this.task = {
        name: 'xhh-TL-米游社自动签到',
        cron,
        fnc: () => this.runAll(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  _disabled(e) {
    if (config().auto_sign_enable === false) {
      e.reply('自动签到功能已被管理员关闭~', quoteEnabled())
      return true
    }
    return false
  }

  // 签到相关指令一律不支持私聊：仅群内可用
  _groupOnly(e) {
    if (!e.isGroup) {
      e.reply('签到相关功能仅支持在群内使用，请到群里发送该指令~', quoteEnabled())
      return true
    }
    return false
  }

  // -------- 立即签到 --------
  async signGs(e) { return this._signNow(e, 'gs') }
  async signSr(e) { return this._signNow(e, 'sr') }
  async signZzz(e) { return this._signNow(e, 'zzz') }

  async _signNow(e, game) {
    if (this._groupOnly(e)) return true
    if (this._disabled(e)) return true
    const label = GAME_LABEL[game]
    const results = await this.signUserGame(e, e.user_id, game, e)
    if (!results.length) {
      e.reply(`你还没有绑定${label}账号，请先【#扫码登录】米游社~`, quoteEnabled())
      return true
    }
    const lines = [`${label}签到结果：`]
    for (const r of results) lines.push(`· ${r.uid}：${r.msg}`)
    if (results.some((r) => r.code === 'captcha')) {
      // 配了自动过码服务时，撞码的号已经自动处理过了，这里只说结果
      lines.push(
        config().auto_verify_addr
          ? `（撞验证码的号已自动处理，重发本条即可）`
          : `（撞验证码的号，发 #${label}过码 点链接手划一下，再重发本条）`,
      )
    }
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  // -------- 手动过码（主动清风险）--------
  // 不必等撞码，用户可主动跑一次过码清掉该设备风险分，之后签到更顺。
  // 从消息里识别游戏（默认原神）；对该游戏名下每个绑定 UID 逐个走过码。
  async manualVerify(e) {
    if (this._groupOnly(e)) return true
    if (this._disabled(e)) return true
    const verifyAddr = config().auto_sign_verify_addr || ''
    const autoAddr = config().auto_verify_addr || ''
    // 两个都没配才没得玩：自动服务是首选，手动打码地址是兜底
    if (!autoAddr && !verifyAddr) {
      e.reply('未配置过码服务，请主人到锅巴「米游社签到」里填上地址后再试~', quoteEnabled())
      return true
    }

    // 识别游戏：消息命中哪个别名就用哪个，默认 gs
    const msg = String(e.msg || '')
    let game = 'gs'
    for (const g of GAMES) {
      if (new RegExp(GAME_ALIAS[g]).test(msg)) { game = g; break }
    }
    const label = GAME_LABEL[game]

    // 枚举该游戏绑定 UID
    let uidList = []
    try {
      const user = await createUser(e.user_id, e)
      // 只取背后有登录凭证（ltuid / stuid）的 UID，与 _on、signUserGame 的过滤保持一致：
      // 仅「注册」过的 UID（type=reg，既无 ltuid 也无 stuid）没有 ck 可换，
      // 过码无从谈起；这类注册态还常是从别人名下带过来的，不能顺手替它过码。
      uidList = (user.getUidList(game) || [])
        .filter((x) => x && typeof x === 'object' && (x.ltuid || x.stuid))
        .map((x) => String(x.uid))
        .filter(Boolean)
    } catch (err) {
      logger?.error?.(`[xhh-TL][过码] 枚举 UID 失败 ${e.user_id}: ${err.message}`)
    }
    if (!uidList.length) {
      e.reply(`你还没有扫码登录${label}账号，请先【#扫码登录】米游社~`, quoteEnabled())
      return true
    }

    // 配了本地服务就是全自动，不用用户划；没配才提示看链接
    const auto = !!config().auto_verify_addr
    e.reply(
      auto
        ? `开始为${label} ${uidList.length} 个账号过码，请稍等~`
        : `开始为${label} ${uidList.length} 个账号过码，撞到验证时请按提示点链接手划~`,
      quoteEnabled(),
    )

    // 先把每个 UID 的凭证解出来（这步必须串行：resolveAuth 依赖 e 上的 uid）
    const accounts = []
    for (const uid of uidList) {
      try {
        const authE = Object.assign(
          Object.create(Object.getPrototypeOf(e) || Object.prototype), e, { uid },
        )
        const auth = await resolveAuth(authE, { needCookie: true, game })
        if (!auth?.ck || !/cookie_token|account_id=/.test(auth.ck)) {
          accounts.push({ uid, realUid: uid, err: '无有效登录，请【#刷新ck】，仍不行则【#扫码登录】' })
          continue
        }
        accounts.push({ uid, realUid: auth.uid || uid, ck: auth.ck })
      } catch (err) {
        logger?.error?.(`[xhh-TL][过码] ${e.user_id}/${uid} 取凭证异常: ${err.message}`)
        accounts.push({ uid, realUid: uid, err: '已知问题，稍后重试' })
      }
    }

    const lines = [`${label}过码结果：`]

    // 全自动：一次把所有账号交给服务并发跑（总耗时≈最慢那个号，不是逐个相加）
    const okMap = new Map()
    if (auto) {
      const valid = accounts.filter((a) => a.ck)
      if (valid.length) {
        const results = await solveBatchByLocalService(
          valid.map((a) => a.ck),
          config().auto_verify_addr,
        )
        valid.forEach((a, i) => okMap.set(a.realUid, !!results[i]))
      }
    }

    for (const a of accounts) {
      if (a.err) {
        lines.push(`· ${a.realUid}：${a.err}`)
        continue
      }
      // 全自动已跑过；没配服务或批量没成功，再回退到逐个（手动链接）流程
      let ok = okMap.get(a.realUid)
      if (ok === undefined || ok === false) {
        try {
          let device = ''
          let deviceFp = ''
          try {
            const api = new LiteMysApi(a.realUid, a.ck, { game, log: false })
            device = api.device
            const fpRes = await api.getData('getFp', { seed_id: String(Date.now()).slice(0, 16), Getfp: true })
            deviceFp = fpRes?.data?.device_fp || ''
          } catch (_) {}
          const r = await runBbsVerify(e, {
            uid: a.realUid,
            cookie: a.ck,
            game,
            device,
            deviceFp,
            verifyAddr,
            // 批量已失败过，这里不再走自动，直接手动，免得白等
            autoVerifyAddr: ok === false ? '' : (config().auto_verify_addr || ''),
          })
          ok = r
        } catch (err) {
          logger?.error?.(`[xhh-TL][过码] ${e.user_id}/${a.realUid} 异常: ${err.message}`)
          lines.push(`· ${a.realUid}：过码异常`)
          continue
        }
      }
      lines.push(`· ${a.realUid}：${ok ? '过码成功' : '已知问题，稍后重试'}`)
    }
    // 不再补「现在发 #xx签到 即可」：`#过码` 是通用入口，深渊/体力/抽卡撞码都会引导过来，
    // 预设成「去签到」对从别处来的用户是错的（用户发 #过码 时自己知道要干什么）。
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  // -------- 开启订阅 --------
  async onGs(e) { return this._on(e, 'gs') }
  async onSr(e) { return this._on(e, 'sr') }
  async onZzz(e) { return this._on(e, 'zzz') }

  async _on(e, game) {
    if (this._groupOnly(e)) return true
    if (this._disabled(e)) return true
    const label = GAME_LABEL[game]

    // 校验：必须有「带 ck 属主(ltuid)」的 UID —— 与 signUserGame 的过滤完全一致，
    // 否则会出现「订阅成功但 cron 全被过滤、永远不签、也不进汇总图」的静默失效
    let uidList = []
    try {
      const user = await createUser(e.user_id, e)
      uidList = (user.getUidList(game) || [])
        .filter((x) => x && typeof x === 'object' && x.ltuid)
        .map((x) => String(x.uid))
        .filter(Boolean)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] 枚举 UID 失败 ${e.user_id}: ${err.message}`)
    }
    if (!uidList.length) {
      e.reply(`你还没有绑定${label}账号，请先【#扫码登录】米游社后再开启自动签到~`, quoteEnabled())
      return true
    }

    const subs = loadSubs()
    subs[game][String(e.user_id)] = { group: String(e.group_id) }
    saveSubs(subs)
    e.reply(
      `✅ 已开启${label}每日自动签到（名下 ${uidList.length} 个 UID）\n发送 #${label}签到 可立即签一次`,
      true,
    )
    return true
  }

  // -------- 关闭订阅 --------
  async offGs(e) { return this._off(e, 'gs') }
  async offSr(e) { return this._off(e, 'sr') }
  async offZzz(e) { return this._off(e, 'zzz') }

  async _off(e, game) {
    if (this._groupOnly(e)) return true
    const label = GAME_LABEL[game]
    const subs = loadSubs()
    const qq = String(e.user_id)
    if (subs[game][qq]) {
      delete subs[game][qq]
      saveSubs(subs)
      e.reply(`已关闭${label}自动签到`, quoteEnabled())
    } else {
      e.reply(`你还没有开启${label}自动签到`, quoteEnabled())
    }
    return true
  }

  // -------- 列表 --------
  async listSubs(e) {
    if (this._groupOnly(e)) return true
    const subs = loadSubs()
    const qq = String(e.user_id)
    const lines = ['📋 你的自动签到订阅：']
    let has = false
    for (const game of GAMES) {
      if (subs[game][qq]) {
        has = true
        const g = subs[game][qq].group
        lines.push(`· ${GAME_LABEL[game]}：已开启${g ? `（群 ${g} 回报）` : '（私聊回报）'}`)
      }
    }
    if (!has) lines.push('（暂无，发送 #原神自动签到 试试）')
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  /**
   * 对某 QQ 某游戏名下全部绑定 UID 逐个签到。
   * @returns {Promise<Array<{uid,code,msg,game}>>}
   */
  async signUserGame(e, qq, game, realE = null) {
    const results = []
    let user
    try {
      user = await createUser(qq, realE || e)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] createUser 失败 ${qq}: ${err.message}`)
      return results
    }
    // 只对「有 ck 的 UID」签到：ck 属主(ltuid)绑定的 UID 才带 ltuid；
    // 注册/redis 来源的 UID 没有 ck，签到必然 -10002，直接过滤掉不进结果
    const uidList = (user.getUidList(game) || [])
      .filter((x) => x && typeof x === 'object' && x.ltuid)
      .map((x) => String(x.uid))
      .filter(Boolean)
    if (!uidList.length) return results

    for (const uid of uidList) {
      try {
        // 为每个 uid 构造带该 uid 的 e，让 resolveAuth 精确取该账号完整 cookie
        const baseE = realE || e || {}
        const authE = Object.assign(
          Object.create(Object.getPrototypeOf(baseE) || Object.prototype),
          baseE,
          { user_id: qq, self_id: baseE.self_id, message: baseE.message || [], msg: String(uid), uid },
        )
        const auth = await resolveAuth(authE, { needCookie: true, game })
        if (!auth?.ck || !/cookie_token|account_id=/.test(auth.ck)) {
          results.push({ uid, code: 'expired', msg: `${GAME_LABEL[game]} 无有效登录，请【#刷新ck】，仍不行则【#扫码登录】`, game })
          continue
        }
        // 手动签到(realE)能发链接让人手划；自动 cron 没有 e，但配了全自动过码服务时
        // 一样能过码 —— runBbsVerify 只在「能 reply」时才走手划，e 为空会安全跳过。
        const opts = {
          e: realE || null,
          verifyAddr: realE ? config().auto_sign_verify_addr || '' : '',
          autoVerifyAddr: config().auto_verify_addr || '',
        }
        const r = await signOne(auth.uid || uid, auth.ck, game, opts)
        results.push(r)
      } catch (err) {
        logger?.error?.(`[xhh-TL][自动签到] ${qq}/${uid} 签到异常: ${err.message}`)
        results.push({ uid, code: 'fail', msg: `${GAME_LABEL[game]} 签到异常`, game })
      }
      // 账号间轻微间隔，降低风控
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)))
    }
    // 兜底：resolved ck 若仍不属主(-10002)，同样过滤掉不进结果
    return results.filter((r) => r.code !== 'no_role')
  }

  // ============ 定时全量签到 ============
  // 按订阅群分组：一次性把该群所有订阅者、所有游戏签完，
  // 汇总成一张统计图发到群里，不再逐用户 @ 回报。
  async runAll() {
    const cfg = config()
    if (cfg.auto_sign_enable === false) return
    const subs = loadSubs()

    // 汇总订阅计划：groupId -> Array<{ qq, game }>（无群的订阅跳过，不支持私聊）
    const plan = {}
    for (const game of GAMES) {
      for (const qq of Object.keys(subs[game])) {
        const sub = subs[game][qq]
        if (!sub || !sub.group) continue
        const gid = String(sub.group)
        ;(plan[gid] || (plan[gid] = [])).push({ qq, game })
      }
    }

    for (const gid of Object.keys(plan)) {
      const startTs = Date.now()
      const agg = { participants: new Set(), games: {} }
      for (const g of GAMES) agg.games[g] = { ok: 0, already: 0, refresh: 0, expired: 0, fail: 0 }

      for (const { qq, game } of plan[gid]) {
        try {
          const fakeE = this.makeFakeE(qq, gid)
          const results = await this.signUserGame(fakeE, qq, game, null)
          if (results.length) {
            agg.participants.add(String(qq))
            for (const r of results) this._tally(agg.games[game], r.code)
          }
        } catch (err) {
          logger?.error?.(`[xhh-TL][自动签到] ${GAME_LABEL[game]} ${qq} 定时签到失败: ${err.message}`)
        }
        // 账号/用户间间隔，降低风控
        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)))
      }

      const totalCost = this._fmtCost(Date.now() - startTs)
      try {
        await this.reportGroup(gid, agg, totalCost)
      } catch (err) {
        logger?.error?.(`[xhh-TL][自动签到] 群 ${gid} 汇总回报失败: ${err.message}`)
      }
    }
  }

  /** 把单条签到结果码累加进该游戏的统计桶 */
  _tally(bucket, code) {
    switch (code) {
      case 'ok': bucket.ok++; break
      case 'already': bucket.already++; break
      case 'expired': bucket.expired++; break
      // captcha / first_bind / fail / 其他 → 统一计失败
      default: bucket.fail++; break
    }
  }

  /** 毫秒 → “X小时Y分Z秒” */
  _fmtCost(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    let out = ''
    if (h) out += `${h}小时`
    if (h || m) out += `${m}分`
    out += `${sec}秒`
    return out
  }

  /** 渲染并发送某群的签到汇总图 */
  async reportGroup(gid, agg, totalCost) {
    // 只列有签到活动的游戏（任一计数 > 0）
    const rows = []
    let unsigned = 0
    for (const game of GAMES) {
      const b = agg.games[game]
      const total = b.ok + b.already + b.refresh + b.expired + b.fail
      if (!total) continue
      unsigned += b.expired + b.fail
      rows.push({
        name: GAME_LABEL[game],
        icon: toFileUrl(path.join(pluginDir, 'resources', GAME_ICON[game])),
        ok: b.ok,
        already: b.already,
        refresh: b.refresh,
        expired: b.expired,
        fail: b.fail,
      })
    }
    if (!rows.length) return // 该群本轮无任何可签账号

    // 顶部头像：参与者 QQ 头像，最多 6 个
    const headerIcons = [...agg.participants]
      .slice(0, 6)
      .map((qq) => `https://q1.qlogo.cn/g?b=qq&s=640&nk=${qq}.jpg`)

    const image = await this.renderSummary({ rows, unsigned, totalCost, headerIcons })
    if (!image) return
    try {
      const group = Bot.pickGroup(Number(gid))
      await group.sendMsg(segment.image(image))
      logger?.mark?.(`[xhh-TL][自动签到] 已发送群 ${gid} 汇总图（${rows.length} 个游戏，未签 ${unsigned}）`)
    } catch (err) {
      logger?.error?.(`[xhh-TL][自动签到] 群 ${gid} 汇总图发送失败: ${err.message}`)
    }
  }

  /** 组装 renderData 并出图；定时场景借 Runtime 拿 render 能力 */
  async renderSummary({ rows, unsigned, totalCost, headerIcons }) {
    const cfg = config()
    // 主题优先级：自动签到 → 角色持有率 → 全部深渊 → 浅色（各项可留空逐级回落）
    const themeRaw = String(
      cfg.auto_sign_theme || cfg.hold_rate_theme || cfg.gs_all_abyss_theme || 'light',
    ).toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    // CSS background 用 file:// 有截图竞态（见 pluginConfig.toDataUrl 注释），内联成 data URI
    const bgImage = toDataUrl(pickHelpBgImage({ logTag: 'xhh-TL][autoSign' }))
    const signIcon = toFileUrl(path.join(pluginDir, 'resources/help/icons/signin.webp'))
    const tplFile = path.join(pluginDir, 'resources/auto_sign/auto_sign.html')

    const renderData = {
      theme,
      bgImage,
      signIcon,
      headerIcons,
      totalCost,
      unsigned,
      rows,
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    // 定时场景无真实 e，用假 e + Runtime 复用渲染引擎
    const fakeE = this.makeFakeE('0', '')
    // reply:false → 只拿 webp buffer，发送由调用方（reportGroup）负责
    return (await renderTpl(fakeE, {
      tpl: 'auto_sign',
      tplFile,
      data: renderData,
      baseScale: 2.0,
      rem: true,
      reply: false,
    })) || null
  }

  /** 构造假 e，供定时场景 resolveAuth/createUser/render 复用 */
  makeFakeE(qq, groupId) {
    const bot = Bot
    let group = null
    if (groupId) {
      try { group = bot.pickGroup?.(Number(groupId)) } catch (_) {}
    }
    const fakeE = {
      user_id: qq,
      self_id: bot?.uin,
      isGroup: !!groupId,
      group_id: groupId || undefined,
      group,
      message: [],
      msg: '',
      reply: () => {},
      sender: { nickname: String(qq) },
    }
    try { fakeE.runtime = new Runtime(fakeE) } catch (_) {}
    return fakeE
  }
}

export default autoSign
