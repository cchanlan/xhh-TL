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
 *
 * ── 关于 SQLITE_BUSY（database is locked）─────────────────────────────
 * 只读打开也会被锁：core 侧写库（gsuid_core 及其插件，尤其是高频写记忆/统计表的 AI 插件）
 * 恰好持锁时，reader 默认 busy_timeout=0 会「0ms 立刻失败」。实测就撞在用户发指令的那一秒
 * ——群消息本身会触发 core 侧写库，两边天然同时发生，所以偶发但专挑关键时刻。
 * 处理分两层，不能只靠调大 busy_timeout：
 *   · node:sqlite / better-sqlite3 都是**同步** API，busy_timeout 期间连事件循环一起阻塞
 *     （实测 timeout=5000 会让整个 Yunzai 卡满 5 秒），所以同步驱动只给一小段 400ms；
 *   · 剩下的靠 withReadonlyDb 的异步重试：每次重试之间 await 一小会儿，
 *     把时间让给事件循环（也让 core 那边有机会提交事务释放锁）。
 * sqlite3 是回调式的，等锁不占事件循环，可以给大一点。
 */

/** 驱动名 → 加载失败原因，全部失败时拼进提示里 */
const loadErrors = new Map()
let driverPromise = null

const log = () => (typeof logger !== 'undefined' ? logger : console)

/** 同步驱动的 busy_timeout：等锁会阻塞事件循环，只给一小段，其余交给异步重试 */
const SYNC_BUSY_TIMEOUT_MS = 400
/** 异步驱动（sqlite3）等锁不占事件循环，可以多等一会儿 */
const ASYNC_BUSY_TIMEOUT_MS = 2000
/** 默认重试次数与间隔（间隔是 await，不阻塞） */
const BUSY_RETRIES = 3
const BUSY_RETRY_GAP_MS = 250

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 是否「库被锁住」类错误（可重试）
 * node:sqlite 报 ERR_SQLITE_ERROR + 'database is locked'，
 * better-sqlite3 / sqlite3 报 SQLITE_BUSY（或 SQLITE_LOCKED）。
 */
export function isBusyError(err) {
  const code = String(err?.code || '')
  if (code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED')) return true
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(String(err?.message || ''))
}

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
      // timeout 是较新 Node 才有的选项，老版本传了会抛参数错 → 退回不带选项再用 PRAGMA 补
      let db = null
      try {
        db = new DatabaseSync(file, { readOnly: true, timeout: SYNC_BUSY_TIMEOUT_MS })
      } catch (err) {
        // 只有「不认识这个选项」才值得重开；库被锁等真实错误照旧抛给上层重试
        const optionErr = /ERR_INVALID_ARG|ERR_OUT_OF_RANGE|unknown|unrecognized/i.test(
          String(err?.message || ''),
        )
        if (!optionErr || isBusyError(err)) throw err
        db = new DatabaseSync(file, { readOnly: true })
      }
      // 老 Node 走到这儿 timeout 还是 0，补一条 PRAGMA（连接级设置，不写库、不会 busy）
      try {
        db.exec(`PRAGMA busy_timeout = ${SYNC_BUSY_TIMEOUT_MS}`)
      } catch (_) {}
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
      // better-sqlite3 的 timeout 默认就是 5000，同步阻塞太久，显式压到一小段
      const db = new Database(file, {
        readonly: true,
        fileMustExist: true,
        timeout: SYNC_BUSY_TIMEOUT_MS,
      })
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
        // 回调式驱动等锁不占事件循环，等久点也没关系
        try {
          db.configure('busyTimeout', ASYNC_BUSY_TIMEOUT_MS)
        } catch (_) {}
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
  return withReadonlyDb(file, (db) => db.all(sql, params))
}

/**
 * 只读打开 → 跑一段查询 → 关闭，遇 SQLITE_BUSY 整段重试
 *
 * 「整段」是刻意的：一次业务查询往往要读好几张表（如鸣潮的 wavesbind + wavesuser），
 * 中途被锁时重开连接从头读，比单条 SQL 各自重试更简单，也不会读到半新半旧的两张表。
 * 重试间隔用 await，不阻塞事件循环，同时给 core 那边时间提交事务放锁。
 *
 * @param {string} file 数据库路径
 * @param {(db:{driver:string,all:Function}) => Promise<any>} fn 拿到连接后要做的事
 * @param {{retries?:number, gap?:number}} opts
 * @returns {Promise<any>} fn 的返回值；驱动全不可用时返回 null
 */
export async function withReadonlyDb(file, fn, { retries = BUSY_RETRIES, gap = BUSY_RETRY_GAP_MS } = {}) {
  const driver = await getSqliteDriver()
  if (!driver) return null
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    let db = null
    try {
      db = driver.open(file)
      return await fn({ driver: driver.name, all: db.all })
    } catch (err) {
      lastErr = err
      if (!isBusyError(err) || attempt === retries) throw err
      log().debug?.(
        `[xhh-TL][SQLite] ${file} 被锁（${driver.name}，第 ${attempt + 1}/${retries} 次重试）`,
      )
    } finally {
      try {
        await db?.close()
      } catch (_) {}
    }
    await sleep(gap * (attempt + 1))
  }
  throw lastErr
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
