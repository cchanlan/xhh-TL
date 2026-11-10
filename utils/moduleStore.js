/** 模块包只包含文件数据，不执行安装脚本。运行目录由核心文件位置确定。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import https from 'node:https'
import YAML from 'yaml'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const storeDir = path.join(root, 'data', 'module-manager')
export const stateFile = path.join(storeDir, 'state.json')
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
export const CORE_API = 2
export const CORE_VERSION = '2.1.3'
const RESERVED = new Set(['__proto__','constructor','prototype','tostring','valueof','hasownproperty','__definegetter__','__definesetter__'])
const validId = id => typeof id==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(id) && !RESERVED.has(id.toLowerCase())
function atLeast(actual,required){
  if(typeof required!=='string'||!/^\d+\.\d+\.\d+$/.test(required))return false
  const a=actual.split('.').map(Number),b=required.split('.').map(Number)
  for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false}return true
}
export const MAX_PACK = 64 * 1024 * 1024
export const MAX_CONTENT = 96 * 1024 * 1024
// 分片格式固定为 512 KiB，与模块仓 scripts/build.mjs 保持一致；旧目录也能下载。
export const PACKAGE_PART_SIZE = 512 * 1024
const DOWNLOAD_TIME = 300_000
const CONNECT_TIME = 20_000
const PROBE_TIME = 8_000
const DOWNLOAD_ATTEMPTS = 3
const PACKAGE_PARALLEL = 4
const SOURCE_SPEED_TTL = 15 * 60 * 1000
const RETRY_HTTP = new Set([408, 418, 429, 500, 502, 503, 504])
const BLOCK_HTTP = new Set([403, 418, 451])
const RETRY_NETWORK = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'])
// 429/418/403 这类是平台限流或风控，对每个分片都退避重试纯属浪费；本次进程内先冷落该源两分钟。
const THROTTLE_HTTP = new Set([403, 418, 429, 451])
const SOURCE_PENALTY = new Map()
const PENALTY_TIME = 2 * 60 * 1000
const SOURCES = Object.freeze({
  github: { label: 'GitHub', gitHosts: ['github.com', 'ssh.github.com'], hosts: ['raw.githubusercontent.com'], base: 'https://raw.githubusercontent.com/cchanlan/xhh-TL-modules/master/' },
  gitee: { label: 'Gitee', gitHosts: ['gitee.com', 'ssh.gitee.com'], hosts: ['gitee.com', 'raw.giteeusercontent.com'], base: 'https://gitee.com/longhengmu/xhh-TL-modules/raw/master/' },
  gitcode: { label: 'GitCode', gitHosts: ['gitcode.com', 'gitcode.net'], hosts: ['api.gitcode.com', 'raw.gitcode.com'] },
})
const SOURCE_IDS = Object.freeze(Object.keys(SOURCES))

/** 只识别平台，不使用远端中的用户、密码或仓库路径构造下载 URL。 */
export function moduleSourceForRemote(remote) {
  if (typeof remote !== 'string') return null
  let host
  try {
    const value = remote.trim()
    host = value.includes('://') ? new URL(value).hostname : /^(?:[^@\s]+@)?([^:/\s]+):/.exec(value)?.[1]
  } catch { return null }
  host = host?.toLowerCase()
  return Object.keys(SOURCES).find(id => SOURCES[id].gitHosts.includes(host)) || null
}

/** origin 优先；自用多远端工作树可用当前分支上游。zip/缺 git 时保留 GitHub 兜底。
 * 真机仅在 Linux/Node 24 验证；Windows 走无 shell 的参数数组与动态路径，不硬编码平台路径。
 */
export function getModuleSource(directory = root) {
  if (fs.existsSync(path.join(directory, '.git'))) {
    const git = args => {
      try { return execFileSync('git', args, { cwd: directory, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
      catch { return '' }
    }
    const origin = moduleSourceForRemote(git(['remote', 'get-url', 'origin']))
    if (origin) return origin
    const remotes = git(['remote']).split(/\r?\n/).filter(Boolean)
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const tracking = remotes.filter(name => upstream.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0]
    const selected = tracking && moduleSourceForRemote(git(['remote', 'get-url', tracking]))
    if (selected) return selected
    const sources = new Set(remotes.map(name => moduleSourceForRemote(git(['remote', 'get-url', name]))).filter(Boolean))
    if (sources.size === 1) return [...sources][0]
  }
  globalThis.logger?.debug?.('[xhh-TL][模块下载] 未识别到核心仓库来源，使用 GitHub')
  return 'github'
}
const CORE_FILES = new Set([
  'utils/moduleStore.js', 'utils/moduleManager.js', 'utils/moduleCatalog.js',
  'utils/modules.js', 'utils/pluginConfig.js', 'utils/render.js', 'utils/renderImage.js',
  'utils/replyHelper.js', 'utils/delivery.js', 'utils/taskLifecycle.js', 'utils/moduleOptional.js', 'apps/help.js', 'apps/manage.js',
].map(name=>name.toLowerCase()))

export function safeFile(name) {
  if (typeof name !== 'string' || !/^(apps|utils|resources)\/[A-Za-z0-9_\-./\u0080-￿]+$/.test(name)
    || name.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.') || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))
    || CORE_FILES.has(name.toLowerCase()) || name.toLowerCase().startsWith('resources/help/') || name.toLowerCase() === 'resources/icon.png') {
    throw new Error('模块文件路径不允许：' + String(name))
  }
  return name
}

export function managedPath(name) {
  safeFile(name)
  const target = path.join(root, ...name.split('/'))
  assertNoSymlink(target)
  return target
}

export function assertNoSymlink(target) {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('路径超出插件目录')
  let part = root
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('模块根目录不能是符号链接')
  for (const key of relative.split(path.sep).filter(Boolean)) {
    part = path.join(part, key)
    try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error('拒绝操作符号链接：' + part) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
}

export function atomicWrite(file, content) {
  assertNoSymlink(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    // Windows 的 fsync 需要可写句柄；只读句柄会抛出 EPERM。
    const fd = fs.openSync(temp, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temp, file)
  } finally { try { fs.unlinkSync(temp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
}
export function readJson(file) { assertNoSymlink(file); return JSON.parse(fs.readFileSync(file, 'utf8')) }
export function writeJson(file, value) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n') }

export function validateCatalog(data) {
  if (data?.schema !== 1 || data.coreApi !== CORE_API || !Array.isArray(data.modules) || data.modules.length > 300) throw new Error('请先更新小火花核心：模块目录版本不兼容')
  if(!atLeast(CORE_VERSION,data.minCoreVersion)||!atLeast(process.versions.node,data.minNodeVersion))throw new Error('请先更新小火花核心或 Node.js')
  const ids = new Set(), files = new Map()
  for (const m of data.modules) {
    if (!m || !validId(m.id) || ids.has(m.id) || typeof m.label !== 'string'
      || !/^[a-zA-Z0-9._-]{1,80}$/.test(m.version) || m.coreApi !== CORE_API
      || !Array.isArray(m.dependencies) || !Array.isArray(m.files) || m.files.length > 5000
      || !Array.isArray(m.entries) || m.entries.length > 10
      || !/^[a-f0-9]{64}$/.test(m.sha256) || m.package !== `packages/${m.id}/${m.version}.xhmp`
      || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_PACK) throw new Error('模块目录字段无效')
    if(!atLeast(CORE_VERSION,m.minCoreVersion)||!atLeast(process.versions.node,m.minNodeVersion))throw new Error('请先更新小火花核心或 Node.js')
    if(m.dependencies.some(id=>!validId(id))||new Set(m.dependencies).size!==m.dependencies.length)throw new Error('模块依赖标识无效')
    ids.add(m.id)
    for (const f of m.files) {
      safeFile(f.path)
      const canonical = f.path.toLowerCase()
      if (files.has(canonical)) throw new Error(`文件归属冲突：${f.path}`)
      if([...files.keys()].some(p=>p.startsWith(canonical+'/')||canonical.startsWith(p+'/')))throw new Error('模块文件与目录冲突')
      files.set(canonical, m.id)
      if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_CONTENT) throw new Error('文件校验清单无效')
    }
    if(m.files.reduce((n,f)=>n+f.size,0)>MAX_CONTENT)throw new Error('模块内容总量超限')
    for (const entry of m.entries) if (!m.files.some(f => f.path === entry.path) || !/^[A-Za-z_$][\w$]*$/.test(entry.export)) throw new Error('模块入口无效')
  }
  const map = new Map(data.modules.map(m => [m.id, m]))
  const visiting = new Set(), done = new Set()
  const visit = id => {
    if (visiting.has(id)) throw new Error('模块依赖成环')
    if (done.has(id)) return
    const m = map.get(id)
    if (!m) throw new Error('模块依赖不存在：' + id)
    visiting.add(id)
    for (const dep of m.dependencies) {
      visit(dep)
      if(m.dependencyVersions?.[dep] && m.dependencyVersions[dep] !== map.get(dep).version) throw new Error('模块依赖版本不匹配：'+m.id)
    }
    visiting.delete(id); done.add(id)
  }
  for (const id of ids) visit(id)
  return data
}

export function decodePackage(buffer, meta) {
  if (buffer.length !== meta.bytes || buffer.length > MAX_PACK || sha256(buffer) !== meta.sha256) throw new Error('模块包校验失败：' + meta.id)
  const raw = zlib.gunzipSync(buffer, { maxOutputLength: MAX_CONTENT })
  const pkg = JSON.parse(raw.toString('utf8'))
  if (pkg.schema !== 1 || pkg.id !== meta.id || pkg.version !== meta.version || !Array.isArray(pkg.files) || pkg.files.length !== meta.files.length) throw new Error('模块包内容不匹配')
  const expected = new Map(meta.files.map(f => [f.path, f])), result = new Map()
  for (const f of pkg.files) {
    safeFile(f.path)
    const e = expected.get(f.path)
    if (!e || result.has(f.path) || typeof f.content !== 'string' || f.content.length !== Math.ceil(e.size / 3) * 4) throw new Error('模块文件清单不匹配')
    const bytes = Buffer.from(f.content, 'base64')
    if (bytes.length !== e.size || bytes.toString('base64') !== f.content || sha256(bytes) !== e.sha256) throw new Error('模块文件校验失败：' + f.path)
    result.set(f.path, bytes)
  }
  return result
}

function validDownloadPath(relative) {
  return relative === 'catalog.json' || (typeof relative === 'string' && /^packages\/[a-z][a-z0-9_]*\/[a-zA-Z0-9._-]+\.xhmp(?:\.parts\/[0-9]{4}\.part)?$/.test(relative))
}
function downloadContext(source, options = {}) {
  if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(SOURCES, source)) throw new Error('模块下载来源无效')
  let proxy = process.env.HTTPS_PROXY || process.env.https_proxy || ''
  const userFile = path.join(root, 'config', 'config.yaml')
  if (fs.existsSync(userFile)) {
    const config = readJsonOrYaml(userFile)
    if (config.download_proxy) proxy = String(config.download_proxy).trim()
  }
  let agent
  if (proxy) {
    let url; try { url = new URL(proxy) } catch { throw new Error('下载代理地址无效') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('下载代理仅支持 HTTP 或 HTTPS')
    agent = new HttpsProxyAgent(url)
  }
  return {
    source, agent,
    timeout: options.timeout || CONNECT_TIME,
    attempts: options.attempts || DOWNLOAD_ATTEMPTS,
    probe: !!options.probe,
    deadline: Date.now() + (options.deadline || DOWNLOAD_TIME),
  }
}
function allowedDownloadURL(value, source) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !SOURCES[source].hosts.includes(url.hostname)) throw new Error('模块下载跳转地址不允许')
  return url
}
/** Retry-After 是等待下限；不缩短平台要求的等待，也不重置整包限时。 */
function retryDelay(headers, attempt) {
  const value = headers?.['retry-after']
  const numeric = typeof value === 'string' && /^\d+$/.test(value)
  const date = typeof value === 'string' && !numeric ? Date.parse(value) : NaN
  const requested = numeric ? Number(value) * 1000 : Number.isFinite(date) ? date - Date.now() : 0
  return Math.max(1000 * (2 ** (attempt - 1)), requested)
}
function logDownloadFailure(url, context, error, attempt, headers, delay) {
  const stage = url.hostname === 'api.gitcode.com' ? '文件信息' : '文件内容'
  // 不记录查询参数、Cookie、认证头或响应正文，避免跳转链接携带的凭据进入日志。
  const address = url.origin + url.pathname
  const details = ['server', 'content-type', 'retry-after', 'x-request-id', 'x-gitcode-request-id']
    .filter(key => typeof headers?.[key] === 'string')
    .map(key => key + '=' + headers[key].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160)).join(' ')
  const status = error.statusCode || (RETRY_NETWORK.has(error.code) ? error.code : error.message)
  const text = `[xhh-TL][模块下载] 来源=${SOURCES[context.source].label} 阶段=${stage} 地址=${address} 状态=${status} 尝试=${attempt}/${context.attempts} ${delay === null ? '停止下载' : `${delay}ms 后重试`} ${details}`
  // 测速阶段三个源并行试水，失败是家常便饭，只留 debug 免得刷屏。
  if (context.probe) globalThis.logger?.debug?.(text)
  else globalThis.logger?.warn?.(text)
}
/** 同一进程里只允许一个模块操作；moduleManager 用这个钩子让点击取消/停滞检测能立刻掐断正在跑的请求。 */
let cancelCheck = null
export function setDownloadCancelCheck(check) { cancelCheck = typeof check === 'function' ? check : null }
function throwIfCancelled() {
  if (cancelCheck?.()) throw Object.assign(new Error('模块操作已取消'), { cancelled: true, fatal: true })
}
/** 同平台 HTTPS 跳转上限 5 次；GET 临时失败最多三次，保持匿名访问与原有代理。 */
function requestBuffer(initial, limit, context) {
  return new Promise((resolve, reject) => {
    let settled = false, current, timer, retryTimer, cancelTimer
    const done = (error, bytes) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(retryTimer); clearInterval(cancelTimer)
      if (error) current?.destroy()
      error ? reject(error) : resolve(bytes)
    }
    // 黑洞代理下 TCP 连接可能干等 20 秒，单独轮询取消标记才能让「取消」秒级生效。
    cancelTimer = setInterval(() => {
      if (settled) { clearInterval(cancelTimer); return }
      if (cancelCheck?.()) { done(Object.assign(new Error('模块操作已取消'), { cancelled: true })) }
    }, 500)
    if (cancelTimer.unref) cancelTimer.unref()
    const visit = (value, redirects = 0, attempt = 1) => {
      if (settled) return
      if (cancelCheck?.()) { done(Object.assign(new Error('模块操作已取消'), { cancelled: true })); return }
      let url
      try { url = allowedDownloadURL(value, context.source) } catch (error) { done(error); return }
      let retired = false, hasResponse = false, request
      const fail = (error, headers = {}) => {
        if (settled || retired) return
        const retryable = RETRY_HTTP.has(error.statusCode) || RETRY_NETWORK.has(error.code)
        const delay = retryable && attempt < context.attempts ? retryDelay(headers, attempt) : null
        const remaining = context.deadline - Date.now()
        const canRetry = delay !== null && delay < remaining
        logDownloadFailure(url, context, error, attempt, headers, canRetry ? delay : null)
        if (!canRetry) { done(error); return }
        // 旧请求的 close/error/timeout 不能提前结束下一次重试或安排第二个定时器。
        retired = true; request?.destroy()
        retryTimer = setTimeout(() => visit(url.href, redirects, attempt + 1), delay)
      }
      const connectionFailure = message => Object.assign(new Error(message), { code: 'ECONNRESET' })
      try {
        request = https.get(url, { agent: context.agent, headers: { 'User-Agent': 'xhh-TL-module-manager/2' } }, response => {
          hasResponse = true
          let ended = false
          response.on('close', () => { if (!ended && !response.complete) fail(connectionFailure('下载连接提前关闭')) })
          response.on('aborted', () => fail(connectionFailure('下载连接中断')))
          response.on('error', error => fail(error))
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            let next
            try {
              if (redirects >= 5 || !response.headers.location) throw new Error('模块下载跳转过多或缺少地址')
              next = allowedDownloadURL(new URL(response.headers.location, url), context.source)
            } catch (error) { response.resume(); done(error); return }
            retired = true; response.resume(); request.destroy(); visit(next, redirects + 1, attempt); return
          }
          if (response.statusCode !== 200) {
            const error = Object.assign(new Error('模块源返回 HTTP ' + response.statusCode), { statusCode: response.statusCode })
            fail(error, response.headers); response.resume(); return
          }
          const declared = Number(response.headers['content-length'])
          if (Number.isFinite(declared) && declared > limit) { done(new Error('下载超过大小限制')); return }
          let received = 0
          const chunks = []
          response.on('data', chunk => {
            if (settled || retired) return
            if (cancelCheck?.()) { done(Object.assign(new Error('模块操作已取消'), { cancelled: true })); return }
            received += chunk.length
            if (received > limit) { done(new Error('下载超过大小限制')); return }
            chunks.push(chunk)
          })
          response.on('end', () => { ended = true; if (!retired) done(null, Buffer.concat(chunks)) })
        })
        current = request
        request.setTimeout(context.timeout, () => fail(Object.assign(new Error('下载连接长时间无数据'), { code: 'ETIMEDOUT' })))
        request.on('error', error => fail(error))
        request.on('close', () => { if (!hasResponse && current === request) fail(connectionFailure('下载连接提前关闭')) })
      } catch (error) { fail(error) }
    }
    const remaining = context.deadline - Date.now()
    if (remaining <= 0) { done(new Error('下载超时，请配置下载代理后重试')); return }
    timer = setTimeout(() => done(new Error('下载超时，请配置下载代理后重试')), remaining)
    visit(initial)
  })
}
const fatalError = message => Object.assign(new Error(message), { fatal: true })
async function downloadFromSource(relative, limit, context) {
  throwIfCancelled()
  if (!validDownloadPath(relative) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PACK) throw fatalError('下载目标或大小限制无效')
  let url
  if (context.source === 'gitcode') {
    // GitCode 的分支 raw 地址不支持二进制预览；公开 contents API 给出 Git blob SHA。
    // API 小包会连同 base64 内容返回，不能把元数据响应一律限制到 2 MiB。
    const endpoint = 'https://api.gitcode.com/api/v5/repos/ccxhan/xhh-TL-modules/contents/' + relative + '?ref=master'
    const metaLimit = Math.min(MAX_CONTENT, Math.ceil(limit / 3) * 4 + 64 * 1024)
    const info = JSON.parse((await requestBuffer(endpoint, metaLimit, context)).toString('utf8'))
    if (info.type !== 'file' || info.path !== relative || !/^[a-f0-9]{40}$/.test(info.sha) || !Number.isSafeInteger(info.size) || info.size > limit || info.size < 0) throw new Error('GitCode 模块文件信息无效')
    url = 'https://raw.gitcode.com/ccxhan/xhh-TL-modules/blobs/' + info.sha + '/' + relative
  } else url = SOURCES[context.source].base + relative
  return requestBuffer(url, limit, context)
}

let sourceRank = { at: 0, order: [] }
let sourceProbe = null

/** 三个平台同时实测同一个目录文件，按真实速度排序，10 分钟内复用结果。
 * 旧逻辑只在平台风控（403/418/451）时才换源：国内直连 GitHub 的 ECONNRESET 会在原地重试到超时，
 * 迁移几十个包全卡在这条路上，用户只看得到「模块操作进行中」。 */
async function probeSources() {
  const preferred = getModuleSource()
  const results = await Promise.all(SOURCE_IDS.map(async source => {
    const context = downloadContext(source, { timeout: PROBE_TIME, deadline: PROBE_TIME, attempts: 1, probe: true })
    const started = Date.now()
    try {
      const bytes = await downloadFromSource('catalog.json', 4 * 1024 * 1024, context)
      const ms = Math.max(1, Date.now() - started)
      return { source, ok: true, speed: bytes.length / ms }
    } catch (error) {
      return { source, ok: false, error }
    } finally { context.agent?.destroy() }
  }))
  // 速度接近时偏向核心仓库所在平台，免得测速抖动导致每次换源；差距大就老老实实按实测快的来。
  const score = item => item.speed * (item.source === preferred ? 1.2 : 1)
  const ready = results.filter(item => item.ok).sort((a, b) => score(b) - score(a)).map(item => item.source)
  const failed = results.filter(item => !item.ok).map(item => item.source)
  const order = ready.length ? [...ready, ...failed] : [preferred, ...SOURCE_IDS.filter(id => id !== preferred)]
  sourceRank = { at: Date.now(), order, speeds: new Map(results.filter(item => item.ok).map(item => [item.source, item.speed])) }
  const speeds = results.filter(item => item.ok).sort((a, b) => score(b) - score(a))
    // speed 的单位是 B/ms，数值上就是 KB/s。
    .map(item => `${SOURCES[item.source].label} ${Math.max(1, Math.round(item.speed))}KB/s`)
  globalThis.logger?.mark?.(`[xhh-TL][模块下载] 测速 ${speeds.join('，') || '无可用源'}；顺序 ${order.map(id => SOURCES[id].label).join(' → ')}`)
  return order
}

export async function rankSources() {
  if (sourceRank.order.length && Date.now() - sourceRank.at < SOURCE_SPEED_TTL) return sourceRank.order
  if (!sourceProbe) sourceProbe = probeSources().finally(() => { sourceProbe = null })
  return sourceProbe
}

async function candidateSources(preferred) {
  const ranked = await rankSources()
  const list = preferred ? [preferred, ...ranked.filter(id => id !== preferred)] : [...ranked]
  const now = Date.now()
  // 被限流的源排到最后，但仍保留：三个源全被限时还得能试。
  return [...list.filter(id => !(SOURCE_PENALTY.get(id) > now)), ...list.filter(id => SOURCE_PENALTY.get(id) > now)]
}

/** 按测速速度给每个源单独算限时：快源留有富余，慢源别拖满全局超时，换源时重新计时。 */
function sourceDeadline(source, bytes) {
  const speed = sourceRank.speeds?.get(source)
  if (!speed || !Number.isFinite(speed) || speed <= 0) return DOWNLOAD_TIME
  // 测速是单流速度，分片并发通常更快；乘二再加固定开销当余量。
  return Math.max(60_000, Math.min(DOWNLOAD_TIME, Math.round(bytes / speed * 2) + 30_000))
}

/** 一个源失败（风控、超时、连不上、包损坏）就换下一个；包内容最后仍由目录里的 sha256 校验。 */
async function withSourceFallback(candidates, run) {
  let lastError
  for (let index = 0; index < candidates.length; index++) {
    const source = candidates[index]
    try { return await run(source) }
    catch (error) {
      lastError = error
      if (error?.fatal || error?.cancelled) throw error
      if (THROTTLE_HTTP.has(error.statusCode)) {
        SOURCE_PENALTY.set(source, Date.now() + PENALTY_TIME)
        globalThis.logger?.warn?.(`[xhh-TL][模块下载] ${SOURCES[source].label} 被限流（HTTP ${error.statusCode}），2 分钟内优先用其他源`)
      }
      if (index === candidates.length - 1) break
      const reason = error.statusCode || error.code || error.message
      globalThis.logger?.warn?.(`[xhh-TL][模块下载] ${SOURCES[source].label} 失败（${reason}），改用 ${SOURCES[candidates[index + 1]].label}`)
    }
  }
  if (lastError && BLOCK_HTTP.has(lastError.statusCode)) throw new Error('模块下载被平台拦截，请在锅巴配置模块下载代理后重试')
  const reason = lastError?.statusCode ? `HTTP ${lastError.statusCode}` : lastError?.message || '未知错误'
  throw new Error(`所有下载源都失败了（${reason}），请检查网络或在锅巴配置模块下载代理后重试`)
}

/** Gitee 分片串行下 25MB 素材包要跑 49 个来回，这里开多路把分片抓齐再拼。三平台仓库都带分片目录。 */
async function downloadParts(meta, context, parallel = PACKAGE_PARALLEL) {
  const total = Math.ceil(meta.bytes / PACKAGE_PART_SIZE)
  const chunks = new Array(total)
  let cursor = 0, failure
  const worker = async () => {
    while (!failure) {
      if (cancelCheck?.()) { failure = Object.assign(new Error('模块操作已取消'), { cancelled: true, fatal: true }); return }
      const index = cursor++
      if (index >= total) return
      const offset = index * PACKAGE_PART_SIZE
      const size = Math.min(PACKAGE_PART_SIZE, meta.bytes - offset)
      const relative = meta.package + '.parts/' + String(index + 1).padStart(4, '0') + '.part'
      try {
        const part = await downloadFromSource(relative, size, context)
        if (part.length !== size) throw Object.assign(new Error('模块包分片大小不匹配：' + meta.id), { fatal: true })
        chunks[index] = part
      } catch (error) { failure = failure || error; return }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, total) }, () => worker()))
  if (failure) throw failure
  return Buffer.concat(chunks, meta.bytes)
}

/** 下载目录/文件：先并发测速挑最快的平台，失败再按顺序换源。 */
export async function download(relative, limit = MAX_PACK, source) {
  const candidates = await candidateSources(source)
  const context = downloadContext(candidates[0])
  globalThis.logger?.debug?.(`[xhh-TL][模块下载] 来源顺序 ${candidates.map(id => SOURCES[id].label).join(' → ')}，文件 ${relative}`)
  try {
    return await withSourceFallback(candidates, candidate => downloadFromSource(relative, limit, {
      ...context, source: candidate, deadline: Date.now() + sourceDeadline(candidate, limit),
    }))
  }
  finally { context.agent?.destroy() }
}

/** Gitee 超过小文件上限会要求登录；固定分片匿名下载，拼回原包后校验。 */
export async function downloadPackage(meta, source) {
  if (!meta || !validId(meta.id) || typeof meta.version !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(meta.version) || meta.package !== `packages/${meta.id}/${meta.version}.xhmp` || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || meta.bytes > MAX_PACK || !/^[a-f0-9]{64}$/.test(meta.sha256)) throw new Error('模块包信息无效')
  const candidates = await candidateSources(source)
  const context = downloadContext(candidates[0])
  globalThis.logger?.debug?.(`[xhh-TL][模块下载] 来源顺序 ${candidates.map(id => SOURCES[id].label).join(' → ')}，模块 ${meta.id}`)
  try {
    return await withSourceFallback(candidates, async candidate => {
      const ctx = { ...context, source: candidate, deadline: Date.now() + sourceDeadline(candidate, meta.bytes) }
      let buffer
      if (meta.bytes > PACKAGE_PART_SIZE) {
        try { buffer = await downloadParts(meta, ctx, candidate === 'gitcode' ? 2 : 4) }
        catch (error) {
          if (error?.fatal) throw error
          // 只有「源上确实没有分片目录」才退回整包；网络抖动/风控交给换源，别在坏源上再耗一轮。
          if (error?.statusCode !== 404) throw error
          globalThis.logger?.warn?.(`[xhh-TL][模块下载] ${SOURCES[candidate].label} 没有分片文件，改用整包`)
          buffer = await downloadFromSource(meta.package, meta.bytes, ctx)
        }
      } else buffer = await downloadFromSource(meta.package, meta.bytes, ctx)
      if (buffer.length !== meta.bytes || sha256(buffer) !== meta.sha256) throw new Error('模块包校验失败：' + meta.id)
      return buffer
    })
  } finally { context.agent?.destroy() }
}
function readJsonOrYaml(file){assertNoSymlink(file);return YAML.parse(fs.readFileSync(file,'utf8'))||{}}
