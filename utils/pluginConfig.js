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
import { pathToFileURL, fileURLToPath } from 'url'
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
  // mtime 作缓存键：锅巴/手改 yaml 后无需 fs.watch，下次读取自动失效
  const key = `${fileMtime(defaultConfigPath)}|${fileMtime(userConfigPath)}`
  if (_cache && _cacheKey === key) return _cache

  const defaults = parseYamlFile(defaultConfigPath)
  const user = parseYamlFile(userConfigPath)
  _cache = { ...defaults, ...user }
  _cacheKey = key
  return _cache
}

/**
 * 业务侧统一入口（与 readPluginConfig 相同，语义更短）
 * 各 app 请 import { config }，勿再本地包装 / fs.watch
 */
export function config() {
  return readPluginConfig()
}

/** Resolve the global render multiplier. */
export function getRenderScale(config = {}, fallback = 1) {
  const value = Number(config?.render_scale)
  if (!Number.isFinite(value)) return fallback
  return Number(Math.min(1.5, Math.max(0.8, value)).toFixed(2))
}

/** Match earth-k-plugin: template base scale multiplied by a global adjustment. */
export function getRenderScaleStyle(config = {}, baseScale = 1) {
  // 上限 2.5：兼顾清晰度与体积；可通过 render_scale 全局微调
  const scale = Math.min(2.5, Math.max(1, baseScale * getRenderScale(config, 1)))
  return `style=transform:scale(${Number(scale.toFixed(2))})`
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
 * 规范化用户输入路径（锅巴/yaml 常带引号、混用斜杠、Windows 盘符）
 */
export function normalizeUserPath(p) {
  if (p == null) return ''
  let s = String(p).trim()
  if (!s) return ''
  // 去掉成对引号 / 反引号
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('`') && s.endsWith('`'))
  ) {
    s = s.slice(1, -1).trim()
  }
  // 配置里统一用 /，避免 Win 反斜杠写进 yaml 后在 Linux 失效；path 模块会再按本机规范化
  s = s.replace(/\\/g, '/')
  return s
}

/**
 * 解析路径：绝对路径原样；相对路径相对 process.cwd()（Yunzai 根）
 * Windows 兼容盘符路径与混用斜杠
 */
export function resolvePluginPath(p) {
  const s = normalizeUserPath(p)
  if (!s) return ''
  if (path.isAbsolute(s)) return path.normalize(s)
  return path.normalize(path.join(process.cwd(), s))
}

/**
 * 本地文件 → Chromium 可用的 file URL
 * Windows 必须是 file:///C:/path，不能是 file://C:\path
 */
export function toFileUrl(filePath) {
  const abs = resolvePluginPath(filePath)
  if (!abs) return ''
  try {
    // Node 内置，正确处理 Windows 盘符与空格
    return pathToFileURL(abs).href
  } catch (_) {
    const normalized = abs.replace(/\\/g, '/')
    if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`
    if (normalized.startsWith('/')) return `file://${normalized}`
    return `file:///${normalized}`
  }
}

/** 常见图片扩展名 → MIME */
const IMG_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/**
 * 本地图片 → base64 data URI（内联进 HTML）
 * 用于 CSS background-image：file:// 背景图不阻塞 puppeteer 截图，
 * 偶发会截到背景尚未解码完成的一帧；内联 data URI 后像素随 HTML 一起到位，消除该竞态。
 * 入参支持 file URL 或本地路径；失败或非本地文件时原样返回入参。
 * @param {string} input file URL / 本地路径
 * @returns {string} data URI 或原始入参
 */
export function toDataUrl(input) {
  if (!input) return ''
  const raw = String(input)
  // 已是 data URI 直接返回
  if (raw.startsWith('data:')) return raw
  let abs = raw
  if (raw.startsWith('file://')) {
    try {
      abs = fileURLToPath(raw)
    } catch (_) {
      return raw
    }
  } else if (/^https?:\/\//i.test(raw)) {
    // 远程图不内联
    return raw
  } else {
    abs = resolvePluginPath(raw)
  }
  try {
    if (!abs || !fs.existsSync(abs)) return raw
    const mime = IMG_MIME[path.extname(abs).toLowerCase()] || 'image/png'
    const b64 = fs.readFileSync(abs).toString('base64')
    return `data:${mime};base64,${b64}`
  } catch (_) {
    return raw
  }
}

/** sharp 实例缓存（动态导入，避免可选依赖缺失时报错） */
let _sharpMod
async function loadSharp() {
  if (_sharpMod !== undefined) return _sharpMod
  try {
    _sharpMod = (await import('sharp')).default
  } catch (_) {
    _sharpMod = null
  }
  return _sharpMod
}

/** 裁剪结果缓存：key = 绝对路径 + mtime，value = data URI */
const _trimCache = new Map()

/**
 * 本地图片 → 裁掉四周透明边后的 base64 data URI（内联进 HTML）
 * 用途：部分立绘是抠图素材，左右/上下留有透明边，铺进横幅时透明处会露出底色，
 * 且角色会偏离视觉中心。先用 sharp 去掉透明边，图片变实心后 CSS `cover` 即可铺满并居中。
 * 仅裁剪“完全透明”的边（指定透明背景），不透明图不受影响；sharp 不可用或失败时回退 toDataUrl。
 * @param {string} input file URL / 本地路径
 * @returns {Promise<string>} data URI 或原始入参
 */
export async function toDataUrlTrim(input) {
  if (!input) return ''
  const raw = String(input)
  if (raw.startsWith('data:')) return raw
  if (/^https?:\/\//i.test(raw)) return raw

  let abs = raw
  if (raw.startsWith('file://')) {
    try {
      abs = fileURLToPath(raw)
    } catch (_) {
      return toDataUrl(raw)
    }
  } else {
    abs = resolvePluginPath(raw)
  }
  if (!abs || !fs.existsSync(abs)) return toDataUrl(raw)

  const sharp = await loadSharp()
  if (!sharp) return toDataUrl(abs)

  try {
    const mtime = fs.statSync(abs).mtimeMs
    const key = `${abs}:${mtime}`
    const cached = _trimCache.get(key)
    if (cached) return cached

    const buf = await sharp(abs)
      // 仅裁剪与“全透明”匹配的边，不透明图无匹配边 → 原样保留
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
      .webp({ quality: 90 })
      .toBuffer()
    const uri = `data:image/webp;base64,${buf.toString('base64')}`
    _trimCache.set(key, uri)
    return uri
  } catch (_) {
    // 裁剪失败（如整图透明导致空结果）回退原图内联
    return toDataUrl(abs)
  }
}

/** 插件内置默认背景（相对 Yunzai 根，跨平台 / 统一） */
export const DEFAULT_ROLE_COMBAT_BG = 'plugins/xhh-TL/resources/stat/imgs/bg1.png'

/** 帮助图默认背景（相对 Yunzai 根，跨平台 / 统一） */
export const DEFAULT_HELP_BG = 'plugins/xhh-TL/resources/stat/imgs/bg2.png'

/**
 * 解析帮助图背景路径 help_bg
 * - 支持单张图片文件
 * - 支持目录（随机抽一张图）
 * - 相对路径优先相对 Yunzai 根，再尝试插件目录
 * Linux / Windows 均可用正斜杠
 * @returns {{ abs: string, kind: 'file'|'dir'|'' }}
 */
export function resolveHelpBgPath(raw) {
  return resolveRoleCombatBgPath(raw)
}

/**
 * 从帮助背景配置取一张图，返回 file URL；失败回退 DEFAULT_HELP_BG
 * 支持：单张图片 / 目录随机
 */
export function pickHelpBgImage(opts = {}) {
  const cfg = readPluginConfig()
  const tag = opts.logTag || 'xhh-TL'
  const raw = (cfg.help_bg && String(cfg.help_bg).trim()) || DEFAULT_HELP_BG

  const { abs, kind } = resolveHelpBgPath(raw)
  if (!abs || !kind) {
    if (raw !== DEFAULT_HELP_BG) {
      const fallback = resolveHelpBgPath(DEFAULT_HELP_BG)
      if (fallback.kind === 'file') return toFileUrl(fallback.abs)
    }
    if (typeof logger !== 'undefined') {
      logger.warn?.(`[${tag}] 帮助背景路径不存在: ${raw} → ${abs}`)
    }
    return ''
  }

  if (kind === 'file') return toFileUrl(abs)

  // 目录：随机抽图
  try {
    const imgs = []
    for (const item of fs.readdirSync(abs)) {
      const full = path.join(abs, item)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && /\.(jpe?g|png|webp|gif|bmp)$/i.test(item)) {
          imgs.push(full)
          continue
        }
        if (st.isDirectory()) {
          for (const f of fs.readdirSync(full)) {
            if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(f)) imgs.push(path.join(full, f))
          }
        }
      } catch (_) {}
    }
    if (!imgs.length) {
      const fallback = resolveHelpBgPath(DEFAULT_HELP_BG)
      if (fallback.kind === 'file') return toFileUrl(fallback.abs)
      if (typeof logger !== 'undefined') {
        logger.warn?.(`[${tag}] 帮助背景目录无图片: ${abs}`)
      }
      return ''
    }
    const pick = imgs[Math.floor(Math.random() * imgs.length)]
    return toFileUrl(pick)
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.error?.(`[${tag}] 加载帮助背景失败:`, err)
    }
    const fallback = resolveHelpBgPath(DEFAULT_HELP_BG)
    return fallback.kind === 'file' ? toFileUrl(fallback.abs) : ''
  }
}

/**
 * 解析剧诗/全部深渊背景路径 role_combat_bg_folder
 * - 支持目录（子文件夹=角色名，随机抽图）
 * - 支持单张图片文件（如插件自带 bg1.png）
 * - 相对路径优先相对 Yunzai 根，再尝试插件目录
 * Linux / Windows 均可用正斜杠
 * @returns {{ abs: string, kind: 'file'|'dir'|'' }}
 */
export function resolveRoleCombatBgPath(raw) {
  const s = normalizeUserPath(raw)
  if (!s) return { abs: '', kind: '' }

  const candidates = []
  if (path.isAbsolute(s)) {
    candidates.push(path.normalize(s))
  } else {
    candidates.push(path.normalize(path.join(process.cwd(), s)))
    candidates.push(path.normalize(path.join(pluginDir, s)))
    // 兼容写成 resources/...（相对插件）
    if (!s.startsWith('plugins/') && !s.startsWith('plugins\\')) {
      candidates.push(path.normalize(path.join(pluginDir, s)))
    }
  }

  for (const c of candidates) {
    try {
      if (!c || !fs.existsSync(c)) continue
      const st = fs.statSync(c)
      if (st.isFile()) return { abs: c, kind: 'file' }
      if (st.isDirectory()) return { abs: c, kind: 'dir' }
    } catch (_) {}
  }
  return { abs: candidates[0] || '', kind: '' }
}

/** @deprecated 兼容旧名：只返回目录绝对路径（文件则返回空） */
export function resolveRoleCombatBgFolder(raw) {
  const { abs, kind } = resolveRoleCombatBgPath(raw)
  return kind === 'dir' ? abs : ''
}

/**
 * 从背景配置随机挑一张图，返回 file URL；失败返回 ''
 * 支持：
 * 1) 单张图片路径（默认 bg1.png）
 * 2) 目录：子文件夹名为角色名，内含 jpg/png/webp；也可直接在目录下放图
 * @param {object} [opts]
 * @param {(name: string) => boolean} [opts.filterDir] 过滤子目录名
 * @param {string} [opts.logTag]
 */
export function pickRoleCombatBgImage(opts = {}) {
  const cfg = readPluginConfig()
  const tag = opts.logTag || 'xhh-TL'
  // 优先 opts.folder（调用方显式指定），其次用户配置，最后插件内置默认图
  const raw = (opts.folder && String(opts.folder).trim())
    || (cfg.role_combat_bg_folder && String(cfg.role_combat_bg_folder).trim())
    || DEFAULT_ROLE_COMBAT_BG

  const { abs, kind } = resolveRoleCombatBgPath(raw)
  if (!abs || !kind) {
    // 再兜底一次内置默认图
    if (raw !== DEFAULT_ROLE_COMBAT_BG) {
      const fallback = resolveRoleCombatBgPath(DEFAULT_ROLE_COMBAT_BG)
      if (fallback.kind === 'file') return toFileUrl(fallback.abs)
    }
    if (typeof logger !== 'undefined') {
      logger.warn?.(`[${tag}] 背景路径不存在: ${raw} → ${abs}`)
    }
    return ''
  }

  // 单文件：直接用
  if (kind === 'file') return toFileUrl(abs)

  // 目录：随机抽图
  try {
    const collect = (filter) => {
      const imgs = []
      for (const item of fs.readdirSync(abs)) {
        const full = path.join(abs, item)
        let st
        try {
          st = fs.statSync(full)
        } catch (_) {
          continue
        }
        if (!st.isDirectory()) continue
        if (filter && !filter(item)) continue
        let files = []
        try {
          files = fs.readdirSync(full).filter((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f))
        } catch (_) {
          continue
        }
        for (const f of files) imgs.push(path.join(full, f))
      }
      return imgs
    }

    let imgs = collect(opts.filterDir || null)
    // 过滤过严时回退扫全部子目录
    if (!imgs.length && opts.filterDir) imgs = collect(null)
    // 也允许目录下直接放图片（无角色子文件夹）
    if (!imgs.length) {
      try {
        imgs = fs
          .readdirSync(abs)
          .filter((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f))
          .map((f) => path.join(abs, f))
      } catch (_) {}
    }
    if (!imgs.length) {
      // 目录空 → 回退内置默认图
      const fallback = resolveRoleCombatBgPath(DEFAULT_ROLE_COMBAT_BG)
      if (fallback.kind === 'file') return toFileUrl(fallback.abs)
      if (typeof logger !== 'undefined') {
        logger.warn?.(`[${tag}] 背景目录无图片: ${abs}`)
      }
      return ''
    }
    const pick = imgs[Math.floor(Math.random() * imgs.length)]
    return toFileUrl(pick)
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.error?.(`[${tag}] 加载背景图失败:`, err)
    }
    const fallback = resolveRoleCombatBgPath(DEFAULT_ROLE_COMBAT_BG)
    return fallback.kind === 'file' ? toFileUrl(fallback.abs) : ''
  }
}

/** 立绘卡默认立绘目录（miao-plugin 角色面板图） */
export const DEFAULT_TL_PORTRAIT_FOLDER =
  'plugins/miao-plugin/resources/profile/normal-character'

/** 绝区零立绘卡默认角色图目录（插件内置 zzzrole，平铺 IconRole*.png） */
export const DEFAULT_TL_ZZZ_PORTRAIT_FOLDER = 'plugins/xhh-TL/resources/zzzrole'

/** 鸣潮立绘卡默认角色图目录（插件内置 ww_role_pile，子目录=角色ID） */
export const DEFAULT_TL_WW_PORTRAIT_FOLDER = 'plugins/xhh-TL/resources/ww_role_pile'

/** 原神/星铁角色名清单缓存（用于按游戏过滤立绘目录） */
const _charNameCache = { gs: null, sr: null }

/**
 * 读取 miao-plugin 某游戏的角色名清单（目录名）
 * @param {'gs'|'sr'} game
 * @returns {Set<string>|null}
 */
function getMiaoCharNames(game) {
  if (_charNameCache[game]) return _charNameCache[game]
  const metaDir = game === 'sr' ? 'meta-sr' : 'meta-gs'
  const abs = path.join(process.cwd(), 'plugins/miao-plugin/resources', metaDir, 'character')
  try {
    if (!fs.existsSync(abs)) return null
    const names = new Set()
    for (const item of fs.readdirSync(abs)) {
      try {
        if (fs.statSync(path.join(abs, item)).isDirectory()) names.add(item)
      } catch (_) {}
    }
    if (!names.size) return null
    _charNameCache[game] = names
    return names
  } catch (_) {
    return null
  }
}

/**
 * 按游戏挑一张角色立绘，返回 file URL（失败返回 ''）
 * - gs/sr：从 tl_portrait_folder 随机抽图，用 meta-gs / meta-sr 角色名过滤子目录
 * - zzz：从 tl_zzz_portrait_folder（默认 resources/zzzrole）随机抽图；支持平铺图片
 * - ww：从 tl_ww_portrait_folder（默认 resources/ww_role_pile）随机抽图；子目录名是角色ID，不过滤
 * - 清单缺失时不过滤，退化为整目录随机
 * @param {'gs'|'sr'|'zzz'|'ww'} game
 * @param {object} [opts]
 */
export function pickCharacterPortrait(game, opts = {}) {
  const cfg = readPluginConfig()
  if (game === 'zzz') {
    const folder =
      (cfg.tl_zzz_portrait_folder && String(cfg.tl_zzz_portrait_folder).trim()) ||
      DEFAULT_TL_ZZZ_PORTRAIT_FOLDER
    return pickRoleCombatBgImage({
      folder,
      logTag: opts.logTag || 'xhh-TL:portrait-zzz',
    })
  }
  if (game === 'ww') {
    const folder =
      (cfg.tl_ww_portrait_folder && String(cfg.tl_ww_portrait_folder).trim()) ||
      DEFAULT_TL_WW_PORTRAIT_FOLDER
    return pickRoleCombatBgImage({
      folder,
      logTag: opts.logTag || 'xhh-TL:portrait-ww',
    })
  }

  const folder =
    (cfg.tl_portrait_folder && String(cfg.tl_portrait_folder).trim()) ||
    DEFAULT_TL_PORTRAIT_FOLDER

  const names = getMiaoCharNames(game === 'sr' ? 'sr' : 'gs')
  const filterDir = names ? (name) => names.has(name) : null

  return pickRoleCombatBgImage({
    folder,
    filterDir,
    logTag: opts.logTag || 'xhh-TL:portrait',
  })
}

/** 立绘卡底图默认路径 */
export const DEFAULT_TL_PORTRAIT_BG = 'plugins/xhh-TL/resources/stat/imgs/bg1.png'

/**
 * 立绘卡底图，返回 file URL（失败返回 ''）
 * 配置项 tl_portrait_bg：支持单张图片文件或目录（目录则随机抽一张）
 * @param {object} [opts]
 */
export function pickPortraitBg(opts = {}) {
  const cfg = readPluginConfig()
  const folder =
    (cfg.tl_portrait_bg && String(cfg.tl_portrait_bg).trim()) ||
    DEFAULT_TL_PORTRAIT_BG
  return pickRoleCombatBgImage({
    folder,
    logTag: opts.logTag || 'xhh-TL:portraitBg',
  })
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
