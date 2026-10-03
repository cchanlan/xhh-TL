/**
 * #删除ck 钩子（仅在有 genshin 的环境生效）
 *
 * 作用：genshin 的 #删除ck 只把被删账号(ltuid/stuid)从 Yunzai 绑定库(Users.ltuids)
 * 移除，不会清理扫码/xiaoyao 写入的 stoken yaml，导致被删的号仍残留在 yaml 里、被体力
 * (widget) 查询“复活”。而“被删的号”与“从没绑过 ck 的纯扫码号”在库里长得一样，无法事后
 * 区分，只能在删除发生的这一刻记录下来。
 *
 * 实现思路（不改 genshin / xiaoyao 一行，不依赖复刻 genshin 的 uid→ltuid 推断）：
 *  1. 注册同一条 #删除ck 正则，priority 低于 genshin(300) → 本钩子先执行；
 *  2. 执行时先快照当前存活 ltuids 集合，随后 return false 放行，让 genshin 正常删除；
 *  3. 延时再次读取存活集合，前后求差 → 差集即本次被删的 stuid；
 *  4. 从 yaml 里取出这些 stuid 当时的 stoken，连同指纹一起记入本地已删名单
 *     （指纹用于日后“重新扫码登录覆盖了 stoken”时的自愈判断）。
 *
 * 无 genshin 的环境：没人能发出 #删除ck（该指令由 genshin 注册），本钩子永不触发，零副作用。
 */

import plugin from '../../../lib/plugins/plugin.js'
import { getAliveMysIds } from '../utils/userBind.js'
import { loadStokenYaml } from '../utils/pluginConfig.js'
import { addDeleted } from '../utils/deletedCk.js'
import { guardModule } from '../utils/modules.js'

// genshin 删除是异步的（写 SQLite + save）。固定单次 3s 定时在删除慢于 3s 时会漏记，
// 改为短间隔轮询：每 500ms 比对一次存活集合，一旦检测到差集立即处理；最长等到 8s 超时。
const POLL_INTERVAL_MS = 500
const POLL_MAX_MS = 8000

/** 从 yaml 数据里按 stuid 找出其 stoken（yaml 以 uid 为 key，每条含 stuid/stoken 字段） */
function findStokenByStuid(yamlData, stuid) {
  if (!yamlData || typeof yamlData !== 'object') return ''
  const sid = String(stuid)
  for (const entry of Object.values(yamlData)) {
    if (entry && typeof entry === 'object' && String(entry.stuid || entry.ltuid || '') === sid) {
      return String(entry.stoken || '')
    }
  }
  return ''
}

export class TLDelCkHook extends plugin {
  constructor() {
    super({
      name: '[小火花]删除ck对账',
      dsc: '记录被 #删除ck 移除的账号，避免其残留 stoken 复活体力查询',
      event: 'message',
      // 必须小于 genshin 用户绑定插件的 priority(300)，确保本钩子先跑、先取快照
      priority: 250,
      rule: [
        {
          reg: /^#?(原神|星铁|绝区零)?删除c(oo)?k(ie)?$/i,
          fnc: 'onDelCk',
        },
      ],
    })
  }

  async onDelCk(e) {
    const qq = e.user_id
    try {
      const before = await getAliveMysIds(qq)
      // 只有存在绑定行、且当前有存活账号时才值得对账；否则没什么可删
      if (before?.hasRow && before.ids?.size) {
        const beforeIds = new Set(Array.from(before.ids).map((x) => String(x)))
        // 短间隔轮询求差，检测到删除即处理，避免固定延时短于 genshin 落盘时漏记
        this._pollRemoved(qq, beforeIds)
      }
    } catch (err) {
      logger?.debug?.(`[xhh-TL][delCkHook] 快照失败: ${err?.message}`)
    }
    // 关键：放行，让 genshin 继续执行真正的删除逻辑
    return false
  }

  /**
   * 短间隔轮询存活集合，检测到被删账号即记录；最长等到 POLL_MAX_MS 超时。
   * 相比固定单次定时，能容忍 genshin 落盘慢于预期而不漏记。
   * @param {string|number} qq
   * @param {Set<string>} beforeIds 删除前的存活 stuid 集合
   */
  _pollRemoved(qq, beforeIds) {
    const startAt = Date.now()
    const tick = async () => {
      try {
        const after = await getAliveMysIds(qq)
        const afterIds = new Set(Array.from(after?.ids || []).map((x) => String(x)))
        const removed = [...beforeIds].filter((id) => !afterIds.has(id))
        if (removed.length) {
          // 取被删 stuid 当时的 stoken，连指纹一起记入名单（便于日后自愈）
          const yamlData = loadStokenYaml(qq)
          const items = removed.map((stuid) => ({
            stuid,
            stoken: findStokenByStuid(yamlData, stuid),
          }))
          addDeleted(qq, items)
          logger?.info?.(`[xhh-TL][delCkHook] QQ ${qq} 已记录被删账号: ${removed.join(', ')}`)
          return
        }
      } catch (err) {
        logger?.debug?.(`[xhh-TL][delCkHook] 对账失败: ${err?.message}`)
        return
      }
      // 尚未检测到删除且未超时 → 继续下一轮
      if (Date.now() - startAt < POLL_MAX_MS) {
        setTimeout(tick, POLL_INTERVAL_MS)
      }
    }
    setTimeout(tick, POLL_INTERVAL_MS)
  }
}

// 关掉 del_ck_hook_enable 后本钩子直接放行（返回 false），
// genshin 的 #删除ck 照常执行，只是不再记录残留 stoken
guardModule(TLDelCkHook, 'del_ck', ['onDelCk'])
