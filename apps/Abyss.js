import plugin from '../../../lib/plugins/plugin.js';
import { allAbyss } from './allAbyssModule.js';
import { miniAllAbyss } from './miniAllAbyss.js';
import { miniChaos } from './miniChaos.js';
import { miniStory } from './miniStory.js';
import { miniBoss } from './miniBoss.js';
import { miniPeak } from './miniPeak.js';

const pluginDir = process.cwd() + '/plugins/xhh-TL';
const configPath = pluginDir + '/config/config.yaml';

import fs from 'fs';
import YAML from 'yaml';

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

try {
  if (fs.existsSync(configPath)) {
    fs.watch(configPath, () => {
      _configCache = readConfig();
      logger.info('[xhh-TL] 配置文件已更新，已重新加载');
    });
  }
} catch (_) {}

export class Abyss extends plugin {
  constructor(e) {
    super({
      name: '[小花火]深渊小组件',
      dsc: '深渊',
      event: 'message',
      priority: config().abyss_priority ?? -98,
      rule: [
        {
          // 星铁全部深渊；原神 #全部深渊 由 gsAllAbyss 处理
          reg: '^(\\*|星铁).*(全部深渊|深渊总览|深渊汇总)|.*(星铁深渊|混沌.*虚构.*末日).*$',
          fnc: 'allAbyss',
        },
        {
          reg: '^#*(\\*|星铁)?小深渊(.*)$',
          fnc: 'miniAllAbyss',
        },
        {
          reg: '^#*(喵喵)?(\\*|星铁)?小(混沌|混沌回忆)(.*)$',
          fnc: 'miniChaos',
        },
        {
          reg: '^#*(喵喵)?(\\*|星铁)?小(虚构|虚构叙事)(.*)$',
          fnc: 'miniStory',
        },
        {
          reg: '^#*(喵喵)?(\\*|星铁)?小(末日|末日幻影)(.*)$',
          fnc: 'miniBoss',
        },
        {
          reg: '^#*(喵喵)?(\\*|星铁)?小(异相|异相仲裁)(.*)$',
          fnc: 'miniPeak',
        },
      ],
    });
  }

  async allAbyss(e) {
    return await allAbyss(e);
  }

  async miniAllAbyss(e) {
    return await miniAllAbyss(e);
  }

  async miniChaos(e) {
    return await miniChaos(e);
  }

  async miniStory(e) {
    return await miniStory(e);
  }

  async miniBoss(e) {
    return await miniBoss(e);
  }

  async miniPeak(e) {
    return await miniPeak(e);
  }
}
