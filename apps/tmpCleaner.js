/**
 * 定时清理 data/tmp 临时渲染图
 * 默认每天 4:17 清理超过 24 小时的文件；可在 config / 锅巴 配置
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import { readPluginConfig, pluginDir } from '../utils/pluginConfig.js'

const DEFAULT_CRON = '17 4 * * *'
const DEFAULT_MAX_AGE_HOURS = 24

function tmpDir() {
  return path.join(pluginDir, 'data', 'tmp')
}

/**
 * 清理 tmp 目录
 * @param {{ maxAgeHours?: number, forceAll?: boolean }} opts
 * @returns {{ removed: number, kept: number, freed: number }}
 */
export function cleanTmpDir(opts = {}) {
  const dir = tmpDir()
  const maxAgeHours = Number(opts.maxAgeHours)
  const forceAll = !!opts.forceAll
  const ageMs =
    forceAll || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0
      ? 0
      : maxAgeHours * 3600 * 1000
  const now = Date.now()

  let removed = 0
  let kept = 0
  let freed = 0

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      return { removed, kept, freed }
    }

    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (!st.isFile()) continue

      const expired = forceAll || ageMs === 0 || now - st.mtimeMs >= ageMs
      if (!expired) {
        kept++
        continue
      }
      try {
        fs.unlinkSync(full)
        removed++
        freed += st.size || 0
      } catch (err) {
        if (typeof logger !== 'undefined') {
          logger.warn?.(`[xhh-TL][tmp] 删除失败 ${name}: ${err.message}`)
        }
      }
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.error?.(`[xhh-TL][tmp] 清理异常: ${err.message}`)
    }
  }

  return { removed, kept, freed }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export class TmpCleaner extends plugin {
  constructor() {
    const cfg = readPluginConfig()
    const cron = cfg.tmp_clean_cron || DEFAULT_CRON
    const enabled = cfg.tmp_clean_enable !== false

    super({
      name: '[xhh-TL]临时文件清理',
      dsc: '定时清理 data/tmp',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // #清理临时文件 / #小花火清理tmp / 清理缓存；尾部多余字不触发
          reg: '^\\s*#?(?:体力插件|小花火|xhh-?TL)?(?:清理|清除)(?:临时|缓存|tmp)(?:文件|目录)?(?:全部)?\\s*$',
          fnc: 'manualClean',
          permission: 'master',
        },
      ],
    })

    if (enabled) {
      this.task = {
        name: 'xhh-TL-清理data/tmp',
        cron,
        fnc: () => this.autoClean(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  autoClean() {
    const cfg = readPluginConfig()
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
    const cfg = readPluginConfig()
    const maxAgeHours = forceAll
      ? 0
      : Number(cfg.tmp_clean_max_age_hours ?? DEFAULT_MAX_AGE_HOURS)
    const r = cleanTmpDir({ maxAgeHours, forceAll })
    const tip = forceAll
      ? `已清空 tmp：删除 ${r.removed} 个文件，释放 ${formatBytes(r.freed)}`
      : `已清理超过 ${maxAgeHours} 小时的临时文件：删除 ${r.removed} 个，保留 ${r.kept} 个，释放 ${formatBytes(r.freed)}`
    e.reply(tip, true)
    return true
  }
}

export default TmpCleaner
