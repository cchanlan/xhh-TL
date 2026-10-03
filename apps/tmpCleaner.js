/**
 * 定时清理本插件的临时渲染产物
 * 默认每天 4:17 清理超过 24 小时的文件；可在 config / 锅巴 配置
 *
 * ⚠️ 要清的是两处，别只看 data/tmp：
 *   - `data/tmp`：插件自己的临时目录（历史遗留，目前基本是空的）
 *   - `<云崽根>/temp/html/<插件名>/`：**真正的大头**。Yunzai 渲染器的产物固定落在
 *     这里（lib/renderer/Renderer.js 写死 `./temp/html/${name}/`），两个插件名各一份
 *     （渲染时 plugin 传的是「小火花」，另一处是 xhh-TL）。Remind 卡会把立绘内联成
 *     data URI，单个 HTML 就 1.8MB，攒起来只增不减。
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import { config, pluginDir } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { guardModule } from '../utils/modules.js'

const DEFAULT_CRON = '17 4 * * *'
const DEFAULT_MAX_AGE_HOURS = 24

/** 本插件在渲染器产物目录下用过的名字（render 的 plugin 参数） */
const RENDER_NAMES = ['xhh-TL', '小火花']

/**
 * 待清理的目录列表。
 * `temp/html/` 是宿主共享目录，别的插件（miao、genshin…）产物也在里面，
 * **只能删本插件自己的子目录**，绝不能碰整个 temp/html。
 */
function tmpDirs() {
  const dirs = [path.join(pluginDir, 'data', 'tmp')]
  // process.cwd() 是云崽根（pm2 从根目录启动）；取不到就跳过这部分
  try {
    const root = process.cwd()
    for (const name of RENDER_NAMES) {
      dirs.push(path.join(root, 'temp', 'html', name))
    }
  } catch (_) {}
  return dirs
}

/**
 * 删一个目录下超过 ageMs 的文件（**递归**）。
 *
 * ⚠️ 必须递归：渲染器的产物是 `temp/html/<插件名>/<模板名>/xxx.html`，
 * 里面还有一层子目录，只扫一层的话一个文件都清不掉（实测 41 个产物全在子目录里）。
 * 空目录顺手删掉，但目录本身保留（渲染器会自己建）。
 */
function cleanOneDir(dir, { forceAll, ageMs, now, acc, depth = 0 }) {
  // 深度限制：正常结构就两层，防异常嵌套无限递归
  if (depth > 4) return
  try {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      // 双保险：只处理确实在这个目录内的路径（防符号链接/异常名字跑出去）
      if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) continue
      let st
      try {
        st = fs.lstatSync(full)
      } catch {
        continue
      }
      // 符号链接不跟进去（避免指到插件目录外）
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        cleanOneDir(full, { forceAll, ageMs, now, acc, depth: depth + 1 })
        // 清空的子目录顺手删掉，下次渲染会重建
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full)
        } catch (_) {}
        continue
      }
      if (!st.isFile()) continue

      const expired = forceAll || now - st.mtimeMs >= ageMs
      if (!expired) {
        acc.kept++
        continue
      }
      try {
        fs.unlinkSync(full)
        acc.removed++
        acc.freed += st.size || 0
      } catch (err) {
        if (typeof logger !== 'undefined') {
          logger.warn?.(`[xhh-TL][tmp] 删除失败 ${full}: ${err.message}`)
        }
      }
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.error?.(`[xhh-TL][tmp] 清理 ${dir} 异常: ${err.message}`)
    }
  }
}

/**
 * 清理临时产物
 * @param {{ maxAgeHours?: number, forceAll?: boolean }} opts
 * @returns {{ removed: number, kept: number, freed: number }}
 */
export function cleanTmpDir(opts = {}) {
  const forceAll = !!opts.forceAll
  // forceAll 才是「删全部」；普通清理时 maxAgeHours 为 0/非法应回退默认 24h，
  // 而不是当作 0 龄→删光（配置误填 0 会清空整个 tmp，且文案显示“超过 0 小时”误导）
  const rawHours = Number(opts.maxAgeHours)
  const maxAgeHours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : DEFAULT_MAX_AGE_HOURS
  const ageMs = forceAll ? 0 : maxAgeHours * 3600 * 1000
  const now = Date.now()

  const acc = { removed: 0, kept: 0, freed: 0 }
  const dirs = tmpDirs()
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue
    } catch {
      continue
    }
    cleanOneDir(dir, { forceAll, ageMs, now, acc })
  }
  // 插件自己的临时目录不存在时补建（保持原有行为）
  try {
    const own = path.join(pluginDir, 'data', 'tmp')
    if (!fs.existsSync(own)) fs.mkdirSync(own, { recursive: true })
  } catch (_) {}

  return acc
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export class TmpCleaner extends plugin {
  constructor() {
    const cfg = config()
    const cron = cfg.tmp_clean_cron || DEFAULT_CRON
    const enabled = cfg.tmp_clean_enable !== false

    super({
      name: '[xhh-TL]临时文件清理',
      dsc: '定时清理出图产生的临时文件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // #清理临时文件 / #小火花清理tmp / 清理缓存；尾部多余字不触发
          reg: '^\\s*#?(?:体力插件|小火花|xhh-?TL)?(?:清理|清除)(?:临时|缓存|tmp)(?:文件|目录)?(?:全部)?\\s*$',
          fnc: 'manualClean',
          permission: 'master',
        },
      ],
    })

    if (enabled) {
      this.task = {
        name: 'xhh-TL-清理出图临时文件',
        cron,
        fnc: () => this.autoClean(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  autoClean() {
    const cfg = config()
    if (cfg.tmp_clean_enable === false) return
    const maxAgeHours = Number(cfg.tmp_clean_max_age_hours ?? DEFAULT_MAX_AGE_HOURS)
    const r = cleanTmpDir({ maxAgeHours })
    if (r.removed > 0 && typeof logger !== 'undefined') {
      logger.mark?.(
        `[xhh-TL][tmp] 定时清理: 删除 ${r.removed} 个, 保留 ${r.kept} 个, 释放 ${formatBytes(r.freed)}`,
      )
    }
  }

  async manualClean(e) {
    const forceAll = /全部|强制|所有/.test(e.msg || '')
    const cfg = config()
    // 非强制时若配置为 0/非法，cleanTmpDir 会回退默认 24h；文案也用回退后的真实值，避免显示“超过 0 小时”
    const rawHours = Number(cfg.tmp_clean_max_age_hours ?? DEFAULT_MAX_AGE_HOURS)
    const effHours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : DEFAULT_MAX_AGE_HOURS
    const r = cleanTmpDir({ maxAgeHours: forceAll ? 0 : effHours, forceAll })
    const tip = forceAll
      ? `已清空 tmp：删除 ${r.removed} 个文件，释放 ${formatBytes(r.freed)}`
      : `已清理超过 ${effHours} 小时的临时文件：删除 ${r.removed} 个，保留 ${r.kept} 个，释放 ${formatBytes(r.freed)}`
    e.reply(tip, quoteEnabled())
    return true
  }
}

export default TmpCleaner

// 关掉 tmp_clean_enable 后 #清理临时文件 不再响应（定时任务另有自己的开关判断）
guardModule(TmpCleaner, 'tmp_clean', ['manualClean'])
