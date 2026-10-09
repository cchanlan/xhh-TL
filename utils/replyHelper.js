/**
 * 统一回复：引用 / 撤回
 * - 单图结果：引用触发消息
 * - 合并转发：不引用
 * - 「正在…」类提示：30 秒后自动撤回（只撤机器人自己那条）
 * 引用行为可以在锅巴里用 reply_quote 关掉（默认开）。
 */

import { config } from './pluginConfig.js'

/** 锅巴开关：是否引用触发消息 */
export function quoteEnabled() {
  try {
    return config().reply_quote !== false
  } catch (_) {
    return true
  }
}

/** 解析 e.reply 返回的 message_id */
export function getReplyMessageId(res) {
  if (!res) return ''
  if (typeof res === 'string' || typeof res === 'number') return String(res)
  return String(res.message_id || res.data?.message_id || res.ret?.message_id || '')
}

/** 取一个能撤回消息的通道（群 > 好友 > bot），能力探测，不写死框架 */
function pickRecallChannel(e) {
  if (e?.group?.recallMsg) return e.group
  if (e?.friend?.recallMsg) return e.friend
  if (e?.bot?.recallMsg) return e.bot
  return null
}

/** 撤回指定消息（兼容群/好友/bot）；参数可以传 message_id 或 e.reply 的返回对象 */
export async function recallById(e, messageId) {
  const id =
    typeof messageId === 'string' || typeof messageId === 'number'
      ? String(messageId)
      : getReplyMessageId(messageId)
  if (!id) return false
  const channel = pickRecallChannel(e)
  if (!channel) return false
  try {
    await channel.recallMsg(id)
    return true
  } catch (_) {
    return false
  }
}

/**
 * 延时撤回机器人自己发出的一条消息（只撤这一条，不碰触发者的指令）
 *
 * 这里不能改用 e.reply 的 recallMsg：Yunzai / TRSS / JiuLi 同源的实现（loader.js
 * 的 reply 包装）在撤回回复之后会顺手把 e.message_id —— 也就是触发者那条指令 ——
 * 一起撤回，群里看着就是「指令被机器人吃了」。
 *
 * @returns {any} 定时器（拿不到撤回通道或没有 message_id 时返回 null）
 */
export function scheduleRecall(e, res, sec) {
  const id = getReplyMessageId(res)
  if (!id || !(sec > 0)) return null
  // 发送时就把撤回通道定下来，定时器里不再依赖 e（框架可能回收事件对象）
  const channel = pickRecallChannel(e)
  if (!channel) return null
  const timer = setTimeout(() => {
    try {
      Promise.resolve(channel.recallMsg(id)).catch(() => {})
    } catch (_) {}
  }, sec * 1000)
  // 别让这个定时器拖着进程不退出
  timer?.unref?.()
  return timer
}

/**
 * 发送「正在…」进度提示：引用触发消息，默认 30 秒后只撤回这一条
 * @returns {Promise<any>} e.reply 原始返回
 */
export async function replyProgress(e, msg, { quote = true, recallSec = 30 } = {}) {
  if (!e?.reply) return null
  quote = quote && quoteEnabled()
  let res
  try {
    res = await e.reply(msg, quote)
  } catch (_) {
    return null
  }
  scheduleRecall(e, res, recallSec)
  return res
}

/** 单条结果（图/文）：引用触发消息（锅巴关掉 reply_quote 就不引用） */
export async function replyQuote(e, msg) {
  if (!e?.reply) return null
  return e.reply(msg, quoteEnabled())
}

/** 合并转发：不引用触发消息 */
export async function replyForward(e, forwardMsg) {
  if (!e?.reply) return null
  return e.reply(forwardMsg, false)
}
