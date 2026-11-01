/**
 * 强制更新：全池拉取成功后替换当前 UID，写入失败时回滚；不触碰其他 UID。
 * 目录切换目前仅在 Linux / JiuLi 真机验证，使用跨平台 fs API。
 */
import fs from 'node:fs'
import path from 'node:path'

function removeTree(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) removeTree(file)
    else fs.unlinkSync(file)
  }
  fs.rmdirSync(dir)
}

export function rebuildGachaData(dir, entries, cacheFile, cache) {
  const suffix = `${process.pid}-${Date.now()}`
  const stage = `${dir}.rebuild-${suffix}`
  const backup = `${dir}.previous-${suffix}`
  const cacheTmp = `${cacheFile}.rebuild-${suffix}`
  let movedOld = false
  let installed = false
  let committed = false
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const { type, records } of entries) {
      if (!/^\d+$/.test(type) || !Array.isArray(records)) throw new Error('重建记录格式异常')
      fs.writeFileSync(path.join(stage, `${type}.json`), JSON.stringify(records, '', '\t'))
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheTmp, JSON.stringify(cache, null, 1))
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, backup)
      movedOld = true
    }
    fs.renameSync(stage, dir)
    installed = true
    // 所有操作同步完成，同进程不会在目录切换中途插入另一轮导入。
    // 掉电不等价于事务；此前目录仍在 backup，可用于恢复。
    fs.renameSync(cacheTmp, cacheFile)
    committed = true
  } catch (err) {
    if (installed) removeTree(dir)
    if (movedOld) fs.renameSync(backup, dir)
    throw err
  } finally {
    if (fs.existsSync(stage)) removeTree(stage)
    if (fs.existsSync(cacheTmp)) fs.unlinkSync(cacheTmp)
    if (committed && fs.existsSync(backup)) {
      try { removeTree(backup) } catch (err) {
        globalThis.logger?.warn?.(`[xhh-TL][抽卡记录] 重建已完成，旧目录清理失败：${err.message}`)
      }
    }
  }
}
