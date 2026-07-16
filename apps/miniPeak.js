/**
 * 小异相：单独查询异相仲裁数据并渲染
 * 使用方法：发送 *小异相 或 *小异相上期
 * 渲染到 jysy/game_peak.html 页面
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import lodash from 'lodash';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'
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

try {
  if (fs.existsSync(configPath)) {
    fs.watch(configPath, () => { _configCache = readConfig(); });
  }
} catch (_) {}

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
    console.error('[xhh-TL][miniPeak] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

function timeCalc(t) {
  if (!t) return '';
  const date = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return `${date} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function matchTrailblazerId(playerAvatarIds, apiId) {
  let id = apiId * 1;
  let baseId = id % 2 === 0 ? id - 1 : id;
  return [baseId, baseId + 1].find(i => playerAvatarIds.includes(i + "")) || apiId;
}

export async function miniPeak(e) {
  try {
    const loaded = await loadMiaoModules();
    if (!loaded || !MysApi || !Common) {
      e.reply('miao-plugin 模块加载失败，请检查插件是否正确安装');
      return false;
    }

    e.isSr = true;
    await prepareMysContext(e, 'sr');
    let mys = await MysApi.init(e, 'all');
    if (!mys || !await mys.checkCk()) {
      e.reply(mys ? `UID: ${mys.uid} Cookie失效，请重新登录或尝试【#刷新ck】` : '请绑定ck后再使用*小异相');
      return false;
    }

    if (!mys.getChallengePeak) {
      mys.getChallengePeak = async function(type = 1) {
        return await this.getData('challengePeak', { schedule_type: type === 2 ? 3 : 1 });
      };
    }
    if (!mys.checkCk) {
      mys.checkCk = async function() {
        try { return !!(this.ck || this.ckInfo?.ck); } catch (_) { return false; }
      };
    }

    const uid = mys.uid;
    const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
    const player = Player.create(e);

    let resRole, record;
    try {
      resRole = await mys.getChallengePeak(type);
      record = resRole?.challenge_peak_records?.[0];
      if (!record?.has_challenge_record) {
        e.reply(`暂未获得${type === 2 ? '上期' : '本期'}异相仲裁数据...`);
        return false;
      }
    } catch (err) {
      logger.error('[xhh-TL][miniPeak] 获取异相仲裁数据失败:', err);
      e.reply('获取异相仲裁数据失败，请稍后重试');
      return false;
    }

    const nickname = resRole?.role?.nickname || uid;
    const recordBrief = resRole?.challenge_peak_best_record_brief || {};
    const bossInfo = record?.boss_info || {};
    const bossRecord = record?.boss_record || {};
    const mobInfos = record?.mob_infos || [];
    const mobRecords = record?.mob_records || [];

    // boss图片路径
    const bossIcon = bossInfo.icon || '';

    // 收集角色ID
    const avatarIds = [];
    const playerAvatarIds = player.getAvatarIds();
    const addAvatarId = (a) => {
      if (!a?.id) return a;
      if (a.id > 8000) a.id = matchTrailblazerId(playerAvatarIds, a.id);
      if (!avatarIds.includes(a.id)) avatarIds.push(a.id);
      const char = Character.get(a.id, true);
      if (char) {
        a.name = a.name || char.name;
        a.abbr = a.abbr || char.abbr;
      }
      return a;
    };

    // 收集boss和mob角色
    lodash.forEach(bossRecord?.avatars, addAvatarId);
    lodash.forEach(mobRecords, mob => lodash.forEach(mob?.avatars, addAvatarId));

    // 刷新角色天赋
    let mysFailed = false;
    try {
      if (!mys.isSelfCookie) {
        mysFailed = true;
      } else {
        const _mys = await MysApi.init(e, 'cookie');
        if (!_mys || !await _mys.checkCk()) {
          mysFailed = true;
        } else {
          await player.refreshProfile(2, true);
        }
      }
      if (!mysFailed) await player.refreshTalent(avatarIds);
    } catch (err) {
      mysFailed = true;
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

    const ppath = '../../../../plugins/xhh-TL/resources/jysy/';
    const iconPath = '../../../../plugins/xhh-TL/resources/jysy/icon/';

    // 支持自定义背景图
    const msg = e.original_msg || e.msg || '';
    const bgMatch = msg.match(/背景[：:]?\s*(.+)/);
    const bgImage = bgMatch ? bgMatch[1].trim() : '';

    // 构建boss头像数据
    const buildAvatarList = (avatars) => {
      if (!avatars) return [];
      return avatars.map(a => {
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

    // 构建mob数据
    const mobs = mobInfos.map((info, idx) => {
      const mobRecord = mobRecords[idx] || {};
      return {
        index: idx + 1,
        name: info.name || `关卡${idx + 1}`,
        icon: info.icon || '',
        round: mobRecord?.round_num || 0,
        stars: mobRecord?.star_num || 0,
        avatars: buildAvatarList(mobRecord?.avatars)
      };
    });

    const renderData = {
      nickname,
      uid,
      bossName: '将杀王棋',
      bossIcon,
      bossStars: bossRecord?.star_num || 0,
      mobStars: recordBrief.mob_stars || 0,
      totalStars: bossRecord?.star_num || 0,
      bossAvatars: buildAvatarList(bossRecord?.avatars),
      bossRound: bossRecord?.round_num || 0,
      mobs,
      iconPath,
      bgImage,
      save_id: uid,
      Array: (num) => num ? Array(num) : [],
      elemIcon: (element) => {
        const elemMap = {
          physical: 'elem-phy', fire: 'elem-fire', ice: 'elm-ice',
          lightning: 'elem-elec', wind: 'elem-wind',
          quantum: 'elem-auantum', imaginary: 'elem-imaginary'
        };
        return elemMap[element] ? `meta-sr/public/icons/${elemMap[element]}.webp` : '';
      }
    };

    const renderMode = config().mini_peak_render_mode || 'desktop';
    const isMobile = renderMode === 'mobile';
    const templateName = 'game_peak';
    const renderScale = getRenderScaleStyle(config(), isMobile ? 1.6 : 2.2);
    const tplFile = pluginDir + '/resources/jysy/game_peak.html';

    try {
      await e.runtime.render('xhh-TL', templateName, renderData, {
        retType: 'default',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            sys: { scale: renderScale },
            ...data,
            ppath,
            tplFile,
            saveId: templateName,
            _miao_path: ppath
          };
        }
      });
    } catch (err) {
      logger.error('[xhh-TL][miniPeak] 渲染异相仲裁失败:', err);
      e.reply('异相仲裁数据渲染失败，请稍后重试');
      return false;
    }

    return true;
  } catch (err) {
    console.error('[xhh-TL][miniPeak] error:', err);
    e.reply('异相仲裁查询出现错误，请稍后重试');
    return false;
  }
}
