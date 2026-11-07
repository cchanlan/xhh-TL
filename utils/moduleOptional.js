/** 可选扩展不安装时不 import，保持主模块可独立运行。 */
import { isInstalled, recordModuleError } from './moduleManager.js'
import { isModuleEnabled } from './modules.js'
// 可选扩展损坏时只停用自身，不能让共享此适配器的体力功能一起加载失败。
async function loadOptional(id, file) {
  if (!isInstalled(id)) return {}
  try { return await import(file) }
  catch (error) { recordModuleError(id, error); return {} }
}
const waves = await loadOptional('waves', './wavesData.js')
const timer = await loadOptional('resin_timer', './resinTimer.js')
export const isWavesTlEnabled = (...a) => isModuleEnabled('waves') && !!waves.isWavesTlEnabled?.(...a)
export const getWavesEnvError = (...a) => waves.getWavesEnvError?.(...a) || '请在锅巴安装鸣潮体力模块'
export const listWavesAccounts = (...a) => isWavesTlEnabled() ? waves.listWavesAccounts(...a) : Promise.resolve([])
export const getWavesStaminaList = (...a) => isWavesTlEnabled() ? waves.getWavesStaminaList(...a) : Promise.resolve([])
export const fetchWavesStamina = (...a) => isWavesTlEnabled() ? waves.fetchWavesStamina(...a) : Promise.resolve(null)
export const recordResinTimer = (...a) => timer.recordResinTimer?.(...a)
export const registerReminderHooks = (...a) => timer.registerReminderHooks?.(...a)
export const scheduleTimers = (...a) => timer.scheduleTimers?.(...a)
export const refreshUidTimers = (...a) => timer.refreshUidTimers?.(...a)
export const timerStats = (...a) => timer.timerStats?.(...a) || {}
export const timerSnapshot = (...a) => timer.timerSnapshot?.(...a) || null
export const evaluateSnapshot = (...a) => timer.evaluateSnapshot?.(...a) || null
