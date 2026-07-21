import { exec } from 'child_process';
import fetch from 'node-fetch';
import moment from 'moment';
import fs from 'fs';
import md5 from 'md5';
import lodash from 'lodash';
import plugin from '../../../lib/plugins/plugin.js';
import { createUser } from '../utils/userBind.js';
import { getstoken } from '../utils/auth.js';
import common from '../../../lib/common/common.js';
import { getRenderScaleStyle, readPluginConfig, pickCharacterPortrait, pickPortraitBg } from '../utils/pluginConfig.js';
import { extractRenderBuffer } from '../utils/renderImage.js';
import { replyQuote, replyForward } from '../utils/replyHelper.js';
import path from 'path';

// ============ 本地配置 ============
const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = pluginDir + '/config/config.yaml';

let _configCache = null;

function readConfig() {
  return readPluginConfig();
}

function config() {
  // 直接走 mtime 缓存，避免 Windows 上 fs.watch 不触发导致锅巴改完不生效
  return readConfig();
}

// 监听配置文件变化，自动热重载
try {
  if (fs.existsSync(configPath)) {
    fs.watch(configPath, () => {
      _configCache = readConfig();
      logger.info('[xhh-TL] 配置文件已更新，已重新加载');
    });
  }
} catch (_) {}

// ============ 用户 UID 显示设置 ============
async function getShowUid(qq) {
  const val = await redis.get(`xhh:show_uid:${qq}`);
  // 默认 true（显示）
  return val === null ? true : val !== 'false';
}

// 每个用户可单独开关「体力总览」里是否显示绝区零，默认 true（显示）
async function getShowZzz(qq) {
  const val = await redis.get(`xhh:show_zzz:${qq}`);
  return val === null ? true : val !== 'false';
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
          msg = `${uid ? 'UID:' + uid : ''}Cookie失效，请[刷新ck]或[扫码绑定]`;
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
      name: '[小花火]体力小组件',
      dsc: '体力',
      event: 'message',
      priority: config().tl_priority ?? -99,
      rule: [
        {
          // 可选 #/*/%；关键词必须完整结束，尾部多余字不触发
          // 「四游戏体力」保留作兼容别名（历史指令，现为三游戏）
          reg: '^\\s*(?:#|\\*|%)*(?:全体力|三游戏体力|四游戏体力|米游社体力|体力总览|体力|tl|(?:原神|ys)(?:体力|tl)|(?:星铁|xt|\\*)(?:体力|tl)|(?:绝区零|zzz)(?:体力|tl))\\s*$',
          fnc: 'note_',
        },
        {
          reg: '^\\s*#?(?:体力插件|小花火体力)(?:强制)?更新\\s*$',
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
          reg: '^\\s*#?(?:开启|打开|关闭|关掉)(?:绝区零|zzz)体力\\s*$',
          fnc: 'toggleZzzDisplay',
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

    // 绝区零显示开关：仅影响「体力总览」，默认显示；关闭后总览不查/不显示 zzz。
    // 以被查者为准：某人关了绝区零后，无论他自己查还是别人艾特查他，都不显示其绝区零。
    // 单独 #绝区零体力 不受此开关影响。
    const showZzz = isQueryAll ? await getShowZzz(targetQq || e.user_id) : true;

    if (isQueryAll) {
      hasAllData = true;
      logger.info('[xhh-TL][note_] 开始查询所有游戏体力');
      const [gsData, srData, zzzData] = await Promise.all([
        this.note(e, 'gs', true, targetQq),
        this.note(e, 'sr', true, targetQq),
        showZzz ? getZZZData() : Promise.resolve('没有'),
      ]);
      resultData = {
        gs_data: gsData,
        sr_data: srData,
      };
      if (showZzz) resultData.zzz_data = zzzData;
    } else if (isStarRail) {
      resultData = { sr_data: await this.note(e, 'sr', false, targetQq) };
    } else if (isZZZ) {
      resultData = { zzz_data: await getZZZData() };
    } else {
      resultData = { gs_data: await this.note(e, 'gs', false, targetQq) };
    }

    if (Object.values(resultData).every(v => v === '没有')) {
      if (hasAllData) e.reply('没有绑定米游社，请[扫码绑定]米游社', true);
      return true;
    }
    if (Object.values(resultData).every(v => v === '过期')) {
      if (hasAllData) e.reply('米游社验证已过期。请重新：扫码绑定 ', true);
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

    // 立绘卡样式：原神/星铁/绝区零均走大立绘卡片
    if (config().tl_card_style === 'portrait') {
      const displayInfo = { qq: displayQq, qqname: displayName };
      const handled = await this.renderPortraitFlow(e, {
        isQueryAll, isStarRail, isZZZ, isGenshin, showZzz,
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
      showZzz,
      targetQq,
    });
  }

  /** 经典 Tl.html 渲染一张图 → Buffer */
  async renderTlImage(e, data, renderScale) {
    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const tplFile = pluginDir + '/resources/Tl/Tl.html';
    const renderResult = await e.runtime.render('小花火', 'Tl/Tl', data, {
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
    return extractRenderBuffer(renderResult);
  }

  /** 按游戏列表出多张图（每张图可含 1 个或多个 UID） */
  async renderTlSegmentsByGames(e, allGameData, displayQq, displayName, renderScale, perGameChunkSize = 0) {
    const keyMap = { gs: 'gs_list', sr: 'sr_list', zzz: 'zzz_list' };
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
      isQueryAll, isStarRail, isZZZ, isGenshin, showZzz, targetQq,
    } = opts;
    const cfg = config();
    const renderScale = getRenderScaleStyle(cfg, 2.0);
    const keyMap = { gs: 'gs_list', sr: 'sr_list', zzz: 'zzz_list' };
    const cardsPerMsg = cfg.tl_cards_per_msg || 3;

    if (cfg.show_all_bindings) {
      const games = (isQueryAll ? ['gs', 'sr', 'zzz']
        : isStarRail ? ['sr']
        : isZZZ ? ['zzz']
        : isGenshin ? ['gs']
        : ['gs']).filter(g => !(isQueryAll && g === 'zzz' && !showZzz));

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
        e.reply('没有找到有效绑定的账号', true);
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
    await this.hideUidIfNeeded(listData, displayQq);
    const image = await this.renderTlImage(e, listData, renderScale);
    if (image) return replyQuote(e, segment.image(image));
    return replyQuote(e, '图片渲染失败，请稍后重试');
  }

  // 获取当前QQ某游戏的所有绑定UID的体力数据
  async fetchGameDataList(e, game, san, qq) {
    const results = [];

    // 通过兼容层枚举 UID（不依赖 genshin import）
    const noteUser = await createUser(qq, e);
    const uidList = noteUser.getUidList(game) || [];
    for (const item of uidList) {
      const uid = String(item.uid || item);
      if (!uid) continue;
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

    e.reply(`开始${isForce ? '强制' : ''}更新 xhh-TL...`, true);

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
      e.reply(`xhh-TL 更新失败: ${stderr || error.message}`, true);
      return true;
    }
    if (/Already up|已经是最新/.test(stdout)) {
      e.reply('xhh-TL 已经是最新版本', true);
      return true;
    }

    const { stdout: timeOut } = await execAsync(
      `git -C ${pluginDir} log -1 --format="%cd" --date=format:"%m-%d %H:%M"`,
    );
    const time = timeOut.trim() || '未知';
    e.reply(`xhh-TL 更新成功！\n更新时间: ${time}\n请重启以应用更新`, true);

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

  async toggleZzzDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_zzz:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启绝区零体力显示，体力总览将包含绝区零' : '已关闭绝区零体力显示，体力总览将隐藏绝区零');
    return true;
  }

  // ============ 立绘卡（原神/星铁大立绘） ============

  // 立绘卡总流程：gs/sr/zzz 均渲染立绘卡，合并回复
  async renderPortraitFlow(e, opts) {
    const { isQueryAll, isStarRail, isZZZ, isGenshin, resultData, displayInfo, targetQq, showZzz = true } = opts;
    const games = (isQueryAll ? ['gs', 'sr', 'zzz']
      : isStarRail ? ['sr']
        : isZZZ ? ['zzz']
          : isGenshin ? ['gs']
            : ['gs']).filter(g => !(isQueryAll && g === 'zzz' && !showZzz));

    const cfg = config();
    const multi = cfg.show_all_bindings;
    // 立绘卡 body 本身 900px（横版宽卡），基准倍率用 1.0 即可，避免出图过大
    const portraitScale = getRenderScaleStyle(cfg, 1.0);
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
      e.reply('没有找到有效绑定的账号', true);
      return true;
    }

    const segments = [];
    for (const game of games) {
      const list = dataMap[game];
      if (!list) continue;
      for (const item of list) {
        const seg = await this.renderPortraitCard(e, game, item, displayInfo, portraitScale);
        if (seg) segments.push(seg);
      }
    }

    if (!segments.length) {
      e.reply('图片渲染失败，请稍后重试', true);
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

  // 单个 gs/sr/zzz UID → 一张立绘卡 segment
  async renderPortraitCard(e, game, item, displayInfo, renderScale) {
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
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '冒险等阶' },
        { val: `${item.current_expedition_num || 0}/${item.max_expedition_num || 0}`, key: '探索派遣' },
        { val: `${item.finished_task_num || 0}/${item.total_task_num || 0}`, key: '每日委托' },
      ];
    } else if (game === 'zzz') {
      const energy = item.energy?.progress || {};
      const cur = Number(energy.current) || 0;
      const max = Number(energy.max) || 240;
      const vitality = item.vitality || {};
      const bounty = item.s2_bounty_commission || { num: 0, total: 0 };
      const weekly = item.weekly_task || {};
      const cardDone = item.card_sign === 'CardSignDone';
      const vhsDoing = item.vhs_sale?.sale_state === 'SaleStateDoing';
      bars = [
        { icon: '电池.png', name: '电量', cur, max, pct: pct(cur, max), warn: max > 0 && cur >= max },
        { icon: '活跃度.png', name: '今日活跃度', cur: Number(vitality.current) || 0, max: Number(vitality.max) || 0, pct: pct(vitality.current, vitality.max), warn: false },
        { icon: 'zzz.png', name: '悬赏委托', cur: Number(bounty.num) || 0, max: Number(bounty.total) || 0, pct: pct(bounty.num, bounty.total), warn: false },
      ];
      status = [
        { ok: cardDone, text: cardDone ? '刮刮卡已签到！' : '刮刮卡尚未签到' },
        { ok: vhsDoing, text: vhsDoing ? '录像店营业中' : '录像店待结算' },
      ];
      const weekCur = Number(weekly.cur_point);
      const weekMax = Number(weekly.max_point);
      stats = [
        { val: item.level != null ? `Lv.${item.level}` : '—', key: '绳网等级' },
        {
          val: Number.isFinite(weekCur) && Number.isFinite(weekMax)
            ? `${weekCur}/${weekMax}`
            : '未解锁',
          key: '丽都周纪',
        },
        { val: `${Number(bounty.num) || 0}/${Number(bounty.total) || 0}`, key: '悬赏委托' },
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

    const d = {
      game,
      uid,
      time: item.time || '已满',
      portrait,
      bg,
      bars,
      stats,
      status,
    };

    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const tplFile = pluginDir + '/resources/Tl/Portrait.html';
    const renderData = { d, qq: displayInfo.qq, qqname: displayInfo.qqname };

    const renderResult = await e.runtime.render('小花火', 'Tl/Portrait', renderData, {
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
    const image = extractRenderBuffer(renderResult);
    return image ? segment.image(image) : null;
  }

  async hideUidIfNeeded(data, qq) {
    const showUid = await getShowUid(qq);
    if (showUid) return;
    const keyMap = ['gs_list', 'sr_list', 'zzz_list'];
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
      if (!san) e.reply('未发现绑定的uid，请[扫码绑定]米游社~');
      return '没有';
    }

    let sk = await getstoken(qq, uid);
    if (!sk) {
      if (!san)
        e.reply('UID:' + uid + '未绑定米游社SToken，请[扫码绑定]米游社~', true);
      return '没有';
    }
    let headers = getHeaders(e, sk, false);
    let url =
      game == 'gs' ? this.gsUrl : game == 'sr' ? this.srUrl : this.zzzUrl;
    // ZZZ API 需要特定 game_biz header
    if (game === 'zzz') {
      headers['x-rpc-game_biz'] = 'nap_cn';
      headers['x-rpc-signgame'] = 'zzz';
    }
    let res = await fetch(url, {
      method: 'get',
      headers,
    }).then(res => res.json());
    if ([-10001, 10001, -100].includes(res?.retcode)) {
      if (!san) {
        e.reply('登录验证过期。请重新：扫码绑定 ');
      }
      return '过期';
    }

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

}
