import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const QR = require('qrcode');
import { exec } from 'child_process';
import fetch from 'node-fetch';
import moment from 'moment';
import fs from 'fs';
import md5 from 'md5';
import lodash from 'lodash';
import YAML from 'yaml';
import plugin from '../../../lib/plugins/plugin.js';
import NoteUser from '../../genshin/model/mys/NoteUser.js';
import common from '../../../lib/common/common.js';

// 导入全部深渊功能模块
import { allAbyss } from './allAbyssModule.js';

// ============ 本地配置 ============
const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = pluginDir + '/config/config.yaml';

let _configCache = null;

function readConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return YAML.parse(fs.readFileSync(configPath, 'utf-8')) || {};
    }
  } catch (_) {}
  return {};
}

function config() {
  if (!_configCache) _configCache = readConfig();
  return _configCache;
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

// 读取 stoken 文件
function readYaml(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {};
    }
  } catch (_) {}
  return {};
}

async function getstoken(qq, uid) {
  const path1 = `./plugins/xhh/data/Stoken/${qq}.yaml`;
  const path2 = `./plugins/xiaoyao-cvs-plugin/data/yaml/${qq}.yaml`;

  // 辅助函数：从 stoken 数据中查找
  const findInData = (data) => {
    if (!data) return false;
    // 先精确匹配 uid
    if (data[uid]) return data[uid];
    // 如果找不到，尝试用任意条目（同一米游社账号的 stoken 通用）
    for (const key of Object.keys(data)) {
      if (data[key]?.ck_stoken || data[key]?.stoken) {
        return data[key];
      }
    }
    return false;
  };

  let data;
  if (fs.existsSync(path1)) {
    data = readYaml(path1);
    const entry = findInData(data);
    if (!entry) return false;
    return entry.ck_stoken || `stuid=${entry.stuid};stoken=${entry.stoken};mid=${entry.mid};`;
  } else if (fs.existsSync(path2)) {
    data = readYaml(path2);
    const entry = findInData(data);
    if (!entry) return false;
    return `stuid=${entry.stuid};stoken=${entry.stoken};mid=${entry.mid};`;
  }
  return false;
}

// ============ API 函数 (简化自 xhh/system/api.js) ============
async function callApi(e, type, game, uid, server, headers, silent = false) {
  const signActId = {
    gs: 'e202311201442471',
    sr: 'e202304121516551',
    zzz: 'e202406242138391',
    bh3: 'e202306201626331',
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
    bh3_index: {
      url: `https://api-takumi-record.mihoyo.com/game_record/appv2/honkai3rd/api/index?role_id=${uid}&server=${server}`,
      method: 'GET',
    },
    bh3_note: {
      url: `https://api-takumi-record.mihoyo.com/game_record/app/honkai3rd/api/note?role_id=${uid}&server=${server}`,
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

  // 崩3 API 使用 4x salt DS
  if (type && (type.startsWith('bh3_'))) {
    const urlStr = apiItem.url;
    const queryString = urlStr.includes('?') ? urlStr.split('?')[1] : '';
    fetchHeaders.DS = getDs2(queryString, '', '4');
    fetchHeaders['x-rpc-client_type'] = '5';
    fetchHeaders['x-rpc-app_version'] = '2.73.1';
    fetchHeaders.Referer = 'https://webstatic.mihoyo.com/';
    fetchHeaders['User-Agent'] = 'Mozilla/5.0 (Linux; Android 12; XQ-AT52 Build/58.2.A.7.93; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1';
    delete fetchHeaders.Origin;
    delete fetchHeaders['X-Requested-With'];
    delete fetchHeaders['x-rpc-sys_version'];
    delete fetchHeaders['x-rpc-device_id'];
    delete fetchHeaders['x-rpc-device_name'];
    delete fetchHeaders['x-rpc-device_model'];
    delete fetchHeaders['x-rpc-channel'];
    delete fetchHeaders['x-rpc-verify_key'];
    delete fetchHeaders['x-rpc-app_id'];
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
        msg = `${uid ? 'UID:' + uid : ''}该账号没有绑定崩坏3角色，请检查UID是否正确`;
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
function cookiePart(ck = '', key) {
  const m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return m ? m[1] : '';
}

async function ensureCookieToken(e, ck, entry = null) {
  if (!ck || /(?:^|;\s*)cookie_token=/.test(ck)) return ck;
  const stuid = entry?.stuid || cookiePart(ck, 'stuid') || cookiePart(ck, 'ltuid');
  const stoken = entry?.stoken || cookiePart(ck, 'stoken');
  if (!stuid || !stoken) return ck;
  try {
    const headers = getHeaders(e, ck);
    const cookieRes = await fetch(`https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`, { method: 'GET', headers }).then(r => r.json());
    const ltokenRes = await fetch('https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken', { method: 'GET', headers }).then(r => r.json());
    const cookieToken = cookieRes?.data?.cookie_token;
    const ltoken = ltokenRes?.data?.ltoken || entry?.ltoken;
    if (cookieToken && ltoken) return `ltoken=${ltoken};ltuid=${stuid};cookie_token=${cookieToken};account_id=${stuid};`;
    if (cookieToken) return `stuid=${stuid};stoken=${stoken};cookie_token=${cookieToken};account_id=${stuid};`;
  } catch (err) {
    logger.debug?.(`[xhh-TL][bh3] refresh cookie_token failed: ${err.message}`);
  }
  return ck;
}

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
          reg: '^(#|\\*|%)*(全体力|四游戏体力|米游社体力|体力总览|体力|tl|(原神|ys)(体力|tl)|(星铁|xt|\\*)(体力|tl)|(绝区零|zzz)(体力|tl)|(崩三|崩坏3|崩坏三|BH3|bh3|bbb|3b)(体力|tl))$',
          fnc: 'note_',
        },
        {
          reg: '^#*(崩三|崩坏3|崩坏三|BH3|bh3|bbb|3b)(扫码|绑定|扫码绑定|扫码登录|扫码登陆)$',
          fnc: 'bh3ScanBind',
        },
        {
          reg: '^#*(体力插件|小花火体力)(强制)*更新$',
          fnc: 'updatePlugin',
        },
        {
          reg: '^.*?(全部深渊|深渊总览|深渊汇总|星铁深渊|混沌.*虚构.*末日).*$',
          fnc: 'allAbyss',
        },
        {
          reg: '^#*(开启|打开)体力uid$',
          fnc: 'toggleUidDisplay',
        },
        {
          reg: '^#*(关闭|关掉)体力uid$',
          fnc: 'toggleUidDisplay',
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
    const isQueryAll = ['体力', '全体力', '四游戏体力', '米游社体力', '体力总览', 'tl'].includes(rawMsg);
    logger.info(`[xhh-TL][note_] rawMsg: ${rawMsg}, isQueryAll: ${isQueryAll}`);
    const isStarRail = /星铁|xt|^\*/.test(rawMsg) || e.msg.includes('*体力') || e.msg.includes('*tl');
    const isZZZ = /绝区零|zzz/i.test(rawMsg);
    const isBH3 = /崩三|崩坏3|崩坏三|BH3|bh3|bbb|3b/i.test(rawMsg);
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

    if (isQueryAll) {
      hasAllData = true;
      logger.info('[xhh-TL][note_] 开始查询所有游戏体力');
      const [gsData, srData, zzzData, bh3Data] = await Promise.all([
        this.note(e, 'gs', true, targetQq),
        this.note(e, 'sr', true, targetQq),
        getZZZData(),
        this.bh3Note(e, true, targetQq),
      ]);
      resultData = {
        gs_data: gsData,
        sr_data: srData,
        zzz_data: zzzData,
        bh3_data: bh3Data,
      };
    } else if (isStarRail) {
      resultData = { sr_data: await this.note(e, 'sr', false, targetQq) };
    } else if (isZZZ) {
      resultData = { zzz_data: await getZZZData() };
    } else if (isBH3) {
      resultData = { bh3_data: await this.bh3Note(e, false, targetQq) };
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

    // 多UID模式：一个游戏的所有ID渲染进一张图
    if (config().show_all_bindings) {
      const games = isQueryAll ? ['gs', 'sr', 'zzz', 'bh3']
        : isStarRail ? ['sr']
        : isZZZ ? ['zzz']
        : isBH3 ? ['bh3']
        : isGenshin ? ['gs']
        : ['gs'];

      const allGameData = {};
      let totalUids = 0;
      let gameCount = 0;

      for (const game of games) {
        const dataList = await this.fetchGameDataList(e, game, true, targetQq || e.user_id);
        if (dataList.length === 0) continue;
        allGameData[game] = dataList;
        totalUids += dataList.length;
        gameCount++;
      }

      if (gameCount === 0) {
        e.reply('没有找到有效绑定的账号', true);
        return true;
      }

      const imgQuality = config().img_quality || 80;
      const ppath = '../../../../../plugins/xhh-TL/resources/';
      const tplFile = pluginDir + '/resources/Tl/Tl.html';
      const keyMap = { gs: 'gs_list', sr: 'sr_list', zzz: 'zzz_list', bh3: 'bh3_list' };
      const tlRenderMode = config().tl_render_mode || 'merge';
      const uidsPerImage = config().tl_uids_per_image || 2;
      const cardsPerMsg = config().tl_cards_per_msg || 3;

      // 独立模式：按配置分组渲染
      if (tlRenderMode === 'single') {
        const allGameSegments = [];
        for (const [game, dataList] of Object.entries(allGameData)) {
          // 按 uidsPerImage 分组
          for (let i = 0; i < dataList.length; i += uidsPerImage) {
            const chunk = dataList.slice(i, i + uidsPerImage);
            const chunkData = {
              bg: 'bg1',
              qq: displayQq,
              qqname: displayName,
              time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
            };
            chunkData[keyMap[game]] = chunk;
            await this.hideUidIfNeeded(chunkData, displayQq);

            const segment = await e.runtime.render('小花火', 'Tl/Tl', chunkData, {
              retType: 'base64',
              beforeRender({ data }) {
                return {
                  sys: { scale: `style=transform:scale(${(imgQuality / 100) * 2.5 || 2.0})` },
                  ...chunkData,
                  ppath: ppath,
                  tplFile: tplFile,
                  saveId: 'Tl',
                };
              },
            });
            if (segment) allGameSegments.push(segment);
          }
        }

        // 总卡片数超过阈值 → 全部合并转发
        if (allGameSegments.length > cardsPerMsg) {
          const forwardMsg = await common.makeForwardMsg(e, allGameSegments);
          return e.reply(forwardMsg);
        }
        if (allGameSegments.length === 1) return e.reply(allGameSegments[0]);
        return e.reply(allGameSegments);
      }

      // 默认合并模式：每个游戏的所有UID合并进一张图
      const mergeUidsPerImage = config().tl_merge_uids_per_image || 0;

      // 检查是否需要分组（mergeUidsPerImage > 0 时才分组）
      if (mergeUidsPerImage > 0) {
        const needSplit = Object.values(allGameData).some(list => list.length > mergeUidsPerImage);
        if (needSplit) {
          const allGameSegments = [];
          for (const [game, dataList] of Object.entries(allGameData)) {
            for (let i = 0; i < dataList.length; i += mergeUidsPerImage) {
              const chunk = dataList.slice(i, i + mergeUidsPerImage);
              const chunkData = {
                bg: 'bg1',
                qq: displayQq,
                qqname: displayName,
                time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
              };
              chunkData[keyMap[game]] = chunk;
              await this.hideUidIfNeeded(chunkData, displayQq);

              const segment = await e.runtime.render('小花火', 'Tl/Tl', chunkData, {
                retType: 'base64',
                beforeRender({ data }) {
                  return {
                    sys: { scale: `style=transform:scale(${(imgQuality / 100) * 2.5 || 2.0})` },
                    ...chunkData,
                    ppath: ppath,
                    tplFile: tplFile,
                    saveId: 'Tl',
                  };
                },
              });
              if (segment) allGameSegments.push(segment);
            }
          }
          if (allGameSegments.length === 1) return e.reply(allGameSegments[0]);
          const forwardMsg = await common.makeForwardMsg(e, allGameSegments);
          return e.reply(forwardMsg);
        }
      }

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

        return e.runtime.render('小花火', 'Tl/Tl', combinedData, {
          retType: 'default',
          beforeRender({ data }) {
            return {
              sys: { scale: `style=transform:scale(${(imgQuality / 100) * 2.5 || 2.0})` },
              ...combinedData,
              ppath: ppath,
              tplFile: tplFile,
              saveId: 'Tl',
            };
          },
        });
      }

      // 有游戏存在多个UID → 每个游戏一张图，合并转发
      const allGameSegments = [];
      for (const [game, dataList] of Object.entries(allGameData)) {
        const gameRenderData = {
          bg: 'bg1',
          qq: displayQq,
          qqname: displayName,
          time: `${moment().format('MM-DD HH:mm')} ${this.week[moment().day()]}`,
        };
        gameRenderData[keyMap[game]] = dataList;
        await this.hideUidIfNeeded(gameRenderData, displayQq);

        const segment = await e.runtime.render('小花火', 'Tl/Tl', gameRenderData, {
          retType: 'base64',
          beforeRender({ data }) {
            return {
              sys: { scale: `style=transform:scale(${(imgQuality / 100) * 2.5 || 2.0})` },
              ...gameRenderData,
              ppath: ppath,
              tplFile: tplFile,
              saveId: 'Tl',
            };
          },
        });
        if (segment) allGameSegments.push(segment);
      }

      if (allGameSegments.length > 1) {
        const forwardMsg = await common.makeForwardMsg(e, allGameSegments);
        return e.reply(forwardMsg);
      }
      return e.reply(allGameSegments[0]);
    }

    // 原始单图模式：数据转 _list 格式
    const listData = { ...renderData };
    if (_data_.gs_data) listData.gs_list = [_data_.gs_data];
    if (_data_.sr_data) listData.sr_list = [_data_.sr_data];
    if (_data_.zzz_data) listData.zzz_list = [_data_.zzz_data];
    if (_data_.bh3_data) listData.bh3_list = [_data_.bh3_data];

    const tplFile = pluginDir + '/resources/Tl/Tl.html';
    const ppath = '../../../../../plugins/xhh-TL/resources/';
    const imgQuality = config().img_quality || 80;
    await this.hideUidIfNeeded(listData, displayQq);

    return e.runtime.render('小花火', 'Tl/Tl', listData, {
      retType: 'default',
      beforeRender({ data }) {
        return {
          sys: {
            scale: `style=transform:scale(${(imgQuality / 100) * 2.5 || 2.0})`,
          },
          ...listData,
          ppath: ppath,
          tplFile: tplFile,
          saveId: 'Tl',
        };
      },
    });
  }

  // 获取当前QQ某游戏的所有绑定UID的体力数据
  async fetchGameDataList(e, game, san, qq) {
    const results = [];

    if (game === 'bh3') {
      // BH3 特殊处理：只从 xhh-TL 自己的 stoken 目录获取
      const stokenPaths = [
        `${pluginDir}/data/Stoken/${qq}.yaml`,
      ];
      const bh3Regions = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'];
      const bh3Entries = [];
      const seenBh3Uids = new Set();
      for (const p of stokenPaths) {
        if (!fs.existsSync(p)) continue;
        const stokenData = readYaml(p);
        if (!stokenData) continue;
        for (const [key, entry] of Object.entries(stokenData)) {
          if (!entry || !bh3Regions.includes(entry?.region || '')) continue;
          const uid = String(key);
          if (seenBh3Uids.has(uid)) continue;
          seenBh3Uids.add(uid);
          bh3Entries.push({ uid, ...entry });
        }
      }

      for (const entry of bh3Entries) {
        // CK 由 bh3Note 内部的 getBh3Auth 从 NoteUser 匹配 stuid 获取，不用 entry.ck_stoken
        const data = await this.bh3Note(e, san, qq, entry.uid, entry.region);
        if (data && data !== '没有' && data !== '过期') {
          results.push(data);
        }
      }
      return results;
    }

    // 其他游戏：通过 NoteUser 枚举 UID
    const noteUser = await NoteUser.create(qq);
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
    const cmd = isForce
      ? `git -C ${pluginDir} checkout . && git -C ${pluginDir} pull --no-rebase`
      : `git -C ${pluginDir} pull --no-rebase`;

    e.reply(`开始${isForce ? '强制' : ''}更新 xhh-TL...`, true);

    exec(cmd, { windowsHide: true }, async (error, stdout, stderr) => {
      if (error) {
        logger.error(`[xhh-TL] 更新失败: ${stderr || error.message}`);
        e.reply(`xhh-TL 更新失败: ${stderr || error.message}`, true);
        return;
      }
      if (/Already up|已经是最新/.test(stdout)) {
        e.reply('xhh-TL 已经是最新版本', true);
      } else {
        exec(`git -C ${pluginDir} log -1 --format="%cd" --date=format:"%m-%d %H:%M"`, (err, timeOut) => {
          const time = timeOut?.trim() || '未知';
          e.reply(`xhh-TL 更新成功！\n更新时间: ${time}\n请重启以应用更新`, true);
        });
      }
    });
    return true;
  }

  async toggleUidDisplay(e) {
    const enable = /开启|打开/.test(e.msg);
    await redis.set(`xhh:show_uid:${e.user_id}`, String(enable));
    e.reply(enable ? '已开启体力UID显示' : '已关闭体力UID显示，查询体力时将隐藏UID');
    return true;
  }

  async hideUidIfNeeded(data, qq) {
    const showUid = await getShowUid(qq);
    if (showUid) return;
    const keyMap = ['gs_list', 'sr_list', 'zzz_list', 'bh3_list'];
    for (const key of keyMap) {
      if (data[key]) {
        for (const item of data[key]) {
          if (item && item.uid) item.uid = '****';
        }
      }
    }
  }

  async getBh3Auth(e, targetQq = null) {
    let qq = targetQq || e.user_id;
    if (!targetQq) {
      for (const msg of e.message || []) {
        if (msg.type === 'at') { qq = msg.qq; break; }
      }
    }

    let uid = await redis.get(`xhh:bh3_uid:${qq}`);
    let region = uid ? await redis.get(`xhh:bh3_region:${qq}`) : null;
    let ck = null;
    let signEntry = null;

    // BH3 只从 xhh-TL 自己的 stoken 目录获取
    const stokenPaths = [
      `${pluginDir}/data/Stoken/${qq}.yaml`,
    ];
    let stokenData = null;
    for (const stokenPath of stokenPaths) {
      if (fs.existsSync(stokenPath)) {
        stokenData = readYaml(stokenPath);
        break;
      }
    }

    if (stokenData) {
      if (!uid) {
        const bh3Regions = ['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'];
        for (const key of Object.keys(stokenData)) {
          const entry = stokenData[key];
          if (bh3Regions.includes(entry?.region || '')) {
            uid = key;
            region = entry.region || region;
            break;
          }
        }
      }
      const entry = stokenData[uid];
      if (entry) {
        signEntry = entry;
        region = entry.region || region;
      }
      if (entry?.stuid) {
        try {
          const nu = await NoteUser.create(qq);
          for (const ltuid in nu.mysUsers || {}) {
            if (String(ltuid) === String(entry.stuid)) {
              ck = nu.mysUsers[ltuid].ck;
              break;
            }
          }
        } catch (_) {}
      }
    }

    if (!uid) return { uid: null, region: null, ck: null, signEntry: null };
    if (!region || region === 'cn_gf01') region = 'android01';
    if (!ck) {
      try {
        const nu = await NoteUser.create(qq);
        for (const ltuid in nu.mysUsers || {}) {
          if (nu.mysUsers[ltuid]?.ck) { ck = nu.mysUsers[ltuid].ck; break; }
        }
      } catch (_) {}
    }
    return { uid, region, ck, signEntry };
  }

  // 崩3扫码绑定（移植自 xhh 插件）
  async bh3ScanBind(e) {
    const toDataURL = QR.toDataURL;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // 生成一组固定的 headers，整个扫码流程复用同一 device_id
    const qrHeaders = getHeaders(e);

    // 获取二维码
    let res = await fetch('https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin', {
      method: 'POST',
      headers: qrHeaders,
      body: JSON.stringify({}),
    }).then(r => r.json());

    if (!res?.data?.url) return e.reply('获取二维码失败，请稍后重试', true);

    const ticket = res.data.ticket;
    const img = segment.image((await toDataURL(res.data.url)).replace('data:image/png;base64,', 'base64://'));
    await e.reply(['请在60秒内使用手机米游社扫码绑定崩坏3\n谁触发谁扫码，不要帮别人绑定！', img]);

    await sleep(2000);

    // 轮询扫码状态（复用同一 headers）
    let scanned = false;
    for (let n = 0; n < 150; n++) {
      await sleep(1000);
      res = await fetch('https://passport-api.mihoyo.com/account/ma-cn-passport/app/queryQRLoginStatus', {
        method: 'POST',
        headers: qrHeaders,
        body: JSON.stringify({ ticket }),
      }).then(r => r.json());

      if (res.retcode !== 0) { logger.error(`[xhh-TL][bh3] QR query failed: ${JSON.stringify(res)}`); return e.reply(`二维码状态查询失败: ${res.message || res.retcode}`, true); }
      if (res.data.status === 'Init') continue;
      if (res.data.status === 'Scanned' && !scanned) { scanned = true; e.reply('二维码已扫描，请确认登录~', true); continue; }
      if (res.data.status === 'Scanned') continue;

      if (res.data.status === 'Confirmed') {
        const stoken = (res.data.tokens.find(i => i.name === 'stoken' || i.name === 'stoken_v2') || res.data.tokens[0])?.token;
        const stuid = res.data.user_info.aid || res.data.user_info.uid || res.data.user_info.account_id;
        const mid = res.data.user_info.mid;

        if (!stoken || !stuid) return e.reply('获取登录凭证失败', true);

        // 用 stoken 获取 ltoken 和 cookie_token
        const ck = `stuid=${stuid};stoken=${stoken};mid=${mid};`;
        const headers = getHeaders(e, ck);

        // 获取 ltoken
        let ltoken = '';
        try {
          const ltokenRes = await fetch('https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken', {
            method: 'GET', headers,
          }).then(r => r.json());
          ltoken = ltokenRes?.data?.ltoken || '';
        } catch (_) {}

        // 获取 GameRoles，包含 bh3_cn
        res = await callApi(e, 'GameRoles', null, null, null, headers, true);
        if (!res?.data?.list) return e.reply('获取游戏角色失败', true);

        // 查找所有 BH3 角色（一个米游社号可能有多个渠道服崩3）
        const bh3List = res.data.list.filter(v => v.game_biz === 'bh3_cn');
        if (bh3List.length === 0) return e.reply('该米游社账号下没有崩坏3角色，请确认是否绑定了正确的账号', true);

        const savePath = `${pluginDir}/data/Stoken/${e.user_id}.yaml`;
        let existingData = {};
        if (fs.existsSync(savePath)) existingData = readYaml(savePath);

        const saved = [];
        for (const bh3Entry of bh3List) {
          const bh3Uid = bh3Entry.game_uid;
          const bh3Region = bh3Entry.region;

          // 保存到 Redis（第一个作为默认）
          if (saved.length === 0) {
            await redis.set(`xhh:bh3_uid:${e.user_id}`, bh3Uid);
            await redis.set(`xhh:bh3_region:${e.user_id}`, bh3Region);
          }

          existingData[bh3Uid] = {
            uid: bh3Uid,
            stuid: String(stuid),
            stoken,
            ck_stoken: `stuid=${stuid};stoken=${stoken};mid=${mid};`,
            mid,
            ltoken,
            region_name: bh3Entry.region_name || '崩坏3',
            region: bh3Region,
          };
          saved.push(`${bh3Uid}(${bh3Region})`);
        }
        fs.writeFileSync(savePath, YAML.stringify(existingData), 'utf-8');

        return e.reply(`崩坏3绑定成功！\n${saved.join('\n')}\n现在可以发送 #崩三体力 查询了`);
      }
    }
    return e.reply('扫码超时，请重新操作', true);
  }

  async bh3Note(e, san = true, targetQq = null, forceUid = null, forceRegion = null, forceCk = null) {
    const auth = await this.getBh3Auth(e, targetQq);
    if (forceUid) {
      auth.uid = forceUid;
      if (forceRegion) auth.region = forceRegion;
    }
    if (forceCk) auth.ck = forceCk;
    if (!auth.uid) {
      if (!san) e.reply('请先扫码绑定崩坏3账号');
      return '没有';
    }
    if (!auth.ck) {
      if (!san) e.reply('未找到有效Cookie，请先扫码绑定');
      return '没有';
    }
    const headers = getHeaders(e, auth.ck);
    const signCk = await ensureCookieToken(e, auth.signEntry?.ck_stoken || auth.ck, auth.signEntry);
    const signHeaders = getHeaders(e, signCk);
    let indexRes, noteRes, signRes;
    try {
      [indexRes, noteRes, signRes] = await Promise.all([
        callApi(e, 'bh3_index', 'bh3', auth.uid, auth.region, headers, san),
        callApi(e, 'bh3_note', 'bh3', auth.uid, auth.region, headers, san),
        callApi(e, 'sign_info', 'bh3', auth.uid, auth.region, signHeaders, true).catch(() => null),
      ]);
    } catch (err) {
      logger.error('[xhh-TL][bh3] API error:', err);
      return false;
    }
    if ([-10001, 10001, -100].includes(indexRes?.retcode) || [-10001, 10001, -100].includes(noteRes?.retcode)) {
      if (!san) e.reply('米游社验证已过期。请重新：扫码绑定');
      return '过期';
    }
    // 1008 = 该账号没有崩坏3角色，静默跳过
    if (indexRes?.retcode === 1008 || noteRes?.retcode === 1008) return false;
    if (indexRes?.retcode !== 0 || noteRes?.retcode !== 0) {
      logger.error(`[xhh-TL][bh3] API failed uid=${auth.uid} region=${auth.region}: index=${indexRes?.retcode} note=${noteRes?.retcode}`);
      return false;
    }
    const role = indexRes.data?.role || {};
    const note = noteRes.data || {};
    const level = Number(role.level || 0);
    const ultra = note.ultra_endless || null;
    const greedy = note.greedy_endless || null;
    const isOldAbyss = level > 0 && level <= 80;
    const abyss = isOldAbyss
      ? (greedy || ultra || null)
      : (ultra?.is_open ? ultra : greedy?.is_open ? greedy : ultra || greedy || null);
    const abyssName = isOldAbyss ? '量子流形' : (ultra ? '超弦空间' : greedy ? '量子流形' : '超弦空间');
    return {
      uid: auth.uid,
      level,
      name: role.nickname || '未知舰长',
      current_stamina: note.current_stamina || 0,
      max_stamina: note.max_stamina || 200,
      time: note.stamina_recover_time ? getTime(note.stamina_recover_time) : '已满',
      current_train_score: note.current_train_score || 0,
      max_train_score: note.max_train_score || 500,
      abyss,
      abyss_name: abyssName,
      battle_field: note.battle_field || null,
      god_war: note.god_war || null,
      is_sign: signRes?.data?.is_sign === true,
    };
  }

  // 体力
  async note(e, game = 'gs', san = true, targetQq = null, forceUid = null) {
    const qq = targetQq || e.user_id;
    let uid;
    if (forceUid) {
      uid = forceUid;
    } else if (targetQq) {
      try { uid = (await NoteUser.create(targetQq)).getUid(game); } catch (_) {}
    } else {
      uid = e.user.getUid(game);
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

  // 全部深渊功能：调用 allAbyss 模块
  async allAbyss(e) {
    return await allAbyss(e);
  }
}
