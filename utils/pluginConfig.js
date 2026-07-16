/**
 * 插件配置读取 + CK/SToken 路径解析
 *
 * 配置分层：
 * - config/default_config.yaml  仓库默认（可随版本更新）
 * - config/config.yaml          用户配置（gitignore，更新不覆盖）
 * 读取时：default 与 user 浅合并，user 优先
 */

import fs from 'fs'
import path from 'path'
import YAML from 'yaml'

const pluginDir = path.join(process.cwd(), 'plugins/xhh-TL')
const configDir = path.join(pluginDir, 'config')
const defaultConfigPath = path.join(configDir, 'default_config.yaml')
const userConfigPath = path.join(configDir, 'config.yaml')
/** @deprecated 兼容旧名 */
const configPath = userConfigPath

/** 默认 stoken/ck 搜索目录（相对 Yunzai 根，或绝对路径） */
export const DEFAULT_STOKEN_DIRS = [
  'plugins/xhh/data/Stoken',
  'plugins/xiaoyao-cvs-plugin/data/yaml',
  'plugins/xhh-TL/data/Stoken',
]

/** 默认崩三绑定保存目录 */
export const DEFAULT_BH3_STOKEN_DIR = 'plugins/xhh-TL/data/Stoken'

let _cache = null
let _cacheKey = ''

function parseYamlFile(file) {
  try {
    if (fs.existsSync(file)) {
      return YAML.parse(fs.readFileSync(file, 'utf-8')) || {}
    }
  } catch (_) {}
  return {}
}

function fileMtime(file) {
  try {
    if (fs.existsSync(file)) return String(fs.statSync(file).mtimeMs)
  } catch (_) {}
  return '0'
}

/** 确保用户配置存在：缺失时从 default 复制；有用户文件则不动 */
export function ensureUserConfig() {
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
    if (!fs.existsSync(userConfigPath)) {
      if (fs.existsSync(defaultConfigPath)) {
        fs.copyFileSync(defaultConfigPath, userConfigPath)
      } else {
        fs.writeFileSync(userConfigPath, YAML.stringify({ Tl: true }), 'utf-8')
      }
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.warn?.(`[xhh-TL] 初始化用户配置失败: ${err.message}`)
    }
  }
}

/**
 * 将 default 中用户尚未配置的键补进 config.yaml（不覆盖已有值）
 * 版本更新后出现新配置项时调用
 */
export function mergeMissingDefaults() {
  ensureUserConfig()
  const defaults = parseYamlFile(defaultConfigPath)
  const user = parseYamlFile(userConfigPath)
  let changed = false
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in user)) {
      user[k] = v
      changed = true
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(userConfigPath, YAML.stringify(user), 'utf-8')
      _cache = null
    } catch (_) {}
  }
  return user
}

/** 读合并后的完整配置（default + user，user 优先） */
export function readPluginConfig() {
  ensureUserConfig()
  const key = `${fileMtime(defaultConfigPath)}|${fileMtime(userConfigPath)}`
  if (_cache && _cacheKey === key) return _cache

  const defaults = parseYamlFile(defaultConfigPath)
  const user = parseYamlFile(userConfigPath)
  _cache = { ...defaults, ...user }
  _cacheKey = key
  return _cache
}

/** Clamp the configured output quality to the range accepted by image encoders. */
export function getImageQuality(config = {}, fallback = 100) {
  const value = Number(config?.img_quality)
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(1, Math.round(value)))
}

/** Resolve the plugin-side lossless post-render upscale factor. */
export function getRenderScale(config = {}, fallback = 1) {
  const value = Number(config?.render_scale)
  if (!Number.isFinite(value)) return fallback
  return Number(Math.min(2, Math.max(1, value)).toFixed(2))
}

/** 强制刷新缓存 */
export function reloadPluginConfig() {
  _cache = null
  _cacheKey = ''
  return readPluginConfig()
}

/** 只读用户文件（不含 default 合并），锅巴用 */
export function readUserConfig() {
  ensureUserConfig()
  return parseYamlFile(userConfigPath)
}

/** 写入用户配置（只写 config.yaml，不碰 default） */
export function writeUserConfig(data) {
  ensureUserConfig()
  const next = data && typeof data === 'object' ? data : {}
  fs.writeFileSync(userConfigPath, YAML.stringify(next), 'utf-8')
  _cache = null
  _cacheKey = ''
}

/** 合并写入用户配置中的若干字段 */
export function patchUserConfig(partial) {
  const user = readUserConfig()
  Object.assign(user, partial || {})
  writeUserConfig(user)
  return user
}

/**
 * 解析路径：绝对路径原样；相对路径相对 process.cwd()
 */
export function resolvePluginPath(p) {
  if (!p || typeof p !== 'string') return ''
  const s = p.trim()
  if (!s) return ''
  if (path.isAbsolute(s)) return s
  return path.join(process.cwd(), s)
}

/**
 * 将配置值规范为字符串数组
 * 支持：数组 / 换行 / 逗号 / 分号 分隔
 */
export function parsePathList(value) {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean)
  }
  return String(value)
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 获取 stoken/ck 搜索目录列表（已 resolve 为绝对路径）
 * 配置项：stoken_paths
 */
export function getStokenDirs() {
  const cfg = readPluginConfig()
  let list = parsePathList(cfg.stoken_paths)
  if (!list.length) list = [...DEFAULT_STOKEN_DIRS]
  return list.map(resolvePluginPath).filter(Boolean)
}

/**
 * 崩三 stoken 保存/读取目录
 * 配置项：bh3_stoken_dir
 */
export function getBh3StokenDir() {
  const cfg = readPluginConfig()
  const dir = cfg.bh3_stoken_dir || DEFAULT_BH3_STOKEN_DIR
  return resolvePluginPath(dir)
}

/**
 * 某 QQ 的 stoken yaml 候选文件（按目录优先级）
 */
export function getStokenCandidateFiles(qq) {
  const id = String(qq)
  return getStokenDirs().map((dir) => path.join(dir, `${id}.yaml`))
}

/**
 * 找到第一个存在的 stoken 文件
 */
export function findStokenFile(qq) {
  for (const f of getStokenCandidateFiles(qq)) {
    if (fs.existsSync(f)) return f
  }
  return null
}

/**
 * 读取某 QQ 的 stoken yaml 对象；不存在返回 null
 */
export function loadStokenYaml(qq) {
  const file = findStokenFile(qq)
  if (!file) return null
  try {
    return YAML.parse(fs.readFileSync(file, 'utf-8')) || {}
  } catch (_) {
    return null
  }
}

// 模块加载时：确保用户配置存在，并补全新默认键
try {
  mergeMissingDefaults()
} catch (_) {}

export {
  pluginDir,
  configDir,
  defaultConfigPath,
  userConfigPath,
  configPath,
}
