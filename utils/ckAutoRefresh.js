/**
 * ck 失效自愈：全局运行时补丁
 *
 * 背景：全云崽的米游社请求判「ck 失效」都收口在 genshin 官方插件的
 * MysInfo.prototype.checkCode——命中 [-1,-100,1001,10001,10103] 且 message 含
 * 「登录/login」时，会弹「UID:xxx，米游社Cookie已失效」并 delCk() 硬删凭证。
 *
 * 本补丁在 xhh-TL 加载时包一层 checkCode：ck 失效那一刻，用 stoken 内部换出新 ck、
 * 换进当前 mysApi、写回 genshin 库、重发一次请求，用户全程无感。
 * stoken 已被米游社判死（换不出）时不再弹含糊的「Cookie已失效」，而是清掉凭证、
 * 直接让用户重新扫码。
 *
 * 只 patch 一个方法、只在「自己的 ck 且交互请求」时介入，不碰 genshin 源码。
 */

import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { refreshCkDetailed as realRefreshCk } from './auth.js'
import { getStokenCandidateFiles } from './pluginConfig.js'

const CK_DEAD_CODES = [-1, -100, 1001, 10001, 10103]
const PATCH_FLAG = '__xhhCkAutoRefresh'
// apiSync 批量接口里多个结果都用旧 ck 拉的，healing 第一个后循环里后续 sibling
// 仍 dead 会各自再调一次换 ck。短缓存让同一 qq:uid 在窗口内复用上次换好的 ck，
// 只让第一个 sibling 真打兑换接口——省接口调用、对米游社风控友好。
const CK_CACHE_TTL = 60 * 1000
const ckCache = new Map() // `${qq}:${uid}` -> { ck, at }

function isCkDead(res) {
  return (
    !!res &&
    CK_DEAD_CODES.includes(Number(res.retcode)) &&
    /(登录|login)/i.test(res.message || '')
  )
}

async function cachedRefreshCk(refreshFn, qq, uid) {
  const key = `${qq}:${uid}`
  const hit = ckCache.get(key)
  if (hit && Date.now() - hit.at < CK_CACHE_TTL) {
    return { ck: hit.ck, stokenDead: false }
  }
  const r = await refreshFn(qq, uid)
  const out = r && typeof r === 'object' ? r : { ck: r || '', stokenDead: false }
  if (out.ck) ckCache.set(key, { ck: out.ck, at: Date.now() })
  return out
}

/**
 * 把新 ck 写回 genshin 库，让下次请求不再失效。全程 try/catch，绝不抛：
 * 写回失败只是「这次换成功但没持久化」，不影响本次 swap+重发。
 * 每步做方法存在性检查，genshin 版本漂移不崩。
 */
async function writeBackCk(ckUser, newCk) {
  try {
    if (!ckUser || typeof ckUser.setCkData !== 'function') return
    ckUser.setCkData({ ck: newCk, device: ckUser.device })
    if (typeof ckUser.save === 'function') await ckUser.save()
    if (typeof ckUser.initCache === 'function') await ckUser.initCache()
  } catch (err) {
    logger?.debug?.(`[xhh-TL][ckAutoRefresh] writeBack failed: ${err?.message}`)
  }
}

/**
 * 清掉所有候选 stoken 文件里该账号的凭证字段，强制用户重新扫码。
 * 只删凭证字段，保留 is_sign / region 这类用户偏好。
 */
export function clearDeadStoken(qq, uid) {
  for (const file of getStokenCandidateFiles(String(qq))) {
    try {
      if (!fs.existsSync(file)) continue
      const data = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
      const entry =
        data[uid] ||
        data[String(uid)] ||
        Object.values(data).find((v) => v && (v.stoken || v.ck_stoken))
      if (!entry) continue
      for (const key of ['stoken', 'ck_stoken', 'cookie_token', 'ltoken']) {
        delete entry[key]
      }
      fs.writeFileSync(file, YAML.stringify(data))
    } catch (err) {
      logger?.debug?.(`[xhh-TL][ckAutoRefresh] clear stoken failed: ${err?.message}`)
    }
  }
}

/**
 * JiuLi 把 ck 存在 data/db/data.db（Users.ltuids / MysUsers），genshin 的 delCk()
 * 在这套存储上删不干净：实测失效后记录仍留在库里，兼容层会把死 ck 重新导出成
 * data/MysCookie/<qq>.yaml，重启迁移又灌回去。这里按 uid 直接补删；
 * 其他框架没有这个库，静默跳过。
 */
export async function clearDeadDb(qq, uid) {
  try {
    const file = path.join(process.cwd(), 'data/db/data.db')
    if (!fs.existsSync(file)) return
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { timeout: 5000 })
    try {
      const rows = db.prepare('SELECT ltuid, uids FROM MysUsers').all()
      const dead = new Set()
      for (const row of rows) {
        let uids = {}
        try {
          uids = JSON.parse(row.uids || '{}') || {}
        } catch (_) {}
        const hit = Object.values(uids).some(
          (list) => Array.isArray(list) && list.map(String).includes(String(uid)),
        )
        if (hit) dead.add(String(row.ltuid))
      }
      if (!dead.size) return
      for (const ltuid of dead) {
        db.prepare('DELETE FROM MysUsers WHERE ltuid = ?').run(ltuid)
      }
      for (const user of db.prepare('SELECT id, ltuids FROM Users').all()) {
        const raw = String(user.ltuids || '')
        const keep = raw.split(',').filter((v) => v && !dead.has(v))
        if (keep.join(',') !== raw) {
          db.prepare('UPDATE Users SET ltuids = ? WHERE id = ?').run(keep.join(','), user.id)
        }
      }
      logger?.mark?.(
        `[xhh-TL][ckAutoRefresh] 已清理数据库死 ck [uid:${uid}][qq:${qq}]`,
      )
    } finally {
      db.close()
    }
  } catch (err) {
    logger?.debug?.(`[xhh-TL][ckAutoRefresh] clear db failed: ${err?.message}`)
  }
}

/**
 * 给 MysInfo 打补丁（依赖注入 refreshCk / clearStoken / clearDb，便于脱机测试）。
 * @returns {boolean} 是否成功安装（已装过 / 无原型返回 false）
 */
export function installCkAutoRefresh(
  MysInfo,
  { refreshCk, clearStoken = clearDeadStoken, clearDb = clearDeadDb } = {},
) {
  if (!MysInfo?.prototype || MysInfo.prototype[PATCH_FLAG]) return false
  const doRefresh = refreshCk || realRefreshCk
  const original = MysInfo.prototype.checkCode

  MysInfo.prototype.checkCode = async function (
    res,
    type,
    mysApi = {},
    data = {},
    isTask = false,
  ) {
    // 仅「交互请求 + 自己的 ck 失效 + 有可重发的 mysApi」才介入。
    // 公共 ck（ckInfo.uid 空）、定时任务（isTask）、其他 retcode 一律不碰。
    if (
      !isTask &&
      isCkDead(res) &&
      this.ckInfo?.uid &&
      mysApi &&
      typeof mysApi.getData === 'function'
    ) {
      try {
        const { ck: newCk, stokenDead } = await cachedRefreshCk(
          doRefresh,
          this.userId,
          this.ckInfo.uid,
        )
        if (newCk) {
          logger?.mark?.(
            `[xhh-TL][ckAutoRefresh] 自动换 ck 重试 [uid:${this.ckInfo.uid}][qq:${this.userId}]`,
          )
          mysApi.cookie = newCk // 换请求 ck（mysApi.getData 用 this.cookie）
          await writeBackCk(this.ckUser, newCk) // 持久化（best-effort，失败不阻塞）
          const retryRes = await mysApi.getData(type, data)
          // 重发结果交回*原始* checkCode 判：重发成功 → retcode 0 正常返回；
          // 重发仍失败 → 走 genshin 原生 delCk+提示（自然降级）。
          // 绝不再经过本包装层，杜绝二次换 ck / 死循环。
          return await original.call(this, retryRes, type, mysApi, data, isTask)
        }
        if (stokenDead) {
          // stoken 都死了，再刷新多少次都是空跑：清凭证，让用户重新扫码。
          logger?.mark?.(
            `[xhh-TL][ckAutoRefresh] stoken 已失效，清理凭证 [uid:${this.ckInfo.uid}][qq:${this.userId}]`,
          )
          try {
            await this.delCk?.()
          } catch (_) {}
          clearStoken(this.userId, this.ckInfo.uid)
          await clearDb(this.userId, this.ckInfo.uid)
          this.e?.reply?.(
            `UID:${this.ckInfo.uid}，授权已过期，请发送 #扫码登录 重新绑定`,
          )
          return false
        }
      } catch (err) {
        logger?.debug?.(`[xhh-TL][ckAutoRefresh] swap failed: ${err?.message}`)
        // 落到下面走原逻辑
      }
    }
    return await original.call(this, res, type, mysApi, data, isTask)
  }

  MysInfo.prototype[PATCH_FLAG] = true
  return true
}

// ---- 顶层 wiring：加载即执行一次；genshin 没装就静默跳过 ----
try {
  const mod = await import('../../genshin/model/mys/mysInfo.js')
  const MysInfo = mod?.default
  if (MysInfo && installCkAutoRefresh(MysInfo, { refreshCk: realRefreshCk })) {
    logger?.info?.('[xhh-TL] ck 失效自愈补丁已装载')
  }
} catch (err) {
  logger?.debug?.(`[xhh-TL][ckAutoRefresh] genshin 缺席，跳过: ${err?.message}`)
}

export default { installCkAutoRefresh }
