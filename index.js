// 插件入口：Yunzai 有 index.js 时只加载本文件导出，不会自动扫 apps/*
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

const hasMiaoPlugin = (() => {
  try {
    const botRoot = new URL('../../..', import.meta.url).pathname
    return fs.existsSync(botRoot + 'plugins/miao-plugin/models/index.js')
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
  const placeholder = class { constructor() { this.rule = [] } }
  teamDamage = role_combat = miniRoleCombat = gsAllAbyss = abyssTeam = hardTeam = holdRate = srGachaLog = placeholder
  if (globalThis.logger) logger.warn('[xhh-TL] miao-plugin not found, 8 features disabled')
}

export {
  TL, Abyss, teamDamage, role_combat, miniRoleCombat, gsAllAbyss, abyssTeam, hardTeam, holdRate,
  TmpCleaner, nanokaAbyss, help, resinPush, autoSign, autoBbsCoin,
  TLDelCkHook, srGachaLog, solverDeploy,
}
