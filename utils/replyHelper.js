/**
 * 统一回复：引用 / 撤回
 * - 单图结果：引用触发消息
 * - 合并转发：不引用
 * - 「正在…」类提示：30 秒后自动撤回
 */

/** 解析 e.reply 返回的 message_id */
export function getReplyMessageId(res) {
  if (!res) return ''
  if (typeof res === 'string' || typeof res === 'number') return String(res)
  return String(res.message_id || res.data?.message_id || res.ret?.message_id || '')
}

/** 撤回指定消息（兼容群/好友/bot） */
export async function recallById(e, messageId) {
  const id = messageId || getReplyMessageId(messageId)
  if (!id) return false
  try {
    if (e.group?.recallMsg) {
      await e.group.recallMsg(id)
      return true
    }
    if (e.friend?.recallMsg) {
      await e.friend.recallMsg(id)
      return true
    }
    if (e.bot?.recallMsg) {
      await e.bot.recallMsg(id)
      return true
    }
  } catch (_) {}
  return false
}

/**
 * 发送「正在…」进度提示：引用触发消息，默认 30 秒后撤回
 * @returns {Promise<any>} e.reply 原始返回
 */
export async function replyProgress(e, msg, { quote = true, recallSec = 30 } = {}) {
  if (!e?.reply) return null
  try {
    // Yunzai 内置 recallMsg（秒）
    if (recallSec > 0) {
      return await e.reply(msg, quote, { recallMsg: recallSec })
    }
    return await e.reply(msg, quote)
  } catch (_) {
    try {
      const res = await e.reply(msg, quote)
      if (recallSec > 0) {
        const mid = getReplyMessageId(res)
        if (mid) {
          setTimeout(() => {
            recallById(e, mid).catch(() => {})
          }, recallSec * 1000)
        }
      }
      return res
    } catch (err) {
      return null
    }
  }
}

/** 单条结果（图/文）：引用触发消息 */
export async function replyQuote(e, msg) {
  if (!e?.reply) return null
  return e.reply(msg, true)
}

/** 合并转发：不引用触发消息 */
export async function replyForward(e, forwardMsg) {
  if (!e?.reply) return null
  return e.reply(forwardMsg, false)
}
