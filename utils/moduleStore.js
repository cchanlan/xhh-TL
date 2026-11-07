/** 模块包只包含文件数据，不执行安装脚本。运行目录由核心文件位置确定。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import https from 'node:https'
import YAML from 'yaml'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const storeDir = path.join(root, 'data', 'module-manager')
export const stateFile = path.join(storeDir, 'state.json')
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
export const CORE_API = 2
export const CORE_VERSION = '2.1.0'
const RESERVED = new Set(['__proto__','constructor','prototype','tostring','valueof','hasownproperty','__definegetter__','__definesetter__'])
const validId = id => typeof id==='string' && /^[a-z][a-z0-9_]{0,63}$/.test(id) && !RESERVED.has(id.toLowerCase())
function atLeast(actual,required){
  if(typeof required!=='string'||!/^\d+\.\d+\.\d+$/.test(required))return false
  const a=actual.split('.').map(Number),b=required.split('.').map(Number)
  for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false}return true
}
export const MAX_PACK = 64 * 1024 * 1024
export const MAX_CONTENT = 96 * 1024 * 1024
const BASE = 'https://raw.githubusercontent.com/cchanlan/xhh-TL-modules/master/'
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

/** 固定官方 HTTPS 源；可用用户配置/环境代理，不向代理提供业务凭据。 */
export function download(relative, limit = MAX_PACK) {
  if (relative !== 'catalog.json' && !/^packages\/[a-z][a-z0-9_]*\/[a-zA-Z0-9._-]+\.xhmp$/.test(relative)) throw new Error('下载目标无效')
  let proxy=process.env.HTTPS_PROXY||process.env.https_proxy||''
  const userFile=path.join(root,'config','config.yaml')
  if(fs.existsSync(userFile)) {
    const config=readJsonOrYaml(userFile)
    if(config.download_proxy)proxy=String(config.download_proxy).trim()
  }
  let agent
  if(proxy){
    let url;try{url=new URL(proxy)}catch{throw new Error('下载代理地址无效')}
    if(!['http:','https:'].includes(url.protocol))throw new Error('下载代理仅支持 HTTP 或 HTTPS')
    agent=new HttpsProxyAgent(url)
  }
  return new Promise((resolve,reject)=>{
    let received=0,settled=false,timer
    const chunks=[]
    const done=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);agent?.destroy();error?reject(error):resolve(data)}
    const request=https.get(BASE+relative,{agent,headers:{'User-Agent':'xhh-TL-module-manager/2'}},response=>{
      if(response.statusCode!==200){response.resume();done(new Error('模块源返回 HTTP '+response.statusCode));return}
      const declared=Number(response.headers['content-length'])
      if(Number.isFinite(declared)&&declared>limit){request.destroy(new Error('下载超过大小限制'));return}
      response.on('data',chunk=>{received+=chunk.length;if(received>limit){request.destroy(new Error('下载超过大小限制'));return}chunks.push(chunk)})
      response.on('end',()=>done(null,Buffer.concat(chunks)))
      response.on('aborted',()=>done(new Error('下载连接中断')))
      response.on('error',error=>done(error))
    })
    timer=setTimeout(()=>request.destroy(new Error('下载超时，请配置下载代理后重试')),600_000)
    request.setTimeout(30_000,()=>request.destroy(new Error('下载连接长时间无数据')))
    request.on('error',error=>done(error))
    request.on('close',()=>{if(!settled)done(new Error('下载连接提前关闭'))})
  })
}
function readJsonOrYaml(file){assertNoSymlink(file);return YAML.parse(fs.readFileSync(file,'utf8'))||{}}
