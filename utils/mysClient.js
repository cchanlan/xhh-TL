/**
 * 无 genshin 时的轻量米游社请求客户端
 * 覆盖 xhh-TL 深渊 / 剧诗 / 角色相关 API，接口形状对齐 genshin MysApi.getData
 */

import md5 from 'md5'
import fetch from 'node-fetch'
import crypto from 'crypto'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

const SALT_CN = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
const SALT_OS = 'okr4obncj8bw5a65hbnn5oo6ixjc3l9w'

function gameKey(game, e) {
  if (game === 'sr' || game === true) return 'sr'
  if (e?.isSr || e?.game === 'sr') return 'sr'
  if (game === 'zzz' || e?.game === 'zzz') return 'zzz'
  return game || e?.game || 'gs'
}

function getServer(uid, game = 'gs') {
  const _uid = String(uid)
  if (game === 'zzz') {
    if (_uid.length < 10) return 'prod_gf_cn'
    switch (_uid.slice(0, -8)) {
      case '10': return 'prod_gf_us'
      case '15': return 'prod_gf_eu'
      case '13': return 'prod_gf_jp'
      case '17': return 'prod_gf_sg'
      default: return 'prod_gf_cn'
    }
  }
  if (game === 'sr') {
    switch (_uid.slice(0, -8) || _uid[0]) {
      case '5': return 'prod_qd_cn'
      case '6': return 'prod_official_usa'
      case '7': return 'prod_official_euro'
      case '8':
      case '18': return 'prod_official_asia'
      case '9': return 'prod_official_cht'
      default: return 'prod_gf_cn'
    }
  }
  // gs
  switch (_uid[0]) {
    case '5': return 'cn_qd01'
    case '6': return 'os_usa'
    case '7': return 'os_euro'
    case '8':
    case '18': return 'os_asia'
    case '9': return 'os_cht'
    default: return 'cn_gf01'
  }
}

function isCn(server) {
  return /cn_|_cn|prod_gf_cn|prod_qd_cn/.test(server)
}

function getDs(q = '', b = '', server = 'cn_gf01') {
  const n = isCn(server) ? SALT_CN : SALT_OS
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const DS = md5(`salt=${n}&t=${t}&r=${r}&b=${b}&q=${q}`)
  return `${t},${r},${DS}`
}

function deviceId(uid) {
  return `Yz-${md5(String(uid)).substring(0, 5)}`
}

function getUrlMap(uid, server, game, data = {}) {
  const host = isCn(server) ? 'https://api-takumi.mihoyo.com/' : 'https://sg-public-api.hoyolab.com/'
  const hostRecord = isCn(server)
    ? 'https://api-takumi-record.mihoyo.com/'
    : 'https://bbs-api-os.hoyolab.com/'
  const hostPublicData = isCn(server)
    ? 'https://public-data-api.mihoyo.com/'
    : 'https://sg-public-data-api.hoyoverse.com/'
  const device = data.deviceId || deviceId(uid)

  const getFpCn = {
    url: `${hostPublicData}device-fp/api/getFp`,
    body: {
      seed_id: data.seed_id || crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      device_id: String(device).toUpperCase(),
      platform: '1',
      seed_time: String(Date.now()),
      ext_fields: `{"proxyStatus":"0","accelerometer":"-0.159515x-0.830887x-0.682495","ramCapacity":"3746","IDFV":"${String(device).toUpperCase()}","gyroscope":"-0.191951x-0.112927x0.632637","isJailBreak":"0","model":"iPhone12,5","ramRemain":"115","chargeStatus":"1","networkType":"WIFI","vendor":"--","osVersion":"17.0.2","batteryStatus":"50","screenSize":"414×896","cpuCores":"6","appMemory":"55","romCapacity":"488153","romRemain":"157348","cpuType":"CPU_TYPE_ARM64","magnetometer":"-84.426331x-89.708435x-37.117889"}`,
      app_name: 'bbs_cn',
      device_fp: '38d7ee834d1e9',
    },
  }

  if (game === 'sr') {
    return {
      getFp: getFpCn,
      index: {
        url: `${hostRecord}game_record/app/hkrpg/api/index`,
        query: `role_id=${uid}&server=${server}`,
      },
      spiralAbyss: {
        url: `${hostRecord}game_record/app/hkrpg/api/challenge`,
        query: `isPrev=&need_all=true&role_id=${uid}&schedule_type=${data.schedule_type || 1}&server=${server}`,
      },
      challengeStory: {
        url: `${hostRecord}game_record/app/hkrpg/api/challenge_story`,
        query: `isPrev=&need_all=true&role_id=${uid}&schedule_type=${data.schedule_type || 1}&server=${server}`,
      },
      challengeBoss: {
        url: `${hostRecord}game_record/app/hkrpg/api/challenge_boss`,
        query: `isPrev=&need_all=true&role_id=${uid}&schedule_type=${data.schedule_type || 1}&server=${server}`,
      },
      challengePeak: {
        url: `${hostRecord}game_record/app/hkrpg/api/challenge_peak`,
        query: `isPrev=&need_all=true&role_id=${uid}&schedule_type=${data.schedule_type || 1}&server=${server}`,
      },
      character: {
        url: `${hostRecord}game_record/app/hkrpg/api/avatar/basic`,
        query: `role_id=${uid}&server=${server}`,
      },
      avatarInfo: {
        url: `${hostRecord}game_record/app/hkrpg/api/avatar/info`,
        query: `need_wiki=true&role_id=${uid}&server=${server}`,
      },
      detail: {
        url: `${host}event/rpgcalc/avatar/detail`,
        query: `game=hkrpg&lang=zh-cn&item_id=${data.avatar_id}&tab_from=${data.tab_from || 'TabOwned'}&change_target_level=0&uid=${uid}&region=${server}`,
      },
      dailyNote: {
        url: `${hostRecord}game_record/app/hkrpg/api/note`,
        query: `role_id=${uid}&server=${server}`,
      },
    }
  }

  // gs default
  return {
    getFp: getFpCn,
    index: {
      url: `${hostRecord}game_record/app/genshin/api/index`,
      query: `role_id=${uid}&server=${server}`,
    },
    spiralAbyss: {
      url: `${hostRecord}game_record/app/genshin/api/spiralAbyss`,
      query: `role_id=${uid}&schedule_type=${data.schedule_type || 1}&server=${server}`,
    },
    role_combat: {
      url: `${hostRecord}game_record/app/genshin/api/role_combat`,
      query: `role_id=${uid}&need_detail=${data.need_detail === false ? 'false' : 'true'}&server=${server}`,
    },
    hard_challenge: {
      url: `${hostRecord}game_record/app/genshin/api/hard_challenge`,
      query: `role_id=${uid}&need_detail=true&server=${server}`,
    },
    hard_challenge_popularity: {
      url: `${hostRecord}game_record/app/genshin/api/hard_challenge/popularity`,
      query: `role_id=${uid}&server=${server}`,
    },
    character: {
      url: `${hostRecord}game_record/app/genshin/api/character/list`,
      body: { role_id: Number(uid) || uid, server },
    },
    characterDetail: {
      url: `${hostRecord}game_record/app/genshin/api/character/detail`,
      body: {
        role_id: Number(uid) || uid,
        server,
        character_ids: data.character_ids,
      },
    },
    detail: {
      url: `${host}event/e20200928calculate/v1/sync/avatar/detail`,
      query: `uid=${uid}&region=${server}&avatar_id=${data.avatar_id}`,
    },
    avatarSkill: {
      url: `${host}event/e20200928calculate/v1/avatarSkill/list`,
      query: `avatar_id=${data.avatar_id}`,
    },
    dailyNote: {
      url: `${hostRecord}game_record/app/genshin/api/dailyNote`,
      query: `role_id=${uid}&server=${server}`,
    },
  }
}

function getHeaders(server, query = '', body = '', device = '') {
  const cn = isCn(server)
  return {
    'x-rpc-app_version': cn ? '2.40.1' : '2.55.0',
    'x-rpc-client_type': cn ? '5' : '2',
    'User-Agent': cn
      ? `Mozilla/5.0 (Linux; Android 12; ${device || 'Mi 10'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/2.40.1`
      : 'Mozilla/5.0 (Linux; Android 11; J9110) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.179 Mobile Safari/537.36 miHoYoBBSOversea/2.55.0',
    Referer: cn ? 'https://webstatic.mihoyo.com/' : 'https://act.hoyolab.com/',
    DS: getDs(query, body, server),
  }
}

/**
 * 轻量 MysApi（对齐 genshin model/mys/mysApi.js 的 getData）
 */
export default class LiteMysApi {
  constructor(uid, cookie, option = {}) {
    this.uid = String(uid)
    this.cookie = cookie
    this.game = gameKey(option.game)
    this.server = option.server || getServer(this.uid, this.game)
    this.device = option.device || deviceId(this.uid)
    this.option = { log: option.log !== false, ...option }
    this._device_fp = null
    this.cacheCd = 300
  }

  getUrl(type, data = {}) {
    const map = getUrlMap(this.uid, this.server, this.game, { ...data, deviceId: this.device })
    const item = map[type]
    if (!item) return false
    let { url, query = '', body = '' } = item
    if (query) url += `?${query}`
    if (body && typeof body === 'object') body = JSON.stringify(body)
    const headers = getHeaders(this.server, query, body || '', this.device)
    return { url, headers, body, query }
  }

  async getData(type, data = {}, cached = false) {
    if (!this._device_fp && !data?.Getfp && !data?.headers?.['x-rpc-device_fp']) {
      this._device_fp = await this.getData('getFp', {
        seed_id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        Getfp: true,
      })
    }
    if (type === 'getFp' && !data?.Getfp) return this._device_fp

    const conf = this.getUrl(type, data)
    if (!conf) {
      log.error(`[xhh-TL][mysClient] 未定义 API: ${type} game=${this.game}`)
      return false
    }

    let { url, headers, body } = conf
    headers = { ...headers, Cookie: this.cookie }
    if (data.headers) headers = { ...headers, ...data.headers }
    if (type !== 'getFp' && !headers['x-rpc-device_fp'] && this._device_fp?.data?.device_fp) {
      headers['x-rpc-device_fp'] = this._device_fp.data.device_fp
    }

    const cacheKey = `xhh-TL:mys:cache:${md5(this.uid + type + JSON.stringify(data))}`
    try {
      if (cached && typeof redis !== 'undefined') {
        const hit = await redis.get(cacheKey)
        if (hit) return JSON.parse(hit)
      }
    } catch (_) {}

    const param = { headers, timeout: 12000, method: body ? 'post' : 'get' }
    if (body) param.body = body

    const start = Date.now()
    let res
    try {
      const response = await fetch(url, param)
      if (!response.ok) {
        log.error(`[xhh-TL][mys][${type}][${this.uid}] ${response.status}`)
        return false
      }
      res = await response.json()
    } catch (err) {
      log.error(`[xhh-TL][mys][${type}] ${err.message}`)
      return false
    }

    if (this.option.log !== false) {
      log.mark(`[xhh-TL][mys][${type}][${this.uid}] ${Date.now() - start}ms`)
    }
    if (!res) return false
    res.api = type

    if (cached && res.retcode === 0) {
      try {
        if (typeof redis !== 'undefined') await redis.setEx(cacheKey, this.cacheCd, JSON.stringify(res))
      } catch (_) {}
    }
    return res
  }
}

export { getServer, gameKey, getDs, deviceId }
