import crypto from 'node:crypto'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { createUser, hasRuntimeBinding } from '../utils/userBind.js'
import { getSignAccounts } from '../utils/signAccounts.js'
import { findStokenEntry, stokenToCookie, cookiePart } from '../utils/auth.js'
import { isModuleEnabled } from '../utils/modules.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { GAMES, SEEN_TTL, TERMINAL, MESSAGES, COMMAND_REG, parseCommand, getCodes, getAutoCodes, getRoles, redeemCode } from '../utils/redeemClient.js'

const SUBS = 'Yunzai:ycdk:auto:subs'
const SEEN = 'Yunzai:ycdk:auto:seen'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const inflight = new Set()
let polling = false
// redis v4（Yunzai 基线）与 JiuLi 共用的命令接口。锁到期后不可删掉别人的锁。
async function unlock(key, value) {
  await redis.eval('if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end', { keys: [key], arguments: [value] })
}
export class redeemCodes extends plugin {
  constructor() {
    super({ name: '[小火花]兑换码', dsc: '三游戏国服手动与自动兑换', event: 'message', priority: -100,
      rule: [{ reg: COMMAND_REG, fnc: 'handle' }] })
    this.task = { name: 'xhh-TL-自动兑换码', cron: '17 */10 * * * *', fnc: () => this.runAll(), log: false }
  }
  subKey(e, game) { return JSON.stringify([String(e.self_id || e.bot?.uin || ''), String(e.user_id), game]) }
  async handle(e) {
    const cmd = parseCommand(e.msg)
    if (!cmd) return false
    const prefix = ({ gs: '#', sr: '*', zzz: '%' })[cmd.game]
    const reply = msg => e.reply(msg, quoteEnabled())
    try {
      const key = this.subKey(e, cmd.game)
      // 关闭模块后仍可取消订阅、查询状态。
      if (cmd.action === 'off') {
        await redis.hDel(SUBS, key)
        await reply(`已关闭${GAMES[cmd.game].name}自动兑换码`)
        return true
      }
      if (cmd.action === 'status') {
        const enabled = !!await redis.hGet(SUBS, key)
        await reply(`${GAMES[cmd.game].name}自动兑换码：${enabled ? '已开启' : '未开启'}${!isModuleEnabled('redeem') ? '（功能已被管理员关闭）' : ''}`)
        return true
      }
      if (!isModuleEnabled('redeem')) { await reply('兑换码功能已被管理员关闭'); return true }
      if (cmd.action === 'usage') {
        await reply(`${prefix}使用兑换码：兑换近期收录的码\n${prefix}使用兑换码 兑换码：使用指定码，多个码用空格分隔，最多20个\n${prefix}自动兑换码开启 / ${prefix}自动兑换码关闭 / ${prefix}自动兑换码状态`)
        return true
      }
      // 不用 e.at / 原事件的 e.user，避免 @他人时误选凭证。
      await e.runtime?.ready?.()
      const user = await createUser(e.user_id, { user_id: e.user_id, runtime: e.runtime })
      const accounts = getSignAccounts(user, cmd.game)
      if (!accounts.length) { await reply(`请先发送 #扫码登录 绑定${GAMES[cmd.game].name}账号`); return true }
      if (cmd.action === 'on') {
        const sub = { qq: String(e.user_id), bot: String(e.self_id || e.bot?.uin || ''), group: e.isGroup ? String(e.group_id) : '', game: cmd.game }
        await redis.hSet(SUBS, key, JSON.stringify(sub))
        await reply(`已开启${GAMES[cmd.game].name}自动兑换码，仅兑换官方前瞻直播码，每10分钟检查一次；结果发到${sub.group ? '本群' : '私聊'}`)
        return true
      }
      if (inflight.has(key)) { await reply('兑换进行中，请稍后再试'); return true }
      inflight.add(key)
      try {
        const codes = cmd.codes || (await getCodes(cmd.game)).map(x => x.code)
        if (!codes.length) { await reply('暂无近期收录的兑换码'); return true }
        await reply(`开始兑换${GAMES[cmd.game].name}兑换码，请稍候`)
        const results = await this.exchange({ e, game: cmd.game, user, accounts, codes })
        await this.report(reply, cmd.game, results)
      } finally { inflight.delete(key) }
    } catch (err) {
      logger.error(`[xhh-TL][兑换码] 指令处理失败: ${err.message}`)
      await reply('兑换码操作失败，请稍后再试')
    }
    return true
  }
  async exchange({ e, game, user, accounts, codes, subscription = null }) {
    const results = []
    const roleCache = new Map()
    for (const account of accounts) {
      const { uid, ltuid } = account
      const lockKey = `${SEEN}:lock:${game}:${uid}`
      const token = crypto.randomBytes(16).toString('hex')
      if (!await redis.set(lockKey, token, { NX: true, EX: 900 })) {
        if (!subscription) results.push(`${uid}：兑换进行中，请稍后再试`)
        continue
      }
      try {
        // 自动兑换已完成/超过三次尝试的角色不再访问米游社。
        const pending = []
        for (const code of codes) {
          const stateKey = `${SEEN}:${game}:${uid}:${code}`
          const raw = await redis.get(stateKey)
          const state = raw ? JSON.parse(raw) : {}
          if (!subscription || (!state.done && (state.attempts || 0) < 3)) pending.push({ code, stateKey, state })
        }
        if (!pending.length) continue
        let credentials = roleCache.get(ltuid)
        if (!credentials) {
          let ck = account.ck
          if (!hasRuntimeBinding(e) && !/cookie_token(?:_v2)?=/.test(ck)) {
            const entry = findStokenEntry(user.qq || e.user_id, uid)
            if (entry && String(entry.stuid || entry.ltuid || '') === ltuid) ck = await stokenToCookie(entry) || ck
          }
          const owner = cookiePart(ck, 'account_id_v2') || cookiePart(ck, 'account_id') || cookiePart(ck, 'ltuid_v2') || cookiePart(ck, 'ltuid')
          if (!/cookie_token(?:_v2)?=/.test(ck) || (owner && owner !== ltuid)) {
            credentials = { ck: '', retcode: -1071, roles: [] }
          } else { credentials = { ck, ...await getRoles(game, ck) } }
          roleCache.set(ltuid, credentials)
        }
        const role = credentials.roles.find(r => String(r.game_uid) === uid)
        if (credentials.retcode !== 0 || !role) {
          const msg = MESSAGES[credentials.retcode] || '请发送 #扫码登录 重新绑定账号'
          results.push(`${uid}：${msg}`)
          // 不把失效登录当成「已兑换」；自动任务最多三轮，手动不受影响。
          for (const p of pending) await redis.set(p.stateKey, JSON.stringify({ attempts: (p.state.attempts || 0) + 1 }), { EX: SEEN_TTL })
          continue
        }
        for (const { code, stateKey, state } of pending) {
          if (!isModuleEnabled('redeem')) break
          if (subscription && await redis.hGet(SUBS, subscription.key) !== subscription.raw) break
          // 跨消息、跨自动/手动请求也共享冷却，不只在一批内部 sleep。
          const nextKey = `${SEEN}:next:${game}:${uid}`
          const wait = Math.min(6500, Math.max(0, Number(await redis.get(nextKey) || 0) - Date.now()))
          if (wait) await sleep(wait)
          if (await redis.get(lockKey) !== token || !isModuleEnabled('redeem')) break
          if (subscription && await redis.hGet(SUBS, subscription.key) !== subscription.raw) break
          let result
          try { result = await redeemCode(game, role, credentials.ck, code) }
          catch (err) {
            logger.warn(`[xhh-TL][兑换码] ${game}/${uid}/${code} 请求失败: ${err.message}`)
            result = { retcode: null, msg: '兑换失败，请稍后再试' }
          }
          await redis.set(nextKey, String(Date.now() + 6500), { EX: 30 })
          await redis.set(stateKey, JSON.stringify({ done: TERMINAL.has(result.retcode), attempts: (state.attempts || 0) + 1, retcode: result.retcode }), { EX: SEEN_TTL })
          results.push(`${uid} · ${code}：${result.msg}`)
          if ([-1071, -1033, -1035, -100, -2016].includes(result.retcode)) break
        }
      } catch (err) {
        logger.error(`[xhh-TL][兑换码] ${game}/${uid} 处理失败: ${err.message}`)
        results.push(`${uid}：兑换失败，请稍后再试`)
      } finally { await unlock(lockKey, token) }
    }
    return results
  }
  async report(reply, game, lines) {
    if (!lines.length) return
    // 防止多账号、多码的结果超过消息平台长度限制。
    for (let i = 0; i < lines.length; i += 12) await reply(`${GAMES[game].name}兑换结果：\n${lines.slice(i, i + 12).join('\n')}`)
  }
  async runAll() {
    if (polling || !isModuleEnabled('redeem')) return
    polling = true
    try {
      const subs = await redis.hGetAll(SUBS)
      for (const [key, raw] of Object.entries(subs)) {
        if (!isModuleEnabled('redeem')) break
        if (inflight.has(key)) continue
        inflight.add(key)
        try {
          const sub = JSON.parse(raw)
          if (!GAMES[sub.game] || !sub.qq) continue
          if (await redis.hGet(SUBS, key) !== raw) continue
          const codes = (await getAutoCodes(sub.game)).map(x => x.code)
          if (!codes.length) continue
          const root = globalThis.Bot
          // 优先使用订阅时的机器人，不能随便挑另一个账号发送。
          const bot = root?.[sub.bot] || (String(root?.uin || '') === sub.bot ? root : null)
          if (!bot) { logger.warn(`[xhh-TL][兑换码] 订阅机器人不可用: ${sub.bot}`); continue }
          const target = sub.group ? bot.pickGroup?.(sub.group) : bot.pickFriend?.(sub.qq)
          if (!target?.sendMsg) continue
          const e = { user_id: sub.qq, self_id: sub.bot, bot, isGroup: !!sub.group, group_id: sub.group || undefined, msg: '', message: [], reply() {} }
          try { e.runtime = new Runtime(e) } catch (_) {}
          await e.runtime?.ready?.()
          const user = await createUser(sub.qq, e)
          const accounts = getSignAccounts(user, sub.game)
          // 删除绑定后不复活旧账号；保留订阅，用户重新绑定后可恢复。
          if (!accounts.length) continue
          const results = await this.exchange({ e, game: sub.game, user, accounts, codes, subscription: { key, raw } })
          if (results.length && await redis.hGet(SUBS, key) === raw) {
            await this.report(msg => target.sendMsg(`自动兑换码 · ${sub.qq}\n${msg}`), sub.game, results)
          }
        } catch (err) { logger.error(`[xhh-TL][兑换码] 自动任务失败: ${err.message}`) }
        finally { inflight.delete(key) }
      }
    } catch (err) { logger.error(`[xhh-TL][兑换码] 读取订阅失败: ${err.message}`) }
    finally { polling = false }
  }
}
