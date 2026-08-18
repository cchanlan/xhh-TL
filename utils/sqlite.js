/**
 * 只读 SQLite 访问层（借读 gsuid_core 的 GsData.db 用）
 *
 * 原先只用 node:sqlite，但它是 Node 22.5+ 才有的内置模块（22.5~22.12 还要 --experimental-sqlite）。
 * Windows 的 Yunzai 一键包常带 Node 18/20，import 直接抛错，鸣潮体力就永远「没有可用的账号」。
 * 所以按顺序探测三种驱动，取第一个能用的：
 *   1. node:sqlite     Node 22.5+ 内置，同步，零依赖
 *   2. better-sqlite3  同步，宿主装了就能用
 *   3. sqlite3         TRSS Yunzai 自带依赖（userBind 读 data.db 用的就是它），异步
 * 后两个是原生模块，import 成功不代表能用（.node 没编译时要到实例化才炸），
 * 所以探测时各拿一个内存库真查一次，坏驱动直接跳到下一个。
 * 三者都只读打开，不写、不锁库，不影响正在跑的 gsuid_core。
 *
 * 对外只暴露 async 接口（驱动探测本身要 await import），调用方不必关心用了哪个驱动。
 */

/** 驱动名 → 加载失败原因，全部失败时拼进提示里 */
const loadErrors = new Map()
let driverPromise = null

const log = () => (typeof logger !== 'undefined' ? logger : console)

function errText(err) {
  // better-sqlite3 缺 .node 时会把十几条候选路径全列出来，截断免得刷屏
  const msg = err?.message || String(err || '未知错误')
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg
}

/** node:sqlite（同步） */
async function loadNodeSqlite() {
  const { DatabaseSync } = await import('node:sqlite')
  if (!DatabaseSync) throw new Error('未导出 DatabaseSync')
  const probe = new DatabaseSync(':memory:')
  try {
    probe.prepare('SELECT 1').all()
  } finally {
    probe.close()
  }
  return {
    name: 'node:sqlite',
    open(file) {
      const db = new DatabaseSync(file, { readOnly: true })
      return {
        all: async (sql, params = []) => db.prepare(sql).all(...params),
        close: async () => db.close(),
      }
    },
  }
}

/** better-sqlite3（同步） */
async function loadBetterSqlite3() {
  const mod = await import('better-sqlite3')
  const Database = mod?.default || mod
  if (typeof Database !== 'function') throw new Error('未导出构造函数')
  const probe = new Database(':memory:')
  try {
    probe.prepare('SELECT 1').all()
  } finally {
    probe.close()
  }
  return {
    name: 'better-sqlite3',
    open(file) {
      const db = new Database(file, { readonly: true, fileMustExist: true })
      return {
        all: async (sql, params = []) => db.prepare(sql).all(...params),
        close: async () => db.close(),
      }
    },
  }
}

/** sqlite3（回调式，包成 Promise） */
async function loadSqlite3() {
  const mod = await import('sqlite3')
  const sqlite3 = mod?.default || mod
  if (typeof sqlite3?.Database !== 'function') throw new Error('未导出 Database')
  await new Promise((resolve, reject) => {
    let probe = null
    probe = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err)
      probe.all('SELECT 1', [], (queryErr) => {
        probe.close(() => (queryErr ? reject(queryErr) : resolve()))
      })
    })
  })
  return {
    name: 'sqlite3',
    open(file) {
      let db = null
      const ready = new Promise((resolve, reject) => {
        db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) =>
          err ? reject(err) : resolve(),
        )
      })
      return {
        all: async (sql, params = []) => {
          await ready
          return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
          })
        },
        close: async () => {
          // 打开就失败时 ready 已 reject，这里吞掉避免盖住真正的错误
          await ready.catch(() => {})
          return new Promise((resolve) => db.close(() => resolve()))
        },
      }
    },
  }
}

const LOADERS = [
  ['node:sqlite', loadNodeSqlite],
  ['better-sqlite3', loadBetterSqlite3],
  ['sqlite3', loadSqlite3],
]

/** 取可用驱动（探测一次并缓存）；全不可用返回 null */
export async function getSqliteDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      for (const [name, load] of LOADERS) {
        try {
          const driver = await load()
          // 打一条，Windows 上排查「鸣潮为什么没账号」时一眼能看出走的哪个驱动
          const skipped = [...loadErrors.keys()].join('、')
          log().mark?.(
            `[xhh-TL][SQLite] 使用 ${name} 只读驱动${skipped ? `（已跳过 ${skipped}）` : ''}`,
          )
          return driver
        } catch (err) {
          loadErrors.set(name, errText(err))
        }
      }
      return null
    })()
  }
  return driverPromise
}

/**
 * 只读打开数据库
 * @returns {Promise<{driver:string, all:(sql:string,params?:any[])=>Promise<object[]>, close:()=>Promise<void>}|null>}
 */
export async function openReadonlyDb(file) {
  const driver = await getSqliteDriver()
  if (!driver) return null
  const handle = driver.open(file)
  return { driver: driver.name, ...handle }
}

/** 打开→查→关的一次性封装（只查一条 SQL 时用） */
export async function queryAll(file, sql, params = []) {
  const db = await openReadonlyDb(file)
  if (!db) return null
  try {
    return await db.all(sql, params)
  } finally {
    await db.close().catch(() => {})
  }
}

/** 三种驱动都不可用时的排查提示 */
export function sqliteUnavailableMessage() {
  const detail =
    [...loadErrors].map(([name, msg]) => `${name}: ${msg}`).join('；') || '未探测'
  return (
    `SQLite 驱动全部不可用（Node ${process.version}，${process.platform}，${process.execPath}）：${detail}；` +
    '请升级到 Node 22.13+（自带 node:sqlite），或在 Yunzai 目录执行 pnpm add better-sqlite3'
  )
}
