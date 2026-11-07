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
export const CORE_VERSION = '2.1.1'
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
const DOWNLOAD_TIME = 600_000
const SOURCES = Object.freeze({
  github: { label: 'GitHub', gitHosts: ['github.com', 'ssh.github.com'], hosts: ['raw.githubusercontent.com'], base: 'https://raw.githubusercontent.com/cchanlan/xhh-TL-modules/master/' },
  gitee: { label: 'Gitee', gitHosts: ['gitee.com', 'ssh.gitee.com'], hosts: ['gitee.com', 'raw.giteeusercontent.com'], base: 'https://gitee.com/longhengmu/xhh-TL-modules/raw/master/' },
  gitcode: { label: 'GitCode', gitHosts: ['gitcode.com', 'gitcode.net'], hosts: ['api.gitcode.com', 'raw.gitcode.com'] },
})

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
function downloadContext(source) {
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
  return { source, agent, deadline: Date.now() + DOWNLOAD_TIME }
}
function allowedDownloadURL(value, source) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !SOURCES[source].hosts.includes(url.hostname)) throw new Error('模块下载跳转地址不允许')
  return url
}
/** 同平台 HTTPS 跳转上限 5 次；全程不携带 Git 或业务凭据。 */
function requestBuffer(initial, limit, context) {
  return new Promise((resolve, reject) => {
    let settled = false, current, timer
    const done = (error, bytes) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) current?.destroy()
      error ? reject(error) : resolve(bytes)
    }
    const visit = (value, redirects = 0) => {
      let url
      try { url = allowedDownloadURL(value, context.source) } catch (error) { done(error); return }
      let redirected = false, hasResponse = false, request
      try {
        request = https.get(url, { agent: context.agent, headers: { 'User-Agent': 'xhh-TL-module-manager/2' } }, response => {
          hasResponse = true
          let ended = false
          response.on('close', () => { if (!redirected && !ended && !response.complete) done(new Error('下载连接提前关闭')) })
          response.on('aborted', () => { if (!redirected) done(new Error('下载连接中断')) })
          response.on('error', error => { if (!redirected) done(error) })
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            let next
            try {
              if (redirects >= 5 || !response.headers.location) throw new Error('模块下载跳转过多或缺少地址')
              next = allowedDownloadURL(new URL(response.headers.location, url), context.source)
            } catch (error) { response.resume(); done(error); return }
            redirected = true; response.resume(); request.destroy(); visit(next, redirects + 1); return
          }
          if (response.statusCode !== 200) { response.resume(); done(new Error('模块源返回 HTTP ' + response.statusCode)); return }
          const declared = Number(response.headers['content-length'])
          if (Number.isFinite(declared) && declared > limit) { done(new Error('下载超过大小限制')); return }
          let received = 0
          const chunks = []
          response.on('data', chunk => {
            received += chunk.length
            if (received > limit) { done(new Error('下载超过大小限制')); return }
            chunks.push(chunk)
          })
          response.on('end', () => { ended = true; done(null, Buffer.concat(chunks)) })
        })
        current = request
        request.setTimeout(30_000, () => { if (!redirected) done(new Error('下载连接长时间无数据')) })
        request.on('error', error => { if (!redirected) done(error) })
        request.on('close', () => { if (!settled && !redirected && !hasResponse && current === request) done(new Error('下载连接提前关闭')) })
      } catch (error) { done(error) }
    }
    const remaining = context.deadline - Date.now()
    if (remaining <= 0) { done(new Error('下载超时，请配置下载代理后重试')); return }
    timer = setTimeout(() => done(new Error('下载超时，请配置下载代理后重试')), remaining)
    visit(initial)
  })
}
async function downloadFromSource(relative, limit, context) {
  if (!validDownloadPath(relative) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PACK) throw new Error('下载目标或大小限制无效')
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

/** 下载目录/文件跟随核心仓库平台，不自动跨平台回退。 */
export async function download(relative, limit = MAX_PACK, source = getModuleSource()) {
  const context = downloadContext(source)
  globalThis.logger?.debug?.(`[xhh-TL][模块下载] 来源 ${SOURCES[source].label}，文件 ${relative}`)
  try { return await downloadFromSource(relative, limit, context) }
  finally { context.agent?.destroy() }
}

/** Gitee 超过小文件上限会要求登录；固定分片匿名下载，拼回原包后校验。 */
export async function downloadPackage(meta, source = getModuleSource()) {
  if (!meta || !validId(meta.id) || typeof meta.version !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(meta.version) || meta.package !== `packages/${meta.id}/${meta.version}.xhmp` || !Number.isSafeInteger(meta.bytes) || meta.bytes < 1 || meta.bytes > MAX_PACK || !/^[a-f0-9]{64}$/.test(meta.sha256)) throw new Error('模块包信息无效')
  const context = downloadContext(source)
  globalThis.logger?.debug?.(`[xhh-TL][模块下载] 来源 ${SOURCES[source].label}，模块 ${meta.id}`)
  try {
    let buffer
    if (source === 'gitee' && meta.bytes > PACKAGE_PART_SIZE) {
      const chunks = []
      for (let offset = 0, index = 1; offset < meta.bytes; offset += PACKAGE_PART_SIZE, index++) {
        const size = Math.min(PACKAGE_PART_SIZE, meta.bytes - offset)
        const relative = meta.package + '.parts/' + String(index).padStart(4, '0') + '.part'
        const part = await downloadFromSource(relative, size, context)
        if (part.length !== size) throw new Error('模块包分片大小不匹配：' + meta.id)
        chunks.push(part)
      }
      buffer = Buffer.concat(chunks, meta.bytes)
    } else buffer = await downloadFromSource(meta.package, meta.bytes, context)
    if (buffer.length !== meta.bytes || sha256(buffer) !== meta.sha256) throw new Error('模块包校验失败：' + meta.id)
    return buffer
  } finally { context.agent?.destroy() }
}
function readJsonOrYaml(file){assertNoSymlink(file);return YAML.parse(fs.readFileSync(file,'utf8'))||{}}
