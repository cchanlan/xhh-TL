/**
 * 全部深渊功能：混沌回忆、虚构叙事、末日幻影三合一渲染
 * 使用方法：发送 *全部深渊 或 深渊总览 等指令
 * 兼容：原版 miao-plugin 和 ccxhan 分支版本
 */

import moment from 'moment';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import lodash from 'lodash';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'
import { replyQuote } from '../utils/replyHelper.js'
// 配置读取
const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = path.join(pluginDir, 'config', 'config.yaml') /* user config */;

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
    console.error('[xhh-TL][allAbyss] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

/**
 * 兼容层：为原版 miao-plugin 补充星铁深渊 API
 * 原版只有 getSpiralAbyss，分支版本有 getChallengeChaos/Story/Boss
 */
function ensureChallengeMethods(mysInstance) {
  if (!mysInstance) return mysInstance;

  // 如果分支版本已有这些方法，直接返回
  if (mysInstance.getChallengeChaos && mysInstance.getChallengeStory && mysInstance.getChallengeBoss && mysInstance.getChallengePeak) {
    return mysInstance;
  }

  // 为原版 miao-plugin 添加兼容方法
  if (!mysInstance.getChallengeChaos) {
    mysInstance.getChallengeChaos = async function(type = 1) {
      return await this.getData('spiralAbyss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeStory) {
    mysInstance.getChallengeStory = async function(type = 1) {
      return await this.getData('challengeStory', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengeBoss) {
    mysInstance.getChallengeBoss = async function(type = 1) {
      return await this.getData('challengeBoss', { schedule_type: type });
    };
  }

  if (!mysInstance.getChallengePeak) {
    mysInstance.getChallengePeak = async function(type = 1) {
      return await this.getData('challengePeak', { schedule_type: type === 2 ? 3 : 1 });
    };
  }

  // 原版 miao-plugin 可能没有 checkCk 方法
  if (!mysInstance.checkCk) {
    mysInstance.checkCk = async function() {
      try {
        return !!(this.ck || this.ckInfo?.ck);
      } catch (_) {
        return false;
      }
    };
  }

  return mysInstance;
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

// 处理深渊数据
function processChallengeData(res, tag, type) {
  if (!res || typeof res !== 'object') return null;

  const isStory = tag === 'story';
  const isBoss = tag === 'boss';
  const toNum = val => Number(val) || 0;

  let floors = Array.isArray(res?.all_floor_detail) ? res.all_floor_detail : [];
  logger.info(`[xhh-TL][allAbyss] ${tag} 原始楼层数据: ${floors.length} 个, 楼层: ${floors.map(f => f?.floor || f?.name || '未知').join(', ')}`);

  // 根据不同类型过滤楼层
  if (tag === 'chaos') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2));
  } else if (tag === 'story') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2)).slice(0, 4);
  } else if (tag === 'boss') {
    floors = floors.filter(f => !f?.is_fast && (f?.node_1?.avatars?.length || f?.node_2?.avatars?.length || f?.node_3?.avatars?.length));
  }

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

  let group;
  if (tag === 'story') {
    group = res?.groups?.[type - 1];
  } else if (tag === 'boss') {
    group = res?.groups?.[0];
  } else {
    group = res?.groups?.[type - 1];
  }

  return {
    group: group || {},
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
      const score = isStory && isFast ? 0 : toNum(node1?.score) + toNum(node2?.score) + toNum(node3?.score);
      const star = toNum(floor?.star_num);
      return {
        ...floor,
        name: floor?.name || (tag === 'chaos' ? '混沌回忆' : tag === 'story' ? '虚构叙事' : '末日幻影'),
        star: Math.max(0, star - extraStar),
        extraStar,
        score,
        roundNum: isStory && isFast ? 0 : floor?.round_num,
        isFast,
        node1,
        node2,
        node3
      };
    })
  };
}

// 处理异相仲裁数据
function processPeakData(res) {
  if (!res || typeof res !== 'object') return null;

  const record = res?.challenge_peak_records?.[0];
  if (!record?.has_challenge_record) return null;

  const recordBrief = res?.challenge_peak_best_record_brief || {};
  const bossInfo = record?.boss_info || {};
  const bossRecord = record?.boss_record || {};
  const mobInfos = record?.mob_infos || [];
  const mobRecords = record?.mob_records || [];

  const normalizeAvatars = (avatars) => {
    if (!avatars) return [];
    return lodash.map(avatars, a => {
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    });
  };

  return {
    nickname: res?.role?.nickname || '',
    bossName: bossInfo.name || '将杀王棋',
    bossIcon: bossInfo.icon || '',
    bossStars: bossRecord?.star_num || 0,
    mobStars: recordBrief.mob_stars || 0,
    totalStars: (bossRecord?.star_num || 0) + (recordBrief.mob_stars || 0),
    bossRound: bossRecord?.round_num || 0,
    bossAvatars: normalizeAvatars(bossRecord?.avatars),
    mobs: mobInfos.map((info, idx) => {
      const mobRecord = mobRecords[idx] || {};
      return {
        index: idx + 1,
        name: info.name || `关卡${idx + 1}`,
        icon: info.icon || '',
        round: mobRecord?.round_num || 0,
        stars: mobRecord?.star_num || 0,
        avatars: normalizeAvatars(mobRecord?.avatars)
      };
    })
  };
}

// 处理开拓者ID兼容
function matchTrailblazerId(playerAvatarIds, apiId) {
  let id = apiId * 1;
  let baseId = id % 2 === 0 ? id - 1 : id;
  return [baseId, baseId + 1].find(i => playerAvatarIds.includes(i + "")) || apiId;
}

// 全部深渊功能：混沌、虚构、末日、异相四合一
export async function allAbyss(e) {
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
        e.reply(mys ? `UID: ${mys.uid} Cookie失效，请重新登录或尝试【#刷新ck】` : '请绑定ck后再使用*全部深渊');
        return false;
      }

      // 兼容原版 miao-plugin（补充星铁深渊 API）
      mys = ensureChallengeMethods(mys);

      const uid = mys.uid;
      const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
      const player = Player.create(e);

      // 从锅巴配置读取渲染模式
      const renderMode = config().all_abyss_render_mode || 'desktop';
      const isMobile = renderMode === 'mobile';
      // 获取背景图路径
      const msg = e.original_msg || e.msg || '';
      const bgImageMatch = msg.match(/背景[：:]?\s*(.+)/);
      const bgImage = bgImageMatch ? bgImageMatch[1].trim() : '';

      // 获取四个深渊模式的数据
      let chaosRes, storyRes, bossRes, peakRes;
      try {
        [chaosRes, storyRes, bossRes, peakRes] = await Promise.all([
          mys.getChallengeChaos(type),
          mys.getChallengeStory(type),
          mys.getChallengeBoss(type),
          mys.getChallengePeak(type)
        ]);
      } catch (err) {
        logger.error('[xhh-TL][allAbyss] 获取深渊数据失败:', err);
        e.reply('获取深渊数据失败，请稍后重试');
        return false;
      }

      // 处理混沌回忆数据
      const chaosData = processChallengeData(chaosRes, 'chaos', type);
      // 处理虚构叙事数据
      const storyData = processChallengeData(storyRes, 'story', type);
      // 处理末日幻影数据
      const bossData = processChallengeData(bossRes, 'boss', type);
      // 处理异相仲裁数据
      const peakData = processPeakData(peakRes);

      // 检查是否有数据
      if (!chaosData && !storyData && !bossData && !peakData) {
        e.reply(`暂未获得${type === 2 ? '上期' : '本期'}深渊挑战数据...`);
        return false;
      }

      // 获取角色信息
      const avatarIds = [];
      const playerAvatarIds = player.getAvatarIds();
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
      const addPeakAvatarId = (a) => {
        if (!a?.id) return a;
        if (a.id > 8000) a.id = matchTrailblazerId(playerAvatarIds, a.id);
        return addAvatarId(a);
      };

      // 收集所有角色ID
      if (chaosData?.floors) {
        lodash.forEach(chaosData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (storyData?.floors) {
        lodash.forEach(storyData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (bossData?.floors) {
        lodash.forEach(bossData.floors, floor => {
          lodash.forEach([floor.node1, floor.node2, floor.node3], node => {
            if (node?.avatars) lodash.forEach(node.avatars, addAvatarId);
          });
        });
      }
      if (peakData) {
        lodash.forEach(peakData.bossAvatars, addPeakAvatarId);
        lodash.forEach(peakData.mobs, mob => lodash.forEach(mob.avatars, addPeakAvatarId));
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
        logger.debug('[xhh-TL][allAbyss] 刷新角色信息失败:', err.message);
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

      // 使用三合一模板渲染
      const templateName = isMobile ? 'all-abyss-mobile' : 'all-abyss';
      const renderScale = getRenderScaleStyle(config(), isMobile ? 2.0 : 1.2);
      const pluginDir = process.cwd() + '/plugins/xhh-TL';
      const tplFile = pluginDir + `/resources/${templateName}.html`;
      const ppath = '../../../../plugins/xhh-TL/resources/';
      const renderData = {
        chaosData,
        storyData,
        bossData,
        peakData,
        avatars: avatarData,
        save_id: uid,
        uid,
        type,
        nickname: player.name || '开拓者',
        mysFailed: false,
        Array: (num) => num ? Array(num) : [],
        elemIcon,
        timeCalc
      };
      try {
        const renderResult = await e.runtime.render('xhh-TL', templateName, renderData, {
          retType: 'base64',
          imgType: 'png',
          beforeRender({ data }) {
            return {
              ...data,
              imgType: 'png',
              sys: { scale: renderScale },
              ppath,
              tplFile,
              saveId: templateName,
            };
          }
        });
        const image = extractRenderBuffer(renderResult);
        if (image) return replyQuote(e, segment.image(image));
        throw new Error('渲染结果中没有图片数据');
      } catch (err) {
        logger.error('[xhh-TL][allAbyss] 渲染三合一深渊失败:', err);
        e.reply('深渊数据渲染失败，请稍后重试');
        return false;
      }

      return true;
    } catch (err) {
      console.error('[xhh-TL][allAbyss] error:', err);
      e.reply('深渊查询出现错误，请稍后重试');
      return false;
    }
}
