import { exec } from 'child_process';
import fetch from 'node-fetch';
import moment from 'moment';
import md5 from 'md5';
import lodash from 'lodash';
import plugin from '../../../lib/plugins/plugin.js';
import { createUser } from '../utils/userBind.js';
import { getstoken, cookiePart } from '../utils/auth.js';
import common from '../../../lib/common/common.js';
import { getRenderScaleStyle, config, pluginDir, pickCharacterPortrait, pickPortraitBg, toDataUrl, toDataUrlTrim } from '../utils/pluginConfig.js';
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js';
import { replyQuote, replyForward, quoteEnabled } from '../utils/replyHelper.js';
import { prepareMysContext, resolveAuth } from '../utils/runtimePatch.js';
import LiteMysApi from '../utils/mysClient.js';
import { getWavesStaminaList, isWavesTlEnabled, listWavesAccounts } from '../utils/wavesData.js';

// ============ 用户 UID 显示设置 ============
async function getShowUid(qq) {
  const val = await redis.get(`xhh:show_uid:${qq}`);
  // 默认 true（显示）
  return val === null ? true : val !== 'false';
}

// 每个用户可单独开关「体力总览」里是否显示某游戏，默认 true（显示）
// 关闭后总览不查/不显示该游戏；单独 #原神体力/#星铁体力/#绝区零体力 不受影响
async function getShowGame(qq, game) {
  const val = await redis.get(`xhh:show_${game}:${qq}`);
  return val === null ? true : val !== 'false';
}

async function getShowGs(qq) {
  return getShowGame(qq, 'gs');
}

async function getShowSr(qq) {
  return getShowGame(qq, 'sr');
}

async function getShowZzz(qq) {
  return getShowGame(qq, 'zzz');
}

// 鸣潮体力（只借 gsuid_core 的鸣潮插件凭证，出图用本插件模板）默认关闭，需 #开启鸣潮体力
// 返回 null=从没设置过 / true=开 / false=显式关，用于区分「默认关」和「本人关掉了」
async function getWavesPref(qq) {
  const val = await redis.get(`xhh:show_waves:${qq}`);
  if (val === null || val === undefined || val === '') return null;
  return val === 'true';
}

// ============ 单 UID 体力屏蔽（#关闭原神123456789） ============
// 与「#关闭原神体力」（整个游戏不进总览）不同：这里按 UID 屏蔽，用于小号/托管号
// 不想出现在体力卡里的情况。只影响体力显示（总览 / 单游戏 / 多号列表），
// 不解绑、不影响体力推送订阅。
const GAME_ALIAS = {
  原神: 'gs', ys: 'gs',
  星铁: 'sr', xt: 'sr',
  绝区零: 'zzz', zzz: 'zzz',
  鸣潮: 'ww', mc: 'ww',
};
const GAME_LABEL = { gs: '原神', sr: '星铁', zzz: '绝区零', ww: '鸣潮' };
const HIDE_GAMES = ['gs', 'sr', 'zzz', 'ww'];

const hideUidKey = (qq, game) => `xhh:hide_uid:${game}:${qq}`;

/** 某人某游戏被屏蔽的 UID 集合（字符串） */
async function getHiddenUids(qq, game) {
  try {
    const raw = await redis.get(hideUidKey(qq, game));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set((Array.isArray(arr) ? arr : []).map(String));
  } catch (_) {
    return new Set();
  }
}

async function setHiddenUids(qq, game, uidSet) {
  const arr = [...uidSet];
  if (!arr.length) await redis.del(hideUidKey(qq, game));
  else await redis.set(hideUidKey(qq, game), JSON.stringify(arr));
}

/** 某人四游戏的屏蔽情况：{ gs: ['uid'], ... }（空游戏不留键） */
async function getAllHiddenUids(qq) {
  const out = {};
  for (const game of HIDE_GAMES) {
    const set = await getHiddenUids(qq, game);
    if (set.size) out[game] = [...set];
  }
  return out;
}

// ============ MHY 工具函数 (内联自 xhh/system/mhy.js) ============
const mysSalt = 'rtvTthKxEyreVXQCnhluFgLXPOFKPHlA'; // k2 2.71.1
const mysSalt2 = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'; // 6x
const mysSalt3 = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'; // 4x

function randomString(length, os = false) {
  let randomStr = '';
  for (let i = 0; i < length; i++) {
    randomStr += lodash.sample(
      os ? '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
        : 'abcdefghijklmnopqrstuvwxyz0123456789'
    );
  }
  return randomStr;
}

function getDeviceGuid() {
  function S4() {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
  }
  return (S4() + S4() + '-' + S4() + '-' + S4() + '-' + S4() + '-' + S4() + S4() + S4());
}

function getDs(salt = mysSalt) {
  const randomStr_ = randomString(6);
  const timestamp = Math.floor(Date.now() / 1000);
  let Ds = md5(`salt=${salt}&t=${timestamp}&r=${randomStr_}`);
  return `${timestamp},${randomStr_},${Ds}`;
}

function getDs2(query = '', body = '', salt = mysSalt2) {
  if (salt === '4') salt = mysSalt3;
  let t = Math.round(new Date().getTime() / 1000);
  let r = Math.floor(Math.random() * 900000 + 100000);
  let DS = md5(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`);
  return `${t},${r},${DS}`;
}

function getServer(uid, game) {
  if (game === 'zzz') return 'prod_gf_cn';
  const isSr = game === 'sr';
  switch (String(uid)[0]) {
    case '1': case '2': case '3':
      return isSr ? 'prod_gf_cn' : 'cn_gf01';
    case '5':
      return isSr ? 'prod_qd_cn' : 'cn_qd01';
  }
  return 'prod_gf_cn';
}

function getHeaders(e, ck, Ds_ = true, info) {
  return {
    Origin: 'https://app.mihoyo.com',
    'User-Agent': `Mozilla/5.0 (Linux; Android 13; ${info?.deviceModel || 'Mi 10'} Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.186 Mobile Safari/537.36 miHoYoBBS/2.71.1`,
    'Content-Type': 'application/json, text/plain, */*',
    Referer: 'https://app.mihoyo.com',
    'X-Requested-With': 'com.mihoyo.hyperion',
    'x-rpc-app_version': '2.71.1',
    'x-rpc-sys_version': '13',
    'x-rpc-client_type': '2',
    'x-rpc-device_id': getDeviceGuid(),
    'x-rpc-device_name': info ? info.deviceFingerprint.split('/')[0] + ' ' + info.deviceModel : randomString(lodash.random(1, 10)),
    'x-rpc-device_model': info?.deviceModel || 'Mi 10',
    'x-rpc-channel': 'miyousheluodi',
    'x-rpc-verify_key': 'bll8iq97cem8',
    'x-rpc-app_id': 'bll8iq97cem8',
    'x-rpc-device_fp': '38d7f0aac0ab7',
    DS: Ds_ ? getDs() : getDs2(),
    Cookie: ck ?? '',
  };
}

// ============ API 函数 (简化自 xhh/system/api.js) ============
async function callApi(e, type, game, uid, server, headers, silent = false) {
  const signActId = {
    gs: 'e202311201442471',
    sr: 'e202304121516551',
    zzz: 'e202406242138391',
  };

  const apiList = {
    GameRoles: {
      url: 'https://api-takumi.miyoushe.com/binding/api/getUserGameRolesByStoken',
      method: 'GET',
    },
    sign_info: {
      url: `https://api-takumi.mihoyo.com/event/luna/info?act_id=${signActId[game]}&region=${server}&uid=${uid}&lang=zh-cn`,
      method: 'GET',
    },
  };

  const apiItem = apiList[type];
  if (!apiItem) return { retcode: -1, message: 'Unknown API type' };

  const fetchHeaders = { ...(headers || {}) };

  // 签到接口使用专用 DS/Header
  if (['sign_info'].includes(type) && game) {
    const n = 'jEpJb9rRARU2rXDA9qYbZ3selxkuct9a';
    const t = Math.round(new Date().getTime() / 1000);
    const r = lodash.sampleSize('abcdefghijklmnopqrstuvwxyz0123456789', 6).join('');
    fetchHeaders.DS = `${t},${r},${md5(`salt=${n}&t=${t}&r=${r}`)}`;
    fetchHeaders['x-rpc-client_type'] = '5';
    fetchHeaders['x-rpc-app_version'] = '2.73.1';
    fetchHeaders.Origin = 'https://act.mihoyo.com';
    fetchHeaders.Referer = 'https://webstatic.mihoyo.com/';
    fetchHeaders['User-Agent'] = 'Mozilla/5.0 (Linux; Android 12; Mi 10 Build/SKQ1.211006.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1';
  }

  let res;
  try {
    res = await fetch(apiItem.url, { method: apiItem.method, headers: fetchHeaders }).then(r => r.json());
  } catch (error) {
    logger.error(`[xhh-TL] API error: ${error.message}`);
    return { retcode: -1 };
  }

  if (res.retcode !== 0 && !silent) {
    let msg;
    switch (res.retcode) {
      case -1: case -100: case 1001: case 10001: case 10103:
        msg = `${uid ? 'UID:' + uid : ''}米游社查询失败，无法查询`;
        if (/(登录|login)/i.test(res.message)) {
          msg = `${uid ? 'UID:' + uid : ''}Cookie 失效，请【#刷新ck】，仍不行则【#扫码登录】`;
        }
        break;
      case -110:
        msg = `${uid ? 'UID:' + uid : ''}该账号没有绑定对应游戏角色，请检查UID是否正确`;
        break;
      case 10102: case 5003: case 10041:
        msg = `${uid ? 'UID:' + uid : ''}米游社账号异常,无法查询！`;
        break;
      case 1034: case 10035:
        msg = '米游社查询遇到验证码，暂时无法查询！';
        break;
      default:
        msg = '米游社接口异常...';
        logger.error(res);
        break;
    }
    if (!silent) e.reply && e.reply(msg);
    return res;
  }
  return res;
}

// ============ 工具函数 ============
function getTime(time) {
  const now = new Date().getTime();
  const date = new Date(time * 1000 + now);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = date;
  targetDate.setHours(0, 0, 0, 0);
  let days = Math.floor((targetDate - today) / (1000 * 60 * 60 * 24));
  let day = days === 0 ? '今天' : days === 1 ? '明天' : '后天';
  return `${day}${hours}:${minutes}`;
}

// ============ 主插件类 ============
export class TL extends plugin {
  constructor(e) {
    super({
      name: '[小火花]体力小组件',
      dsc: '体力',
      event: 'message',
      priority: config().tl_priority ?? -99,
      rule: [
        {
          // 可选 #/*/%；关键词必须完整结束，尾部多余字不触发
          // 「四游戏体力」保留作兼容别名（历史指令，现为三游戏）
          // 鸣潮体力走 gsuid_core，别名 鸣潮/mc（不收 w，避免和 core 自己的 w体力 撞车）
          reg: '^\\s*(?:#|\\*|%)*(?:全体力|三游戏体力|四游戏体力|米游社体力|体力总览|体力|tl|(?:原神|ys)(?:体力|tl)|(?:星铁|xt|\\*)(?:体力|tl)|(?:绝区零|zzz)(?:体力|tl)|(?:鸣潮|mc)(?:体力|tl))\\s*$',
          fnc: 'note_',
        },
        {
          // #体力插件更新 / #小火花(体力)更新 / #更新小火花，均可加「强制」
          reg: '^\\s*#?(?:(?:体力插件|小火花(?:体力)?)(?:强制)?更新|(?:强制)?更新小火花)\\s*$',
          fnc: 'updatePlugin',
        },
        {
          reg: '^\\s*#?(?:开启|打开)体力uid\\s*$',
          fnc: 'toggleUidDisplay',
        },
        {
          reg: '^\\s*#?(?:关闭|关掉)体力uid\\s*$',
          fnc: 'toggleUidDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:原神|ys)体力\\s*$',
          fnc: 'toggleGsDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:星铁|xt)体力\\s*$',
          fnc: 'toggleSrDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:绝区零|zzz)体力\\s*$',
          fnc: 'toggleZzzDisplay',
        },
        {
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:鸣潮|mc)体力\\s*$',
          fnc: 'toggleWavesDisplay',
        },
        {
          // 单 UID 屏蔽：#关闭原神123456789 / #屏蔽星铁体力123456789 / #开启鸣潮123456789
          // 必须带 UID 才走这里，不带 UID 的「#关闭原神体力」仍是上面的整游戏开关
          reg: '^\\s*#?(?:取消屏蔽|解除屏蔽|开启|打开|恢复|显示|关闭|关掉|屏蔽|隐藏)(?:原神|ys|星铁|xt|绝区零|zzz|鸣潮|mc)(?:体力)?\\s*\\d{6,12}\\s*$',
          fnc: 'toggleUidHidden',
        },
        {
          reg: '^\\s*#?(?:体力屏蔽|屏蔽体力|屏蔽)(?:列表|清单)\\s*$',
          fnc: 'hiddenUidList',
        },
      ],
    });
    this.gsUrl =
      'https://api-takumi-record.mihoyo.com/game_record/genshin/aapi/widget/v2';
    this.srUrl =
      'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/aapi/widget';
    this.zzzUrl =
      'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/widget';
    this.week = [
      '星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六',
    ];
  }

  async note_(e) {
    logger.info('[xhh-TL][note_] 开始处理');
    if (!config().Tl) {
      logger.info('[xhh-TL][note_] Tl配置为false，跳过');
      return false;
    }
    logger.info('[xhh-TL][note_] Tl配置为true，继续处理');

    // 检测 @ 提及，支持查询他人体力（排除 @bot 自身）
    let targetQq = null;
    const selfId = e.self_id || (e.bot || Bot)?.uin;
    for (const msg of e.message || []) {
      if (msg.type === 'at' && String(msg.qq) !== String(selfId)) { targetQq = msg.qq; break; }
    }

    let hasAllData = false;
    const rawMsg = (e.msg || '').replace(/^(#|\\*|%)*/, '');
    const isQueryAll = ['体力', '全体力', '三游戏体力', '四游戏体力', '米游社体力', '体力总览', 'tl'].includes(rawMsg);
    logger.info(`[xhh-TL][note_] rawMsg: ${rawMsg}, isQueryAll: ${isQueryAll}`);
    const isStarRail = /星铁|xt|^\*/.test(rawMsg) || e.msg.includes('*体力') || e.msg.includes('*tl');
    const isZZZ = /绝区零|zzz/i.test(rawMsg);
    const isGenshin = /原神|ys/i.test(rawMsg);
    // 单独 #鸣潮体力：只查鸣潮，出图仍走本插件模板（经典/立绘/小组件三种样式）
    // 直接判原始消息，免受上面 rawMsg 只剥 # 的影响（*鸣潮体力 也能进来）
    const isWaves = /^\s*(?:#|\*|%)*(?:鸣潮|mc)(?:体力|tl)\s*$/i.test(e.msg || '');
    if (isWaves) {
      if (!isWavesTlEnabled()) {
        await replyQuote(e, '鸣潮体力未启用，请在锅巴「小火花体力小组件」里打开「启用鸣潮体力」');
        return true;
      }
      const res = await this.getWavesList(e, targetQq || e.user_id);
      if (!res.items.length) {
        await replyQuote(e, res.hiddenAll
          ? '你已屏蔽全部鸣潮 UID 的体力显示，发【#体力屏蔽列表】看看，或【#开启鸣潮<UID>】恢复'
          : res.error === '没有'
            ? '没有可用的鸣潮账号，请先在 gsuid_core 的鸣潮插件里登录（如「w登录」）'
            : `鸣潮体力查询失败：${res.error}`);
        return true;
      }
    }
    const getZZZData = async () => {
      const data = await this.note(e, 'zzz', isQueryAll, targetQq);
      if (
        data &&
        !['过期', '没有'].includes(data) &&
        !data.s2_bounty_commission
      ) {
        data.s2_bounty_commission = { num: 0, total: 0 };
      }
      return data;
    };

    let resultData = {};

    // 各游戏显示开关：仅影响「体力总览」，默认显示；关闭后总览不查/不显示该游戏。
    // 以被查者为准：某人关了某游戏后，无论他自己查还是别人艾特查他，都不显示其该游戏。
    // 单独 #原神体力/#星铁体力/#绝区零体力 不受此开关影响。
    const overviewQq = targetQq || e.user_id;
    const [showGs, showSr, showZzz] = isQueryAll
      ? await Promise.all([getShowGs(overviewQq), getShowSr(overviewQq), getShowZzz(overviewQq)])
      : [true, true, true];

    // 鸣潮体力：需锅巴总开关 + #开启鸣潮体力（默认关）。艾特别人查时，按「被查者自己开过就显示」，
    // 他没设置过才退回看发起人的开关（否则鸣潮默认关，艾特别人基本永远出不来）；
    // 被艾特者显式 #关闭鸣潮体力 过则一律尊重，不给别人查他的鸣潮。
    let wavesOn = false;
    if (isQueryAll && isWavesTlEnabled()) {
      const [selfPref, targetPref] = await Promise.all([
        getWavesPref(e.user_id),
        targetQq ? getWavesPref(overviewQq) : Promise.resolve(null),
      ]);
      wavesOn = targetPref === true || (targetPref !== false && selfPref === true);
    }
    // 与米游社三游戏并行取数（同一 promise 会被后续渲染复用，不会重复请求库街区）
    const wavesTask = wavesOn ? this.getWavesList(e, overviewQq) : null;


    if (isQueryAll) {
      hasAllData = true;
      logger.info('[xhh-TL][note_] 开始查询所有游戏体力');
      const [gsData, srData, zzzData, wavesRes] = await Promise.all([
        showGs ? this.note(e, 'gs', true, targetQq) : Promise.resolve('没有'),
        showSr ? this.note(e, 'sr', true, targetQq) : Promise.resolve('没有'),
        showZzz ? getZZZData() : Promise.resolve('没有'),
        wavesTask || Promise.resolve(null),
      ]);
      resultData = {};
      if (showGs) resultData.gs_data = gsData;
      if (showSr) resultData.sr_data = srData;
      if (showZzz) resultData.zzz_data = zzzData;
      if (wavesOn) resultData.ww_data = wavesRes?.items?.[0] || '没有';
      // 鸣潮取数失败时总览只会「静默少一块」，用户根本不知道为什么（实测就是撞上 core 库被锁）。
      // 环境级失败（读不到库/库正忙/接口报错）先说一句；「没登录」「全屏蔽」属正常状态不提示
      if (
        wavesOn &&
        !wavesRes?.items?.length &&
        wavesRes?.error &&
        wavesRes.error !== '没有' &&
        !wavesRes.hiddenAll
      ) {
        e.reply(`鸣潮体力这次没取到：${wavesRes.error}`, quoteEnabled());
      }
    } else if (isWaves) {
      const res = await this.getWavesList(e, targetQq || e.user_id);
      resultData = { ww_data: res.items[0] };
    } else if (isStarRail) {
      resultData = { sr_data: await this.note(e, 'sr', false, targetQq) };
    } else if (isZZZ) {
      resultData = { zzz_data: await getZZZData() };
    } else {
      resultData = { gs_data: await this.note(e, 'gs', false, targetQq) };
    }

    // 总览时四游戏均被关闭 → 无可展示项，给出明确提示
    if (isQueryAll && !Object.keys(resultData).length) {
      e.reply('你已关闭原神/星铁/绝区零体力显示，请先开启其中之一再查询总览~', quoteEnabled());
      return true;
    }
    if (Object.values(resultData).every(v => v === '没有')) {
      if (hasAllData) {
        e.reply(await this.noAccountTip(overviewQq, '没有绑定米游社，请【#扫码登录】米游社'), quoteEnabled());
      }
      return true;
    }
    if (Object.values(resultData).every(v => v === '过期')) {
      if (hasAllData) e.reply('米游社验证已过期，请【#刷新ck】，仍不行则【#扫码登录】', quoteEnabled());
      return true;
    }

    // 查询他人时获取目标信息
    let displayQq = e.user_id;
    let displayName = e.sender.card && (e.sender.card.length < 11) ? e.sender.card : e.sender.nickname && (e.sender.nickname.length < 11) ? e.sender.nickname : e.user_id;
    if (targetQq) {
      displayQq = targetQq;
      displayName = String(targetQq);
      if (e.isGroup) {
        // 1) 优先用缓存的群成员 (同步，无API调用)
        try {
          const member = e.group?.pickMember?.(targetQq);
          if (member?.card || member?.nickname) {
            displayName = member.card || member.nickname;
          }
        } catch (_) {}
        // 2) 没拿到就走API: getGroupMemberInfo 或 sendApi(NapCat)
        if (displayName === String(targetQq)) {
          const bot = e.bot || Bot;
          try {
            let info = null;
            if (bot.getGroupMemberInfo) {
              info = await bot.getGroupMemberInfo(String(e.group_id), String(targetQq));
            } else if (bot.sendApi) {
              const res = await bot.sendApi('get_group_member_info', { group_id: String(e.group_id), user_id: String(targetQq) });
              info = res?.data || res;
            }
            if (info && (info.card || info.nickname)) {
              displayName = info.card || info.nickname;
            }
          } catch (_) {}
        }
      }
    }

    const renderData = {
      bg: Object.values(resultData).filter(Boolean).length > 1 ? 'bg' : 'bg1',
      qq: displayQq,
      qqname: displayName,
      time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
    };

    for (const key in resultData) {
      if (resultData[key] === '没有' || resultData[key] === '过期') {
        resultData[key] = false;
      }
    }

    const { ..._data_ } = { ...renderData, ...resultData };

    // 立绘卡 / 桌面小组件卡：四游戏均走 renderPortraitFlow（内部按样式分流）
    if (['portrait', 'widget'].includes(config().tl_card_style)) {
      const displayInfo = { qq: displayQq, qqname: displayName };
      const handled = await this.renderPortraitFlow(e, {
        isQueryAll, isStarRail, isZZZ, isGenshin, isWaves,
        showGs, showSr, showZzz, showWaves: wavesOn,
        resultData: _data_, displayInfo, targetQq,
      });
      if (handled) return true;
    }

    // 经典模板出图（多 UID / 单图）
    return this.replyClassicTl(e, {
      displayQq,
      displayName,
      renderData,
      resultData: _data_,
      isQueryAll,
      isStarRail,
      isZZZ,
      isGenshin,
      isWaves,
      showZzz,
      showWaves: wavesOn,
      targetQq,
    });
  }

  /**
   * 本次事件内共享的鸣潮体力数据（库街区接口，凭证借自 gsuid_core 的鸣潮插件）
   * 挂在 e 上做单次缓存：总览预取与后续渲染取列表复用同一个 promise，不重复请求
   * 被屏蔽的 UID 在选号阶段就剔除（同一事件内屏蔽集合不变，故缓存仍按 qq 即可）
   * @returns {Promise<{items: object[], error: string|null, hiddenAll?: boolean}>}
   */
  getWavesList(e, qq) {
    const key = `_xhhWaves_${qq}`;
    if (!e[key]) {
      e[key] = getHiddenUids(qq, 'ww')
        .then((hidden) => getWavesStaminaList(qq, { hideUids: [...hidden] }))
        .catch((err) => ({
          items: [],
          error: err?.message || String(err),
        }));
    }
    return e[key];
  }

  /** 经典 Tl.html 渲染一张图 → Buffer */
  async renderTlImage(e, data, renderScale) {
    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const tplFile = pluginDir + '/resources/Tl/Tl.html';
    const renderResult = await e.runtime.render('小火花', 'Tl/Tl', data, {
      retType: 'base64',
      imgType: 'png',
      beforeRender() {
        return {
          imgType: 'png',
          sys: { scale: renderScale },
          ...data,
          ppath,
          tplFile,
          saveId: 'Tl',
        };
      },
    });
    return await toWebp(extractRenderBuffer(renderResult));
  }

  /** 按游戏列表出多张图（每张图可含 1 个或多个 UID） */
  async renderTlSegmentsByGames(e, allGameData, displayQq, displayName, renderScale, perGameChunkSize = 0) {
    const keyMap = { gs: 'gs_list', sr: 'sr_list', zzz: 'zzz_list', ww: 'ww_list' };
    const segments = [];
    const timeStr = `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`;
    for (const [game, dataList] of Object.entries(allGameData)) {
      const size = perGameChunkSize > 0 ? perGameChunkSize : dataList.length;
      for (let i = 0; i < dataList.length; i += size) {
        const chunk = dataList.slice(i, i + size);
        const chunkData = {
          bg: 'bg1',
          qq: displayQq,
          qqname: displayName,
          time: timeStr,
        };
        chunkData[keyMap[game]] = chunk;
        await this.hideUidIfNeeded(chunkData, displayQq);
        const image = await this.renderTlImage(e, chunkData, renderScale);
        if (image) segments.push(segment.image(image));
      }
    }
    return segments;
  }

  /** 单图引用 / 少量多图引用 / 超过阈值合并转发 */
  async replyTlSegments(e, segments, cardsPerMsg) {
    if (!segments?.length) return replyQuote(e, '图片渲染失败，请稍后重试');
    if (segments.length === 1) return replyQuote(e, segments[0]);
    if (segments.length > cardsPerMsg) {
      const forwardMsg = await common.makeForwardMsg(e, segments);
      return replyForward(e, forwardMsg);
    }
    return replyQuote(e, segments);
  }

  /**
   * 经典体力模板回复：show_all_bindings 多 UID 或单账号一张图
   * 行为与原先 note_ 分支一致，仅抽公共渲染。
   */
  async replyClassicTl(e, opts) {
    const {
      displayQq, displayName, renderData, resultData: _data_,
      isQueryAll, isStarRail, isZZZ, isGenshin, isWaves,
      showGs = true, showSr = true, showZzz = true, showWaves = false, targetQq,
    } = opts;
    const cfg = config();
    const renderScale = getRenderScaleStyle(cfg, 2.0);
    const keyMap = { gs: 'gs_list', sr: 'sr_list', zzz: 'zzz_list', ww: 'ww_list' };
    const cardsPerMsg = cfg.tl_cards_per_msg || 3;
    // 总览时按被查者的各游戏开关过滤（单独查询不受影响）
    const overviewShow = { gs: showGs, sr: showSr, zzz: showZzz, ww: showWaves };

    if (cfg.show_all_bindings) {
      const games = (isQueryAll ? ['gs', 'sr', 'zzz', 'ww']
        : isWaves ? ['ww']
        : isStarRail ? ['sr']
        : isZZZ ? ['zzz']
        : isGenshin ? ['gs']
        : ['gs']).filter(g => !(isQueryAll && !overviewShow[g]));

      const allGameData = {};
      let totalUids = 0;
      let gameCount = 0;
      for (const game of games) {
        const dataList = await this.fetchGameDataList(e, game, true, targetQq || e.user_id);
        if (!dataList.length) continue;
        allGameData[game] = dataList;
        totalUids += dataList.length;
        gameCount++;
      }
      if (!gameCount) {
        e.reply(await this.noAccountTip(targetQq || e.user_id, '没有找到有效绑定的账号'), quoteEnabled());
        return true;
      }

      const tlRenderMode = cfg.tl_render_mode || 'merge';
      const uidsPerImage = cfg.tl_uids_per_image || 2;

      // 独立模式：按 uids_per_image 分组
      if (tlRenderMode === 'single') {
        const segs = await this.renderTlSegmentsByGames(
          e, allGameData, displayQq, displayName, renderScale, uidsPerImage,
        );
        return this.replyTlSegments(e, segs, cardsPerMsg);
      }

      // 合并模式：可选按 merge_uids_per_image 切图
      const mergeUidsPerImage = cfg.tl_merge_uids_per_image || 0;
      if (mergeUidsPerImage > 0) {
        const needSplit = Object.values(allGameData).some(list => list.length > mergeUidsPerImage);
        if (needSplit) {
          const segs = await this.renderTlSegmentsByGames(
            e, allGameData, displayQq, displayName, renderScale, mergeUidsPerImage,
          );
          // 原逻辑：1 张引用，多张一律转发（不走 cardsPerMsg 引用）
          if (segs.length === 1) return replyQuote(e, segs[0]);
          const forwardMsg = await common.makeForwardMsg(e, segs);
          return replyForward(e, forwardMsg);
        }
      }

      // 每游戏恰好 1 个 UID → 合成一张图
      if (totalUids === gameCount) {
        const combinedData = {
          bg: gameCount > 1 ? 'bg' : 'bg1',
          qq: displayQq,
          qqname: displayName,
          time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
        };
        for (const [game, dataList] of Object.entries(allGameData)) {
          combinedData[keyMap[game]] = dataList;
        }
        await this.hideUidIfNeeded(combinedData, displayQq);
        const image = await this.renderTlImage(e, combinedData, renderScale);
        if (image) return replyQuote(e, segment.image(image));
        return replyQuote(e, '图片渲染失败，请稍后重试');
      }

      // 有游戏多 UID → 每游戏一张，多图转发
      const segs = await this.renderTlSegmentsByGames(
        e, allGameData, displayQq, displayName, renderScale, 0,
      );
      if (segs.length > 1) {
        const forwardMsg = await common.makeForwardMsg(e, segs);
        return replyForward(e, forwardMsg);
      }
      return replyQuote(e, segs[0]);
    }

    // 原始单图模式
    const listData = { ...renderData };
    if (_data_.gs_data) listData.gs_list = [_data_.gs_data];
    if (_data_.sr_data) listData.sr_list = [_data_.sr_data];
    if (_data_.zzz_data) listData.zzz_list = [_data_.zzz_data];
    if (_data_.ww_data) listData.ww_list = [_data_.ww_data];
    await this.hideUidIfNeeded(listData, displayQq);
    const image = await this.renderTlImage(e, listData, renderScale);
    if (image) return replyQuote(e, segment.image(image));
    return replyQuote(e, '图片渲染失败，请稍后重试');
  }

  // 获取当前QQ某游戏的所有绑定UID的体力数据
  async fetchGameDataList(e, game, san, qq) {
    // 鸣潮不走米游社：账号与凭证来自 gsuid_core 鸣潮插件的库，一次拿全名下 UID
    if (game === 'ww') {
      const { items } = await this.getWavesList(e, qq);
      return items;
    }

    const results = [];

    // 通过兼容层枚举 UID（不依赖 genshin import）
    const noteUser = await createUser(qq, e);
    const uidList = noteUser.getUidList(game) || [];
    // 被 #关闭<游戏><uid> 屏蔽的号直接跳过，连接口都不请求
    const hidden = await getHiddenUids(qq, game);
    for (const item of uidList) {
      const uid = String(item.uid || item);
      if (!uid || hidden.has(uid)) continue;
      const data = await this.note(e, game, san, qq, uid);
      if (data && data !== '没有' && data !== '过期') {
        if (game === 'zzz' && !data.s2_bounty_commission) {
          data.s2_bounty_commission = { num: 0, total: 0 };
        }
        results.push(data);
      }
    }
    return results;
  }

  // 从 GitHub 拉取更新
  async updatePlugin(e) {
    const isForce = e.msg.includes('强制');
    // 强制更新也保留用户 config.yaml（用户配置不入库、不被 checkout 覆盖）
    const cfgUser = `${pluginDir}/config/config.yaml`;
    const cfgBak = `${pluginDir}/config/config.yaml.bak`;
    const preserveCfg = `if [ -f "${cfgUser}" ]; then cp -f "${cfgUser}" "${cfgBak}"; fi`;
    const restoreCfg = `if [ -f "${cfgBak}" ]; then mv -f "${cfgBak}" "${cfgUser}"; fi`;
    const cmd = isForce
      ? `${preserveCfg}; git -C ${pluginDir} checkout . && git -C ${pluginDir} pull --no-rebase; ${restoreCfg}`
      : `git -C ${pluginDir} pull --no-rebase`;

    e.reply(`开始${isForce ? '强制' : ''}更新 xhh-TL...`, quoteEnabled());

    const execAsync = (command) => new Promise((resolve) => {
      exec(command, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      });
    });

    const { stdout: oldHeadOut } = await execAsync(`git -C ${pluginDir} rev-parse --short HEAD`);
    const oldCommitId = oldHeadOut.trim();

    const { error, stdout, stderr } = await execAsync(cmd);
    if (error) {
      logger.error(`[xhh-TL] 更新失败: ${stderr || error.message}`);
      e.reply(`xhh-TL 更新失败: ${stderr || error.message}`, quoteEnabled());
      return true;
    }
    if (/Already up|已经是最新/.test(stdout)) {
      e.reply('xhh-TL 已经是最新版本', quoteEnabled());
      return true;
    }

    const { stdout: timeOut } = await execAsync(
      `git -C ${pluginDir} log -1 --format="%cd" --date=format:"%m-%d %H:%M"`,
    );
    const time = timeOut.trim() || '未知';
    e.reply(`xhh-TL 更新成功！\n更新时间: ${time}\n请重启以应用更新`, quoteEnabled());

    // 合并转发本次更新日志
    try {
      const logCmd = oldCommitId
        ? `git -C ${pluginDir} log ${oldCommitId}..HEAD --pretty="[%cd] %s" --date=format:"%F %T"`
        : `git -C ${pluginDir} log -20 --pretty="[%cd] %s" --date=format:"%F %T"`;
      const { stdout: logOut } = await execAsync(logCmd);
      const entries = logOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.includes('Merge branch'));
      if (entries.length) {
        const forwardMsg = await common.makeForwardMsg(e, [
          `xhh-TL 更新日志，共${entries.length}条`,
          entries.join('\n\n'),
        ]);
        await replyForward(e, forwardMsg);
      }
    } catch (errLog) {
      logger.error(`[xhh-TL] 获取更新日志失败: ${errLog?.message || errLog}`);
    }
    return true;
  }

  async toggleUidDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_uid:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启体力UID显示' : '已关闭体力UID显示，查询体力时将隐藏UID');
    return true;
  }

  async toggleGsDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_gs:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启原神体力显示，体力总览将包含原神' : '已关闭原神体力显示，体力总览将隐藏原神');
    return true;
  }

  async toggleSrDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_sr:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启星铁体力显示，体力总览将包含星铁' : '已关闭星铁体力显示，体力总览将隐藏星铁');
    return true;
  }

  async toggleZzzDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_zzz:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启绝区零体力显示，体力总览将包含绝区零' : '已关闭绝区零体力显示，体力总览将隐藏绝区零');
    return true;
  }

  async toggleWavesDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_waves:${e.user_id}`, String(enable));
    if (enable && !isWavesTlEnabled()) {
      e.reply('已记录，但锅巴里的「启用鸣潮体力」还没打开，总览暂时不会带鸣潮');
      return true;
    }
    e.reply(enable
      ? '已开启鸣潮体力显示，体力总览将附带鸣潮（数据取自 gsuid_core 鸣潮插件的登录凭证）'
      : '已关闭鸣潮体力显示，体力总览将隐藏鸣潮');
    return true;
  }

  /**
   * 单 UID 体力屏蔽：#关闭原神123456789 屏蔽，#开启原神123456789 恢复。
   * 屏蔽后该 UID 不出现在任何体力卡里（总览 / 单游戏 / 多号列表都跳过，也不再为它请求接口），
   * 绑定与体力推送订阅都不动。
   */
  async toggleUidHidden(e) {
    const msg = (e.msg || '').trim();
    const m = /^#?(取消屏蔽|解除屏蔽|开启|打开|恢复|显示|关闭|关掉|屏蔽|隐藏)(原神|ys|星铁|xt|绝区零|zzz|鸣潮|mc)(?:体力)?\s*(\d{6,12})$/.exec(msg);
    if (!m) return false;
    const [, action, alias, uid] = m;
    const game = GAME_ALIAS[alias];
    const label = GAME_LABEL[game];
    // 「取消屏蔽/解除屏蔽」含「屏蔽」，故先判恢复词
    const unhide = /^(取消屏蔽|解除屏蔽|开启|打开|恢复|显示)$/.test(action);
    const qq = e.user_id;

    const hidden = await getHiddenUids(qq, game);
    if (unhide) {
      if (!hidden.delete(uid)) {
        e.reply(`${label} UID ${uid} 本来就没被屏蔽`, quoteEnabled());
        return true;
      }
      await setHiddenUids(qq, game, hidden);
      e.reply(`已恢复 ${label} UID ${uid} 的体力显示`, quoteEnabled());
      return true;
    }

    if (hidden.has(uid)) {
      e.reply(`${label} UID ${uid} 已在屏蔽列表里，发【#开启${label}${uid}】可恢复`, quoteEnabled());
      return true;
    }

    // 能枚举出绑定列表时校验一次，挡掉打错的 UID；枚举不到（无凭证/鸣潮没开）就不拦
    const bound = await this.listBoundUids(e, game, qq);
    if (bound.length && !bound.includes(uid)) {
      e.reply(`没在你的${label}绑定里找到 UID ${uid}\n当前绑定：${bound.join('、')}`, quoteEnabled());
      return true;
    }

    hidden.add(uid);
    await setHiddenUids(qq, game, hidden);
    const lines = [`已屏蔽 ${label} UID ${uid} 的体力显示（不影响绑定和体力推送）`];
    if (bound.length) {
      const rest = bound.filter((u) => !hidden.has(u));
      lines.push(rest.length
        ? `剩余显示：${rest.join('、')}`
        : `该游戏已无可显示 UID，查${label}体力会提示已屏蔽`);
    }
    lines.push(`恢复：#开启${label}${uid}`);
    e.reply(lines.join('\n'), quoteEnabled());
    return true;
  }

  /** #体力屏蔽列表 */
  async hiddenUidList(e) {
    const all = await getAllHiddenUids(e.user_id);
    const games = Object.keys(all);
    if (!games.length) {
      e.reply('你没有屏蔽任何 UID\n屏蔽：#关闭原神123456789（该 UID 不再出现在体力卡里）', quoteEnabled());
      return true;
    }
    const lines = games.map((g) => `${GAME_LABEL[g]}：${all[g].join('、')}`);
    e.reply(
      `已屏蔽的体力 UID：\n${lines.join('\n')}\n` +
      `恢复：#开启${GAME_LABEL[games[0]]}${all[games[0]][0]}`,
      true,
    );
    return true;
  }

  /** 枚举某人某游戏的绑定 UID（拿不到就返回空数组，调用方不要据此下结论） */
  async listBoundUids(e, game, qq) {
    try {
      if (game === 'ww') {
        if (!isWavesTlEnabled()) return [];
        const accounts = await listWavesAccounts(qq);
        return accounts.map((a) => String(a.uid)).filter(Boolean);
      }
      const list = (await createUser(qq, e)).getUidList(game) || [];
      return list.map((it) => String(it.uid || it)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * 一个号都没查到时的提示文案：号是被自己屏蔽掉的就直说，
   * 别一律甩「没绑定/去扫码」把人往错方向指
   */
  async noAccountTip(qq, fallback) {
    const hidden = await getAllHiddenUids(qq);
    const count = Object.values(hidden).reduce((n, arr) => n + arr.length, 0);
    return count
      ? `没有可显示的体力数据，你已屏蔽 ${count} 个 UID，发【#体力屏蔽列表】查看`
      : fallback;
  }

  // ============ 立绘卡（原神/星铁大立绘） ============

  // 立绘卡总流程：gs/sr/zzz/ww 均渲染立绘卡，合并回复
  async renderPortraitFlow(e, opts) {
    const {
      isQueryAll, isStarRail, isZZZ, isGenshin, isWaves, resultData, displayInfo, targetQq,
      showGs = true, showSr = true, showZzz = true, showWaves = false,
    } = opts;
    const overviewShow = { gs: showGs, sr: showSr, zzz: showZzz, ww: showWaves };
    const games = (isQueryAll ? ['gs', 'sr', 'zzz', 'ww']
      : isWaves ? ['ww']
        : isStarRail ? ['sr']
          : isZZZ ? ['zzz']
            : isGenshin ? ['gs']
              : ['gs']).filter(g => !isQueryAll || overviewShow[g]);

    const cfg = config();
    const multi = cfg.show_all_bindings;
    // 卡片样式：widget=桌面小组件竖卡，其余=立绘横卡
    const isWidget = cfg.tl_card_style === 'widget';
    // 立绘卡 body 900px（横版宽卡）基准 1.0；小组件卡 620px（竖版）用 1.4 提清晰度
    const portraitScale = getRenderScaleStyle(cfg, isWidget ? 1.4 : 1.0);
    const qq = targetQq || e.user_id;

    // 收集每个游戏的数据列表
    const dataMap = {};
    for (const game of games) {
      let list = [];
      if (multi) {
        list = await this.fetchGameDataList(e, game, true, qq);
      } else {
        const single = resultData[`${game}_data`];
        if (single && !['没有', '过期'].includes(single) && single !== false) list = [single];
      }
      if (list.length) dataMap[game] = list;
    }

    if (!Object.keys(dataMap).length) {
      e.reply(await this.noAccountTip(qq, '没有找到有效绑定的账号'), quoteEnabled());
      return true;
    }

    const segments = [];
    for (const game of games) {
      const list = dataMap[game];
      if (!list) continue;
      for (const item of list) {
        const seg = isWidget
          ? await this.renderWidgetCard(e, game, item, displayInfo, portraitScale)
          : await this.renderPortraitCard(e, game, item, displayInfo, portraitScale);
        if (seg) segments.push(seg);
      }
    }

    if (!segments.length) {
      e.reply('图片渲染失败，请稍后重试', quoteEnabled());
      return true;
    }

    const cardsPerMsg = cfg.tl_cards_per_msg || 3;
    if (segments.length === 1) {
      await replyQuote(e, segments[0]);
    } else if (segments.length > cardsPerMsg) {
      const fwd = await common.makeForwardMsg(e, segments);
      await replyForward(e, fwd);
    } else {
      await replyQuote(e, segments);
    }
    return true;
  }

  /**
   * 构建体力卡通用数据（立绘卡 / 小组件卡共用）
   * 返回 d = { game, uid, time, portrait, bg, bars, stats, status }
   */
  async buildStaminaData(game, item, displayInfo) {
    const showUid = await getShowUid(displayInfo.qq);
    const uid = showUid ? item.uid : '****';
    const portrait = pickCharacterPortrait(game);
    const bg = pickPortraitBg();

    const pct = (cur, max) => {
      const c = Number(cur) || 0, m = Number(max) || 0;
      if (m <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((c / m) * 100)));
    };
    const done = (cur, max) => Number(max) > 0 && Number(cur) >= Number(max);

    let bars = [], stats = [], status = [];
    if (game === 'gs') {
      const resin = Number(item.current_resin) || 0;
      bars = [
        { icon: '树脂.png', name: '原粹树脂', cur: resin, max: item.max_resin || 160, pct: pct(resin, item.max_resin || 160), warn: resin >= 160 },
        { icon: '洞天宝钱.png', name: '洞天宝钱', cur: item.current_home_coin || 0, max: item.max_home_coin || 0, pct: pct(item.current_home_coin, item.max_home_coin), warn: done(item.current_home_coin, item.max_home_coin) },
        { icon: '冒险委托.png', name: '每日委托', cur: item.finished_task_num || 0, max: item.total_task_num || 0, pct: pct(item.finished_task_num, item.total_task_num), warn: false },
      ];
      status = [
        { ok: done(item.finished_task_num, item.total_task_num), text: done(item.finished_task_num, item.total_task_num) ? '每日委托已完成！' : '每日委托未完成' },
        { ok: !!item.is_extra_task_reward_received, text: item.is_extra_task_reward_received ? '委托奖励已领取！' : '委托奖励未领取' },
      ];
      // 砺行修远：widget 原生 week_active_progress（本周 / 本期）
      const wap = item.week_active_progress || {};
      const hasWap = wap.unlock === true;
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '冒险等阶' },
        { val: `${item.current_expedition_num || 0}/${item.max_expedition_num || 0}`, key: '探索派遣' },
        hasWap
          ? { val: `${wap.period_progress_current || 0}/${wap.period_progress_total || 0}`, key: '砺行修远' }
          : { val: `${item.finished_task_num || 0}/${item.total_task_num || 0}`, key: '每日委托' },
      ];
    } else if (game === 'zzz') {
      const energy = item.energy?.progress || {};
      const cur = Number(energy.current) || 0;
      const max = Number(energy.max) || 240;
      const vitality = item.vitality || {};
      bars = [
        { icon: '电池.png', name: '电量', cur, max, pct: pct(cur, max), warn: max > 0 && cur >= max },
        { icon: '活跃度.png', name: '今日活跃度', cur: Number(vitality.current) || 0, max: Number(vitality.max) || 0, pct: pct(vitality.current, vitality.max), warn: false },
      ];
      // widget 原生 note_list：{name, value, value_highlight}，直接对应官方任务清单
      const noteList = Array.isArray(item.note_list) ? item.note_list : [];
      const doneReg = /(已完成|已签到|营业中|已领取|已满)/;
      const lockReg = /(未解锁|未开启)/;
      status = noteList.map((n) => ({
        ok: doneReg.test(n.value || ''),
        locked: lockReg.test(n.value || ''),
        text: `${n.name}：${n.value || ''}`,
        name: n.name,
        value: n.value || '',
      }));
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '绳网等级' },
        { val: `${Number(vitality.current) || 0}/${Number(vitality.max) || 0}`, key: '今日活跃' },
        { val: cur >= max && max > 0 ? '已满' : `${cur}/${max}`, key: '电量' },
      ];
    } else if (game === 'ww') {
      // 鸣潮：数据来自库街区小组件接口，字段已在 wavesData.normalizeWavesItem 归一化
      const st = Number(item.current_stamina) || 0;
      const stMax = Number(item.max_stamina) || 240;
      const store = Number(item.store_energy) || 0;
      const storeMax = Number(item.max_store_energy) || 480;
      const live = Number(item.liveness) || 0;
      const liveMax = Number(item.max_liveness) || 100;
      bars = [
        { icon: 'ww/结晶波片.png', name: '结晶波片', cur: st, max: stMax, pct: pct(st, stMax), warn: done(st, stMax) },
        { icon: 'ww/结晶单质.png', name: '结晶单质', cur: store, max: storeMax, pct: pct(store, storeMax), warn: done(store, storeMax) },
        { icon: 'ww/活跃度.png', name: '今日活跃度', cur: live, max: liveMax, pct: pct(live, liveMax), warn: false },
      ];
      status = [
        { ok: !!item.has_signed, text: item.has_signed ? '库街区已签到！' : '库街区未签到' },
        { ok: done(live, liveMax), text: done(live, liveMax) ? '今日活跃度已满！' : '今日活跃度未满' },
        { ok: item.boss_left <= 0, text: item.boss_left > 0 ? `战歌重奏剩 ${item.boss_left} 次可收取` : '战歌重奏已收完' },
      ];
      // 周期挑战（深塔/海墟）没做完就提示一下，和 xw 的催促口径一致
      for (const [label, blk] of [['逆境深塔', item.tower], ['冥歌海墟', item.slash]]) {
        if (!blk) continue;
        status.push({ ok: blk.done, text: `${blk.name || label}：${blk.cur}/${blk.total}` });
      }
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '漂泊者等级' },
        { val: `${item.boss_left}/${item.boss_total}`, key: '战歌重奏' },
        { val: item.bp_level ? `Lv.${item.bp_level}` : '—', key: '先约电台' },
      ];
    } else {
      const st = Number(item.current_stamina) || 0;
      bars = [
        { icon: '开拓力.png', name: '开拓力', cur: st, max: item.max_stamina || 300, pct: pct(st, item.max_stamina || 300), warn: done(st, item.max_stamina) },
        { icon: '每日实训.png', name: '每日实训', cur: item.current_train_score || 0, max: item.max_train_score || 0, pct: pct(item.current_train_score, item.max_train_score), warn: false },
        { icon: '模拟宇宙.png', name: '模拟宇宙', cur: item.current_rogue_score || 0, max: item.max_rogue_score || 0, pct: pct(item.current_rogue_score, item.max_rogue_score), warn: false },
      ];
      status = [
        { ok: done(item.current_train_score, item.max_train_score), text: done(item.current_train_score, item.max_train_score) ? '每日实训已满！' : '每日实训未满' },
        { ok: !!item.expeditions_, text: item.expeditions_ ? '委托已全部完成！' : '委托未全部完成' },
      ];
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '开拓等级' },
        { val: `${item.accepted_expedition_num || 0}/${item.total_expedition_num || 0}`, key: '委托派遣' },
        { val: `${item.current_reserve_stamina || 0}`, key: '后备开拓力' },
      ];
    }

    return {
      game,
      uid,
      time: item.time || '已满',
      portrait,
      bg,
      bars,
      stats,
      status,
      acts: this.buildActivities(game, item),
      pools: this.buildCardPools(game, item),
    };
  }

  /**
   * 星铁卡池（widget 原生 activity_calendar_v2.card_pool_list，官方小组件右上角同源）
   * 每条：{ avatar_list:[{icon_url}], title:[{content}], id }
   * 统一输出 { label, sub, icons:[url] }：label=首个非「剩余」标题，sub=倒计时
   * 仅 sr 有；其余游戏返回空数组
   */
  buildCardPools(game, item) {
    if (game !== 'sr') return [];
    const list = item.activity_calendar_v2?.card_pool_list;
    if (!Array.isArray(list)) return [];

    const pools = [];
    for (const p of list) {
      if (!p) continue;
      const titles = Array.isArray(p.title)
        ? p.title.map((t) => (t && typeof t === 'object' ? t.content ?? '' : String(t ?? ''))).filter(Boolean)
        : [];
      // 「剩余N天」当副标题，其余当主标题（联动 / 姬子·启行）
      const isCd = (s) => /剩余|天|结束|开启/.test(s);
      const label = titles.find((t) => !isCd(t)) || titles[0] || '';
      const sub = titles.find(isCd) || '';
      const icons = Array.isArray(p.avatar_list)
        ? p.avatar_list.map((a) => a?.icon_url).filter(Boolean)
        : [];
      if (!icons.length && !label) continue;
      pools.push({ label, sub, icons });
    }
    return pools;
  }

  /**
   * 解析「限时活动 / 任务清单」，输出统一结构 { title, progress, countdown, urgent }
   * - gs: item.act_calendar（cookie 接口 act_calendar，act_list + fixed_act_list）
   *       type 映射进度：幽境危战→难度罗马数字，渊月螺旋/剧诗→星数，其余→进行中
   * - sr: item.activity_calendar_v2.activity_list（title/progress/count_down 均为 [{content,is_highlight}]）
   * - zzz: 任务清单 note_list（{name, value, value_highlight}）+ 活动 activity_list
   * 字段缺失即空串，绝不报错
   */
  buildActivities(game, item) {
    // 把 [{content, is_highlight}] 或字符串/数组，压成 { text, highlight }
    const flat = (val) => {
      if (val == null) return { text: '', highlight: false };
      if (typeof val === 'string') return { text: val, highlight: false };
      if (Array.isArray(val)) {
        return {
          text: val.map((x) => (x && typeof x === 'object' ? x.content ?? '' : x ?? '')).join(''),
          highlight: val.some((x) => x && typeof x === 'object' && x.is_highlight === true),
        };
      }
      if (typeof val === 'object') return { text: val.content ?? '', highlight: val.is_highlight === true };
      return { text: String(val), highlight: false };
    };

    const acts = [];

    // 原神：cookie 接口 act_calendar（widget 的 act_list 恒空，不用）
    if (game === 'gs') {
      return this.buildGsActivities(item.act_calendar);
    }

    // 鸣潮：当期活动 + 周期挑战（深塔/海墟/终焉矩阵/周度游历），字段已由 wavesData 归一化
    if (game === 'ww') {
      if (item.activity?.title) {
        acts.push({
          title: item.activity.title,
          progress: (item.activity.rewards || []).slice(0, 2).join(' · '),
          countdown: item.activity.time_text || '',
          urgent: !!item.activity.urgent,
        });
      }
      const blocks = [
        [item.tower, '逆境深塔'],
        [item.slash, '冥歌海墟'],
        [item.new_tower, '终焉矩阵'],
      ];
      for (const [blk, label] of blocks) {
        if (!blk) continue;
        acts.push({
          title: blk.name || label,
          progress: blk.total > 0 ? `${blk.cur}/${blk.total}` : String(blk.cur),
          countdown: blk.time_text || '',
          urgent: !!blk.urgent,
        });
      }
      if (item.frame_total > 0) {
        acts.push({
          title: '周度游历',
          progress: `${item.frame_cur}/${item.frame_total}`,
          countdown: '',
          urgent: item.frame_cur < item.frame_total,
        });
      }
      return acts;
    }

    // zzz 的任务清单走 note_list（官方小组件同款那几行），结构与 sr 不同，单独解析
    if (game === 'zzz') {
      const noteList = Array.isArray(item.note_list) ? item.note_list : [];
      for (const n of noteList) {
        if (!n) continue;
        const title = String(n.name ?? '').trim();
        if (!title) continue;
        acts.push({
          title,
          progress: String(n.value ?? '').trim(),
          countdown: '',
          urgent: n.value_highlight === true,
        });
      }
    }

    // 通用活动列表（sr 走 activity_calendar_v2；zzz 的 activity_list 有活动时也带上）
    let rawList = [];
    if (game === 'sr') rawList = item.activity_calendar_v2?.activity_list || [];
    else if (game === 'zzz') rawList = item.activity_list || [];
    if (!Array.isArray(rawList)) rawList = [];

    for (const it of rawList) {
      if (!it) continue;
      const title = flat(it.title).text.trim();
      if (!title) continue;
      const p = flat(it.progress);
      const c = flat(it.count_down ?? it.countdown);
      acts.push({
        title,
        progress: p.text.trim(),
        countdown: c.text.trim(),
        urgent: c.highlight || p.highlight,
      });
    }
    return acts;
  }

  /**
   * 原神 act_calendar 解析（act_list 限时活动 + fixed_act_list 固定活动）
   * status: 1=未开始 2=进行中；countdown_seconds 秒
   * 进度列按活动类型：幽境危战→难度(罗马)，渊月螺旋/剧诗→星数，其余→进行中
   */
  buildGsActivities(cal) {
    if (!cal || typeof cal !== 'object') return [];
    const roman = (n) => (['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n));
    const days = (sec) => {
      const s = Number(sec) || 0;
      if (s <= 0) return '';
      const d = Math.floor(s / 86400);
      if (d >= 1) return `剩余${d}天`;
      const h = Math.floor(s / 3600);
      return h >= 1 ? `剩余${h}小时` : '即将结束';
    };

    const parse = (it, isFixed) => {
      if (!it) return null;
      const title = String(it.name ?? '').trim();
      if (!title) return null;
      const status = Number(it.status) || 0;
      const cd = Number(it.countdown_seconds) || 0;
      // 未开始且无排期（如地脉移涌 start=0）跳过
      if (status === 1 && cd <= 0) return null;
      // 限时活动已结束就不显示；固定活动（渊月螺旋/剧诗）即使完成也保留进度
      if (!isFixed && it.is_finished === true) return null;

      let countdown = '';
      let urgent = false;
      if (status === 1) {
        countdown = days(cd).replace('剩余', '') + '后开启';
      } else {
        countdown = days(cd);
        const d = Math.floor(cd / 86400);
        urgent = cd > 0 && d <= 1;
      }

      // 进度列按类型
      let progress = '';
      if (it.type === 'ActTypeHardChallenge' && it.hard_challenge_detail?.is_unlock) {
        progress = `难度${roman(Number(it.hard_challenge_detail.difficulty) || 0)}`;
      } else if (it.type === 'ActTypeTower' && it.tower_detail?.has_data) {
        progress = `${it.tower_detail.total_star ?? 0}/${it.tower_detail.max_star ?? 0}`;
      } else if (it.type === 'ActTypeRoleCombat' && it.role_combat_detail?.has_data) {
        // 返回只有 max_round_id（已通关到第几幕），无可靠总幕数，不编造分母
        const r = Number(it.role_combat_detail.max_round_id) || 0;
        progress = r > 0 ? `第${r}幕` : '进行中';
      } else if (status === 2) {
        progress = '进行中';
      } else if (status === 1) {
        progress = '未开启';
      }

      return { title, progress, countdown, urgent, _status: status, _cd: cd };
    };

    const out = [];
    const seen = new Set();
    // 限时活动在前，固定活动（渊月螺旋/剧诗）在后
    const tagged = [
      ...(Array.isArray(cal.act_list) ? cal.act_list.map((it) => [it, false]) : []),
      ...(Array.isArray(cal.fixed_act_list) ? cal.fixed_act_list.map((it) => [it, true]) : []),
    ];
    for (const [it, isFixed] of tagged) {
      const a = parse(it, isFixed);
      if (!a) continue;
      if (seen.has(a.title)) continue;
      seen.add(a.title);
      out.push(a);
    }
    // 进行中优先，其次按剩余时间升序
    out.sort((a, b) => {
      if ((a._status === 2) !== (b._status === 2)) return a._status === 2 ? -1 : 1;
      return (a._cd || Infinity) - (b._cd || Infinity);
    });
    return out.map(({ title, progress, countdown, urgent }) => ({ title, progress, countdown, urgent }));
  }

  // 单个 gs/sr/zzz UID → 一张立绘卡 segment
  async renderPortraitCard(e, game, item, displayInfo, renderScale) {
    const d = await this.buildStaminaData(game, item, displayInfo);

    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const tplFile = pluginDir + '/resources/Tl/Portrait.html';
    const renderData = { d, qq: displayInfo.qq, qqname: displayInfo.qqname };

    const renderResult = await e.runtime.render('小火花', 'Tl/Portrait', renderData, {
      retType: 'base64',
      imgType: 'png',
      beforeRender({ data }) {
        return {
          imgType: 'png',
          sys: { scale: renderScale },
          ...renderData,
          ppath,
          tplFile,
          saveId: `Portrait_${game}`,
        };
      },
    });
    const image = await toWebp(extractRenderBuffer(renderResult));
    return image ? segment.image(image) : null;
  }

  // 单个 gs/sr/zzz UID → 一张桌面小组件卡 segment
  async renderWidgetCard(e, game, item, displayInfo, renderScale) {
    const d = await this.buildStaminaData(game, item, displayInfo);

    // 小组件竖卡：仅取 bars[0] 作主资源大数字（中间列表框已按需求移除）
    const [primary] = d.bars || [];
    d.primary = primary || null;

    // 顶部横幅立绘内联为 data URI：CSS background-image 加载 file:// 不阻塞截图，
    // 偶发会截到背景尚未解码的一帧（渐变底色露出）；内联后像素随 HTML 到位，消除该竞态。
    if (d.portrait) d.portrait = await toDataUrlTrim(d.portrait);

    // 限时活动区块：数据来自 widget 接口自带字段（buildStaminaData 已解析进 d.acts）
    // 与官方桌面小组件同源，零额外请求；可关，为空则模板自动不显示
    if (config().tl_widget_activity === false) {
      d.acts = [];
    } else {
      const limit = Number(config().tl_widget_activity_limit) || 4;
      d.acts = (d.acts || []).slice(0, limit);
    }

    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const tplFile = pluginDir + '/resources/Tl/Widget.html';
    const renderData = { d, qq: displayInfo.qq, qqname: displayInfo.qqname };

    const renderResult = await e.runtime.render('小火花', 'Tl/Widget', renderData, {
      retType: 'base64',
      imgType: 'png',
      beforeRender({ data }) {
        return {
          imgType: 'png',
          sys: { scale: renderScale },
          ...renderData,
          ppath,
          tplFile,
          saveId: `Widget_${game}`,
        };
      },
    });
    const image = await toWebp(extractRenderBuffer(renderResult));
    return image ? segment.image(image) : null;
  }

  async hideUidIfNeeded(data, qq) {
    const showUid = await getShowUid(qq);
    if (showUid) return;
    const keyMap = ['gs_list', 'sr_list', 'zzz_list', 'ww_list'];
    for (const key of keyMap) {
      if (data[key]) {
        for (const item of data[key]) {
          if (item && item.uid) item.uid = '****';
        }
      }
    }
  }

  // 体力
  async note(e, game = 'gs', san = true, targetQq = null, forceUid = null) {
    const qq = targetQq || e.user_id;
    let uid;
    if (forceUid) {
      uid = forceUid;
    } else if (targetQq) {
      try { uid = (await createUser(targetQq, e)).getUid(game); } catch (_) {}
    } else {
      try {
        uid = e.user?.getUid?.(game);
      } catch (_) {}
      if (!uid) {
        try { uid = (await createUser(qq, e)).getUid(game); } catch (_) {}
      }
    }

    if (!uid) {
      if (!san) e.reply('未发现绑定的 uid，请【#扫码登录】米游社~');
      return '没有';
    }

    // 单号模式下主 UID 被 #关闭<游戏><uid> 屏蔽：顺位取第一个未屏蔽的号，
    // 全被屏蔽才算没有。forceUid（多号列表 / 体力推送）由调用方自己过滤，这里不插手。
    if (!forceUid) {
      const hidden = await getHiddenUids(qq, game);
      if (hidden.has(String(uid))) {
        const alt = (await this.listBoundUids(e, game, qq)).find((u) => !hidden.has(u));
        if (!alt) {
          if (!san) {
            e.reply(
              `你已屏蔽${GAME_LABEL[game]}全部 UID 的体力显示，发【#开启${GAME_LABEL[game]}${uid}】可恢复`,
              true,
            );
          }
          return '没有';
        }
        uid = alt;
      }
    }

    let sk = await getstoken(qq, uid, e);

    // getstoken 拿不到凭证时（该用户无扫码 stoken，且 SQLite 兜底被「存活账号」
    // gating 滤掉），退回到与「全部深渊」完全同一条 cookie 链路（resolveAuth 直接读
    // mysUsers[].ck，不做 gating）。gs/sr 走 cookie 版 dailyNote 即可查体力。
    if (!sk && game !== 'zzz') {
      try {
        const auth = await resolveAuth(e, { needCookie: true, game });
        if (auth?.ck) {
          const res0 = await this.noteViaCookie(e, game, auth.ck, uid);
          if (res0 && res0.retcode === 0) {
            sk = auth.ck; // 供下方 getGameDate 复用（cookie 版 GameRoles 可用）
            return await this.finishNote(e, game, res0, uid, getHeaders(e, sk, false));
          }
        }
      } catch (err) {
        logger.debug?.(`[xhh-TL][note][resolveAuth 兜底] ${err?.message}`);
      }
    }

    if (!sk) {
      if (!san)
        e.reply('UID:' + uid + ' 未绑定米游社 SToken，请【#扫码登录】米游社~', quoteEnabled());
      return '没有';
    }
    // sk 可能是纯 cookie：无扫码 stoken 的用户走 getstoken 的 SQLite 兜底，
    // 只拿到 cookie_token/ltoken。体力 widget 接口靠 stoken 鉴权，纯 cookie 必被拒。
    // 此时改走 cookie 版 dailyNote（与「全部深渊」同源，字段同名可直接复用后续流程）。
    const hasStoken = /stoken=/.test(sk);
    const canCookieFallback =
      /cookie_token=|ltoken=|account_id=/.test(sk) && game !== 'zzz';

    let headers = getHeaders(e, sk, false);
    let res;
    if (!hasStoken && canCookieFallback) {
      // 纯 cookie：直接走 dailyNote，不浪费一次注定失败的 widget 请求
      res = await this.noteViaCookie(e, game, sk, uid);
    } else {
      let url =
        game == 'gs' ? this.gsUrl : game == 'sr' ? this.srUrl : this.zzzUrl;
      // ZZZ API 需要特定 game_biz header
      if (game === 'zzz') {
        headers['x-rpc-game_biz'] = 'nap_cn';
        headers['x-rpc-signgame'] = 'zzz';
      }
      res = await fetch(url, {
        method: 'get',
        headers,
      }).then(res => res.json());
      // stoken 过期但同串仍带 cookie（gs/sr）→ 兜底 dailyNote
      if ([-10001, 10001, -100].includes(res?.retcode) && canCookieFallback) {
        const fb = await this.noteViaCookie(e, game, sk, uid);
        if (fb) res = fb;
      }
    }

    if ([-10001, 10001, -100].includes(res?.retcode)) {
      if (!san) {
        e.reply('登录验证过期，请【#刷新ck】，仍不行则【#扫码登录】');
      }
      return '过期';
    }

    return await this.finishNote(e, game, res, uid, headers);
  }

  /**
   * note() 拿到有效 res（retcode 0）后的公共收尾：算恢复时间、补等级、
   * 判派遣完成、拉原神活动日历，归一成渲染层需要的 data。widget 与 cookie
   * 兜底两条路径共用，字段同名故无需分支。
   */
  async finishNote(e, game, res, uid, headers) {
    if (!res || res.retcode !== 0) {
      logger.error(res);
      return false;
    }
    let time =
      res.data.resin_recovery_time ||
      res.data.stamina_recover_time ||
      res.data.energy?.restore;
    if (!time) time = 0;
    let game_ = await this.getGameDate(e, headers, uid);
    // 派遣，委托 是否全部完成
    if (res.data.expeditions?.length) {
      res.data.expeditions_ = res.data.expeditions.every(
        v => v.status === 'Finished'
      );
    }
    let data = {
      uid: uid,
      ...game_,
      time: time == 0 ? '已满' : getTime(time),
      ...res.data,
    };

    // 标注这份数据实际来自哪个米游社账号（stoken/CK 的属主 stuid）。
    // 原神体力 widget 接口不带 uid、只认 stoken 所属账号：两个不同的请求 UID
    // 若选到同一把凭证，返回的其实是同一个账号的体力。调用方（体力推送去重）
    // 需要按「真实账号」而非「请求 UID」判重，否则拦不住重复推送。
    // 用不可枚举属性挂载：不进 JSON / 不被 {...data} 带走，渲染层零影响。
    const ownerSid =
      cookiePart(headers?.Cookie || '', 'stuid') ||
      cookiePart(headers?.Cookie || '', 'account_id') ||
      cookiePart(headers?.Cookie || '', 'ltuid');
    if (ownerSid) {
      Object.defineProperty(data, '_ownerSid', {
        value: String(ownerSid),
        enumerable: false,
      });
    }

    // 原神活动日历：widget 接口不返回活动，用 cookie 额外拉 act_calendar（需完整 CK；失败静默不阻塞体力主流程）
    if (game === 'gs' && config().tl_widget_activity !== false) {
      try {
        const mys = await prepareMysContext(e, 'gs');
        const api = await mys?.runtime?.getMysApi?.('all', { game: 'gs' });
        if (api) {
          const acRes = await api.getData('act_calendar');
          if (acRes?.retcode === 0 && acRes.data) {
            data.act_calendar = acRes.data;
          }
        }
      } catch (err) {
        logger.debug?.(`[xhh-TL][act_calendar] ${err?.message}`);
      }
    }

    return data;
  }

  async getGameDate(e, headers, uid) {
    headers.DS = getDs();
    let res = await callApi(e, 'GameRoles', null, uid, null, headers, true);
    let data;
    if (!Array.isArray(res?.data?.list)) return data;
    res.data.list.forEach(v => {
      if (v.game_uid == uid) {
        data = {
          level: v.level,
          name: v.nickname,
        };
      }
    });
    return data;
  }

  /**
   * 纯 cookie 用户（无扫码 stoken）的体力兜底：走 cookie 版 dailyNote，
   * 与「全部深渊」同源（LiteMysApi）。gs/sr 的 dailyNote 字段与 widget 接口同名，
   * 归一成 { retcode, data } 后可直接接回 note() 后续流程，渲染层零改动。
   * zzz 的 note 结构差异大且官方另有 widget 专用接口，这里不兜底（上层已排除）。
   * @returns {object|false} 形如 widget 的响应；失败返回 false
   */
  async noteViaCookie(e, game, cookie, uid) {
    try {
      const api = new LiteMysApi(uid, cookie, { game, log: false });
      const res = await api.getData('dailyNote');
      if (!res || res.retcode !== 0 || !res.data) return res || false;
      // gs/sr 的 dailyNote 字段与 widget 完全同名（gs: current_resin/max_resin/
      // resin_recovery_time/expeditions…；sr: current_stamina/max_stamina/
      // stamina_recover_time/current_train_score/current_rogue_score/expeditions…），
      // 直接透传即可接回 note() 后续流程。level 由 getGameDate 补齐，
      // gs 缺 week_active_progress 时 buildStaminaData 自动回退到每日委托。
      return res;
    } catch (err) {
      logger.debug?.(`[xhh-TL][noteViaCookie][${game}] ${err?.message}`);
      return false;
    }
  }

}
