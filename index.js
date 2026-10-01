// 插件入口：Yunzai 有 index.js 时只加载本文件导出，不会自动扫 apps/*
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import './utils/ckAutoRefresh.js'
import { TL } from './apps/TL.js'
import { Abyss } from './apps/Abyss.js'
import { TmpCleaner } from './apps/tmpCleaner.js'
import { nanokaAbyss } from './apps/nanokaAbyss.js'
import { help } from './apps/help.js'
import { resinPush } from './apps/resinPush.js'
import { autoSign } from './apps/autoSign.js'
import { autoBbsCoin } from './apps/autoBbsCoin.js'
import { TLDelCkHook } from './apps/delCkHook.js'
import { solverDeploy } from './apps/solverDeploy.js'
import { captchaNotice } from './apps/captchaNotice.js'

/**
 * 本文件在 plugins/xhh-TL/index.js，`../..` 才是 Bot 根目录。
 *
 * 不能用 `pathname`：Windows 上会得到 `/C:/xxx` 这种带前导斜杠的路径，
 * fs.existsSync 一律判否（插件会被误判成「没装 miao-plugin」）。
 * 中文路径也要靠 fileURLToPath 解码。
 */
const botRoot = fileURLToPath(new URL('../..', import.meta.url))

const hasMiaoPlugin = (() => {
  try {
    return fs.existsSync(path.join(botRoot, 'plugins', 'miao-plugin', 'models', 'index.js'))
  } catch { return false }
})()

let teamDamage, role_combat, miniRoleCombat, gsAllAbyss, abyssTeam, hardTeam, holdRate, srGachaLog

if (hasMiaoPlugin) {
  const m1 = await import('./apps/teamDamage.js'); teamDamage = m1.teamDamage
  const m2 = await import('./apps/role_combat.js'); role_combat = m2.role_combat
  const m3 = await import('./apps/miniRoleCombat.js'); miniRoleCombat = m3.miniRoleCombat
  const m4 = await import('./apps/gsAllAbyss.js'); gsAllAbyss = m4.gsAllAbyss
  const m5 = await import('./apps/abyssTeam.js'); abyssTeam = m5.abyssTeam
  const m6 = await import('./apps/hardTeam.js'); hardTeam = m6.hardTeam
  const m7 = await import('./apps/holdRate.js'); holdRate = m7.holdRate
  const m8 = await import('./apps/srGachaLog.js'); srGachaLog = m8.srGachaLog
  if (globalThis.logger) logger.info('[xhh-TL] miao-plugin detected, all features enabled')
} else {
  /**
   * 降级占位类。`priority` 必须给数字：JiuLi 用 `a.priority - b.priority` 排序，
   * 拿到 undefined 会算出 NaN，让比较函数不满足传递性 —— V8 的 sort 结果随之不可预测，
   * 全表顺序都可能被打乱（实测会把 -999 的插件排到 300 的后面，指令被别的插件抢走）。
   * 云崽那边虽然不看这个字段，但给个基类同款默认值不会有副作用。
   */
  const placeholder = class { constructor() { this.rule = []; this.priority = 5000 } }
  teamDamage = role_combat = miniRoleCombat = gsAllAbyss = abyssTeam = hardTeam = holdRate = srGachaLog = placeholder
  if (globalThis.logger) logger.warn('[xhh-TL] miao-plugin not found, 8 features disabled')
}

export {
  TL, Abyss, teamDamage, role_combat, miniRoleCombat, gsAllAbyss, abyssTeam, hardTeam, holdRate,
  TmpCleaner, nanokaAbyss, help, resinPush, autoSign, autoBbsCoin,
  TLDelCkHook, srGachaLog, solverDeploy, captchaNotice,
}
