/**
 * 小混沌：单独查询混沌回忆数据并渲染
 * 使用方法：发送 *小混沌 或 *小混沌上期
 * 渲染到 jysy/game_exact.html 页面
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import lodash from 'lodash';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'
// 配置读取
const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = path.join(pluginDir, 'config', 'config.yaml') /* user config */;

let _configCache = null;

function readConfig() {
  return readPluginConfig();
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
    });
  }
} catch (_) {}

// miao-plugin 模块（动态导入）
let MysApi, Player, Character, Common;
let miaoLoaded = false;

async function loadMiaoModules() {
  if (miaoLoaded) return true;
  try {
    const miaoModels = await import('../../miao-plugin/models/index.js');
    const miaoComponents = await import('../../miao-plugin/components/index.js');
    MysApi = miaoModels.MysApi;
    Player = miaoModels.Player;
    Character = miaoModels.Character;
    Common = miaoComponents.Common;
    miaoLoaded = true;
    return true;
  } catch (err) {
    console.error('[xhh-TL][miniChaos] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

// 元素图标映射
function elemIcon(element) {
  const elemMap = {
    physical: 'elem-phy',
    fire: 'elem-fire',
    ice: 'elm-ice',
    lightning: 'elem-elec',
    wind: 'elem-wind',
    quantum: 'elem-auantum',
    imaginary: 'elem-imaginary'
  };
  return elemMap[element] ? `meta-sr/public/icons/${elemMap[element]}.webp` : '';
}

// 时间格式化
function timeCalc(t) {
  if (!t) return '';
  const date = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return `${date} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

// 处理混沌回忆数据
function processChaosData(res, type) {
  if (!res || typeof res !== 'object') return null;

  const toNum = val => Number(val) || 0;
  let floors = Array.isArray(res?.all_floor_detail) ? res.all_floor_detail : [];

  // 过滤楼层
  floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2));

  if (floors.length === 0) return null;

  const normalizeNode = (node) => {
    if (!node) return null;
    const avatars = lodash.map(Array.isArray(node.avatars) ? node.avatars : [], a => {
      if (!a?.id) return a;
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
    return { ...node, avatars, score: node.score || 0, time: timeCalc(node.challenge_time) };
  };

  const group = res?.groups?.[type - 1] || {};

  return {
    group,
    battleNum: res?.battle_num,
    totalStar: toNum(res?.star_num),
    extraStar: toNum(res?.extra_star_num),
    totalScore: res?.score || 0,
    bestFloor: res?.max_floor,
    floors: lodash.map(floors, floor => {
      const node1 = normalizeNode(floor?.node_1);
      const node2 = normalizeNode(floor?.node_2);
      const node3 = normalizeNode(floor?.node_3);
      const isFast = floor?.is_fast;
      const extraStar = toNum(floor?.extra_star_num);
      const score = toNum(node1?.score) + toNum(node2?.score) + toNum(node3?.score);
      const star = toNum(floor?.star_num);
      return {
        ...floor,
        name: floor?.name || '混沌回忆',
        star: Math.max(0, star - extraStar),
        extraStar,
        score,
        roundNum: floor?.round_num,
        isFast,
        node1,
        node2,
        node3
      };
    })
  };
}

// 小混沌主函数
export async function miniChaos(e) {
  try {
    // 加载 miao-plugin 模块
    const loaded = await loadMiaoModules();
    if (!loaded || !MysApi || !Common) {
      e.reply('miao-plugin 模块加载失败，请检查插件是否正确安装');
      return false;
    }

    // 初始化 MysApi
    e.isSr = true;
    await prepareMysContext(e, 'sr');
    let mys = await MysApi.init(e, 'all');
    if (!mys || !await mys.checkCk()) {
      e.reply(mys ? `UID: ${mys.uid} Cookie失效，请重新登录或尝试【#刷新ck】` : '请绑定ck后再使用*小混沌');
      return false;
    }

    // 兼容原版 miao-plugin
    if (!mys.getChallengeChaos) {
      mys.getChallengeChaos = async function(type = 1) {
        return await this.getData('spiralAbyss', { schedule_type: type });
      };
    }
    if (!mys.checkCk) {
      mys.checkCk = async function() {
        try {
          return !!(this.ck || this.ckInfo?.ck);
        } catch (_) {
          return false;
        }
      };
    }

    const uid = mys.uid;
    const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
    const player = Player.create(e);

    // 获取混沌回忆数据
    let chaosRes;
    try {
      chaosRes = await mys.getChallengeChaos(type);
    } catch (err) {
      logger.error('[xhh-TL][miniChaos] 获取混沌回忆数据失败:', err);
      e.reply('获取混沌回忆数据失败，请稍后重试');
      return false;
    }

    // 处理混沌回忆数据
    const chaosData = processChaosData(chaosRes, type);

    if (!chaosData) {
      e.reply(`暂未获得${type === 2 ? '上期' : '本期'}混沌回忆挑战数据...`);
      return false;
    }

    // 获取角色信息
    const avatarIds = [];
    const addAvatarId = (a) => {
      if (!a?.id) return a;
      if (!avatarIds.includes(a.id)) avatarIds.push(a.id);
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    };

    // 收集所有角色ID
    if (chaosData?.floors) {
      lodash.forEach(chaosData.floors, floor => {
        lodash.forEach([floor.node1, floor.node2, floor.node3], node => {
          if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
        });
      });
    }

    // 刷新角色天赋
    try {
      if (!mys.isSelfCookie) {
        const _mys = await MysApi.init(e, 'cookie');
        if (_mys && await _mys.checkCk()) {
          await player.refreshProfile(2, true);
        }
      } else {
        await player.refreshProfile(2, true);
      }
      await player.refreshTalent(avatarIds);
    } catch (err) {
      logger.debug('[xhh-TL][miniChaos] 刷新角色信息失败:', err.message);
    }

    const avatarData = player.getAvatarData(avatarIds);
    lodash.forEach(avatarData, (av) => {
      if (!av?.talent) return;
      av.talentCount = Object.keys(av.talent).length;
      lodash.forEach(av.talent, (t, key) => {
        const talentMaxMap = { a: 7, e: 12, q: 12, t: 12, me: 7, mt: 7, j: 12 };
        t.max = talentMaxMap[key] || 12;
      });
    });

    // 渲染到 jysy/game_exact.html
    const renderMode = config().mini_chaos_render_mode || 'desktop';
    const isMobile = renderMode === 'mobile';
    const templateName = 'game_exact';
    const renderScale = getRenderScaleStyle(config(), isMobile ? 1.6 : 2.2);
    const tplFile = pluginDir + '/resources/jysy/game_exact.html';
    const ppath = '../../../../plugins/xhh-TL/resources/jysy/';

    // 准备第一个楼层的数据
    const firstFloor = chaosData.floors[0] || {};

    // 构建节点头像数据
    const buildNodeAvatars = (node) => {
      if (!node?.avatars) return [];
      return node.avatars.map(a => {
        const av = avatarData[a.id] || {};
        return {
          id: a.id,
          name: a.name || av.abbr || '未知',
          face: av.face ? `${ppath}../${av.face}` : (a.icon || ''),
          rarity: av.star || a.rarity || 5,
          level: av.level || a.level || 80,
          weapon: av.weapon || null,
          artisSet: av.artisSet || null
        };
      });
    };

    // 图标路径
    const iconPath = '../../../../plugins/xhh-TL/resources/jysy/icon/';

    // 支持自定义背景图：*小混沌 背景:xxx
    const msg = e.original_msg || e.msg || '';
    const bgMatch = msg.match(/背景[：:]?\s*(.+)/);
    const bgImage = bgMatch ? bgMatch[1].trim() : '';

    const renderData = {
      floors: chaosData.floors,
      totalStar: chaosData.totalStar || 0,
      battleNum: chaosData.battleNum || 3,
      bestFloor: chaosData.bestFloor || '-',
      roundNum: firstFloor.roundNum || 2,
      starCount: firstFloor.star || 0,
      extraStarCount: firstFloor.extraStar || 0,
      node1Avatars: buildNodeAvatars(firstFloor.node1),
      node2Avatars: buildNodeAvatars(firstFloor.node2),
      node3Avatars: buildNodeAvatars(firstFloor.node3),
      iconPath,
      bgImage,
      save_id: uid,
      uid,
      type,
      Array: (num) => num ? Array(num) : []
    };

    try {
      await e.runtime.render('xhh-TL', templateName, renderData, {
        retType: 'default',
        imgType: 'png',
        beforeRender({ data }) {
          const localPath = ppath;
          return {
            sys: { scale: renderScale },
            ...data,
            ppath,
            tplFile,
            saveId: templateName,
            _miao_path: localPath
          };
        }
      });
    } catch (err) {
      logger.error('[xhh-TL][miniChaos] 渲染混沌回忆失败:', err);
      e.reply('混沌回忆数据渲染失败，请稍后重试');
      return false;
    }

    return true;
  } catch (err) {
    console.error('[xhh-TL][miniChaos] error:', err);
    e.reply('混沌回忆查询出现错误，请稍后重试');
    return false;
  }
}
