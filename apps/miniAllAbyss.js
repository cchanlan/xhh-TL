/**
 * 小深渊：混沌+虚构+末日+异相 田字格
 * 每个模式独立渲染为 PNG Buffer，sharp 合成 2x2 网格
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import lodash from 'lodash';
import sharp from 'sharp';

import { prepareMysContext } from '../utils/runtimePatch.js';
import { readPluginConfig } from '../utils/pluginConfig.js'
import { enhanceRenderImage, extractRenderBuffer } from '../utils/renderImage.js'
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
    console.error('[xhh-TL][miniAllAbyss] 加载 miao-plugin 模块失败:', err);
    return false;
  }
}

function timeCalc(t) {
  if (!t) return '';
  const d = `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  return `${d} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

function processChallengeFirstFloor(res, tag, type) {
  if (!res || typeof res !== 'object') return null;
  const toNum = val => Number(val) || 0;
  let floors = Array.isArray(res?.all_floor_detail) ? res.all_floor_detail : [];

  if (tag === 'chaos') floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2));
  else if (tag === 'story') floors = floors.filter(f => !f?.is_fast && (f?.node_1 || f?.node_2)).slice(0, 4);
  else if (tag === 'boss') floors = floors.filter(f => !f?.is_fast && (f?.node_1?.avatars?.length || f?.node_2?.avatars?.length || f?.node_3?.avatars?.length));

  if (floors.length === 0) return null;

  const normalizeNode = (node) => {
    if (!node) return null;
    const avatars = lodash.map(Array.isArray(node.avatars) ? node.avatars : [], a => {
      if (!a?.id) return a;
      const char = Character.get(a.id, true);
      if (char) { a.name = a.name || char.name; a.abbr = a.abbr || char.abbr; }
      return a;
    });
    return { ...node, avatars, score: node.score || 0, time: timeCalc(node.challenge_time) };
  };

  let group;
  if (tag === 'story') group = res?.groups?.[type - 1];
  else if (tag === 'boss') group = res?.groups?.[0];
  else group = res?.groups?.[type - 1];

  const firstFloor = floors[0];
  const node1 = normalizeNode(firstFloor?.node_1);
  const node2 = normalizeNode(firstFloor?.node_2);
  const node3 = normalizeNode(firstFloor?.node_3);
  const isFast = firstFloor?.is_fast;
  const extraStar = toNum(firstFloor?.extra_star_num);
  const score = isFast ? 0 : toNum(node1?.score) + toNum(node2?.score) + toNum(node3?.score);
  const star = toNum(firstFloor?.star_num);

  return {
    group: group || {},
    battleNum: res?.battle_num,
    totalStar: toNum(res?.star_num),
    extraStar: toNum(res?.extra_star_num),
    bestFloor: res?.max_floor,
    floor: {
      ...firstFloor,
      name: firstFloor?.name || (tag === 'chaos' ? '混沌回忆' : tag === 'story' ? '虚构叙事' : '末日幻影'),
      star: Math.max(0, star - extraStar), extraStar, score,
      roundNum: isFast ? 0 : firstFloor?.round_num, isFast,
      node1, node2, node3
    }
  };
}

function processPeakData(res) {
  if (!res || typeof res !== 'object') return null;
  const record = res?.challenge_peak_records?.[0];
  if (!record?.has_challenge_record) return null;

  const recordBrief = res?.challenge_peak_best_record_brief || {};
  const bossInfo = record?.boss_info || {};
  const bossRecord = record?.boss_record || {};
  const mobInfos = record?.mob_infos || [];
  const mobRecords = record?.mob_records || [];

  const norm = (avatars) => {
    if (!avatars) return [];
    return lodash.map(avatars, a => {
      const char = Character.get(a.id, true);
      if (char) { a.name = a.name || char.name; a.abbr = a.abbr || char.abbr; }
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
    bossAvatars: norm(bossRecord?.avatars),
    mobs: mobInfos.map((info, idx) => {
      const mobRecord = mobRecords[idx] || {};
      return {
        index: idx + 1, name: info.name || `关卡${idx + 1}`, icon: info.icon || '',
        round: mobRecord?.round_num || 0, stars: mobRecord?.star_num || 0,
        avatars: norm(mobRecord?.avatars)
      };
    })
  };
}

function matchTrailblazerId(playerAvatarIds, apiId) {
  let id = apiId * 1;
  let baseId = id % 2 === 0 ? id - 1 : id;
  return [baseId, baseId + 1].find(i => playerAvatarIds.includes(i + "")) || apiId;
}

function buildNodeAvatars(node, ppath, avatarData) {
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
}

function buildAvatarList(avatars, ppath, avatarData) {
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
}

/**
 * 渲染单个迷你模板，返回 PNG Buffer
 */
async function renderMiniToBuffer(e, templateName, renderData, ppath) {
  const tplFile = pluginDir + `/resources/jysy/${templateName}.html`;

  const result = await e.runtime.render('xhh-TL', templateName, renderData, {
    retType: 'base64',
    imgType: 'png',
    beforeRender({ data }) {
      return {
        imgType: 'png',
        sys: { scale: '' },
        ...data,
        ppath,
        tplFile,
        saveId: templateName,
        _miao_path: ppath
      };
    }
  });
  const buffer = extractRenderBuffer(result);
  if (!buffer) logger.warn('[xhh-TL][miniAllAbyss] renderMiniToBuffer: 无法提取图片');
  return buffer;
}

export async function miniAllAbyss(e) {
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
      e.reply(mys ? `UID: ${mys.uid} Cookie失效，请重新登录或尝试【#刷新ck】` : '请绑定ck后再使用*小深渊');
      return false;
    }

    if (!mys.getChallengeChaos) mys.getChallengeChaos = async function(t = 1) { return await this.getData('spiralAbyss', { schedule_type: t }); };
    if (!mys.getChallengeStory) mys.getChallengeStory = async function(t = 1) { return await this.getData('challengeStory', { schedule_type: t }); };
    if (!mys.getChallengeBoss) mys.getChallengeBoss = async function(t = 1) { return await this.getData('challengeBoss', { schedule_type: t }); };
    if (!mys.getChallengePeak) mys.getChallengePeak = async function(t = 1) { return await this.getData('challengePeak', { schedule_type: t === 2 ? 3 : 1 }); };
    if (!mys.checkCk) mys.checkCk = async function() { try { return !!(this.ck || this.ckInfo?.ck); } catch (_) { return false; } };

    const uid = mys.uid;
    const type = /上期/.test(e.original_msg || e.msg || '') ? 2 : 1;
    const player = Player.create(e);

    // 并行获取四类数据
    let chaosRes, storyRes, bossRes, peakRes;
    try {
      [chaosRes, storyRes, bossRes, peakRes] = await Promise.all([
        mys.getChallengeChaos(type),
        mys.getChallengeStory(type),
        mys.getChallengeBoss(type),
        mys.getChallengePeak(type)
      ]);
    } catch (err) {
      logger.error('[xhh-TL][miniAllAbyss] 获取深渊数据失败:', err);
      e.reply('获取深渊数据失败，请稍后重试');
      return false;
    }

    const chaosData = processChallengeFirstFloor(chaosRes, 'chaos', type);
    const storyData = processChallengeFirstFloor(storyRes, 'story', type);
    const bossData = processChallengeFirstFloor(bossRes, 'boss', type);
    const peakData = processPeakData(peakRes);

    if (!chaosData && !storyData && !bossData && !peakData) {
      e.reply(`暂未获得${type === 2 ? '上期' : '本期'}小深渊挑战数据...`);
      return false;
    }

    // 收集角色ID
    const avatarIds = [];
    const playerAvatarIds = player.getAvatarIds();
    const addAvatarId = (a) => {
      if (!a?.id) return a;
      if (a.id > 8000) a.id = matchTrailblazerId(playerAvatarIds, a.id);
      if (!avatarIds.includes(a.id)) avatarIds.push(a.id);
      const char = Character.get(a.id, true);
      if (char) { a.name = a.name || char.name; a.abbr = a.abbr || char.abbr; }
      return a;
    };

    [chaosData, storyData, bossData].forEach(d => {
      if (!d?.floor) return;
      lodash.forEach([d.floor.node1, d.floor.node2, d.floor.node3], n => {
        if (n?.avatars) lodash.forEach(n.avatars, addAvatarId);
      });
    });
    if (peakData) {
      lodash.forEach(peakData.bossAvatars, addAvatarId);
      lodash.forEach(peakData.mobs, m => lodash.forEach(m.avatars, addAvatarId));
    }

    try {
      if (!mys.isSelfCookie) {
        const _mys = await MysApi.init(e, 'cookie');
        if (_mys && await _mys.checkCk()) await player.refreshProfile(2, true);
      } else {
        await player.refreshProfile(2, true);
      }
      await player.refreshTalent(avatarIds);
    } catch (err) {
      logger.debug('[xhh-TL][miniAllAbyss] 刷新角色信息失败:', err.message);
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

    // ========= 分别渲染四张图 =========
    const ppath = '../../../../plugins/xhh-TL/resources/jysy/';
    const iconPath = '../../../../plugins/xhh-TL/resources/jysy/icon/';
    const msg = e.original_msg || e.msg || '';
    const bgMatch = msg.match(/背景[：:]?\s*(.+)/);
    const bgImage = bgMatch ? bgMatch[1].trim() : '';

    const buffers = [];
    const labels = [];

    // 小混沌
    if (chaosData) {
      const f = chaosData.floor;
      const buf = await renderMiniToBuffer(e, 'game_exact', {
        floors: chaosData.floors || [f],
        totalStar: chaosData.totalStar || 0,
        battleNum: chaosData.battleNum || 3,
        bestFloor: chaosData.bestFloor || '-',
        roundNum: f.roundNum || 2,
        starCount: f.star || 0,
        extraStarCount: f.extraStar || 0,
        node1Avatars: buildNodeAvatars(f.node1, ppath, avatarData),
        node2Avatars: buildNodeAvatars(f.node2, ppath, avatarData),
        node3Avatars: buildNodeAvatars(f.node3, ppath, avatarData),
        iconPath, bgImage, save_id: uid, uid, type,
        Array: (n) => n ? Array(n) : []
      }, ppath);
      if (buf) { buffers.push(buf); labels.push('小混沌'); }
    }

    // 小虚构
    if (storyData) {
      const f = storyData.floor;
      const buf = await renderMiniToBuffer(e, 'game_story', {
        floors: storyData.floors || [f],
        totalStar: storyData.totalStar || 0,
        battleNum: storyData.battleNum || 3,
        bestFloor: storyData.bestFloor || '-',
        score: f.score || 0,
        starCount: f.star || 0,
        extraStarCount: f.extraStar || 0,
        node1Avatars: buildNodeAvatars(f.node1, ppath, avatarData),
        node2Avatars: buildNodeAvatars(f.node2, ppath, avatarData),
        node3Avatars: buildNodeAvatars(f.node3, ppath, avatarData),
        iconPath, bgImage, save_id: uid, uid, type,
        Array: (n) => n ? Array(n) : []
      }, ppath);
      if (buf) { buffers.push(buf); labels.push('小虚构'); }
    }

    // 小末日
    if (bossData) {
      const f = bossData.floor;
      const buf = await renderMiniToBuffer(e, 'game_boss', {
        floors: bossData.floors || [f],
        totalStar: bossData.totalStar || 0,
        battleNum: bossData.battleNum || 3,
        bestFloor: bossData.bestFloor || '-',
        floorScore: f.score || 0,
        node1Score: f.node1?.score || 0,
        node2Score: f.node2?.score || 0,
        node3Score: f.node3?.score || 0,
        starCount: f.star || 0,
        extraStarCount: f.extraStar || 0,
        node1Avatars: buildNodeAvatars(f.node1, ppath, avatarData),
        node2Avatars: buildNodeAvatars(f.node2, ppath, avatarData),
        node3Avatars: buildNodeAvatars(f.node3, ppath, avatarData),
        iconPath, bgImage, save_id: uid, uid, type,
        Array: (n) => n ? Array(n) : []
      }, ppath);
      if (buf) { buffers.push(buf); labels.push('小末日'); }
    }

    // 小异相
    if (peakData) {
      const buf = await renderMiniToBuffer(e, 'game_peak', {
        nickname: peakData.nickname, uid,
        bossName: peakData.bossName, bossIcon: peakData.bossIcon,
        bossStars: peakData.bossStars, mobStars: peakData.mobStars,
        totalStars: peakData.totalStars,
        bossAvatars: buildAvatarList(peakData.bossAvatars, ppath, avatarData),
        bossRound: peakData.bossRound,
        mobs: peakData.mobs.map(m => ({
          ...m, avatars: buildAvatarList(m.avatars, ppath, avatarData)
        })),
        iconPath, bgImage, save_id: uid,
        Array: (n) => n ? Array(n) : [],
        elemIcon: (el) => {
          const m = { physical: 'elem-phy', fire: 'elem-fire', ice: 'elm-ice', lightning: 'elem-elec', wind: 'elem-wind', quantum: 'elem-auantum', imaginary: 'elem-imaginary' };
          return m[el] ? `meta-sr/public/icons/${m[el]}.webp` : '';
        }
      }, ppath);
      if (buf) { buffers.push(buf); labels.push('小异相'); }
    }

    if (buffers.length === 0) {
      e.reply('深渊数据渲染失败，请稍后重试');
      return false;
    }

    // 只有一张直接发
    if (buffers.length === 1) {
      return e.reply(segment.image(buffers[0]));
    }

    // ========= 田字格：统一尺寸 + 存临时文件 + puppeteer 截图 =========
    const tmpDir = pluginDir + '/data/tmp';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 用 sharp 统一所有图到相同宽高（等比缩放 + 背景补齐）
    const metas = await Promise.all(buffers.map(b => sharp(b).metadata()));
    const targetW = Math.max(...metas.map(m => m.width || 600));
    const targetH = Math.max(...metas.map(m => m.height || 400));
    const bg = { r: 0, g: 0, b: 0, alpha: 0 };

    const normalized = await Promise.all(buffers.map(async (b) => {
      const resized = await sharp(b)
        .resize({
          width: targetW,
          height: targetH,
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        })
        .png()
        .toBuffer();
      return sharp({
        create: { width: targetW, height: targetH, channels: 4, background: bg },
      })
        .composite([{ input: resized, gravity: 'centre' }])
        .png()
        .toBuffer();
    }));

    const tmpFiles = [];
    for (let i = 0; i < normalized.length; i++) {
      const p = path.join(tmpDir, `mini_abyss_${uid}_${i}.png`);
      fs.writeFileSync(p, normalized[i]);
      tmpFiles.push(p);
    }

    const gridPpath = '../../../../plugins/xhh-TL/resources/';
    const gridTpl = pluginDir + '/resources/grid-abyss.html';

    const gridResult = await e.runtime.render('xhh-TL', 'grid-abyss', {
      img1: tmpFiles[0] || '',
      img2: tmpFiles[1] || '',
      img3: tmpFiles[2] || '',
      img4: tmpFiles[3] || '',
      count: tmpFiles.length,
      uid,
      save_id: uid,
      Array: (n) => n ? Array(n) : []
    }, {
      retType: 'base64',
      imgType: 'png',
      beforeRender({ data }) {
        return {
          imgType: 'png',
          sys: { scale: '' },
          ...data,
          ppath: gridPpath,
          tplFile: gridTpl,
          saveId: 'grid-abyss',
          _miao_path: gridPpath
        };
      }
    });
    const image = await enhanceRenderImage(gridResult, config());

    // 清理临时文件
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }

    if (image) return e.reply(segment.image(image), true);
    return e.reply('小深渊图片渲染失败，请稍后重试', true);

  } catch (err) {
    console.error('[xhh-TL][miniAllAbyss] error:', err);
    e.reply('小深渊查询出现错误，请稍后重试');
    return false;
  }
}
