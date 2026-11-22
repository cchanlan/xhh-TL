import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'resources/help/help.html'),'utf8');
const css=fs.readFileSync(path.join(root,'resources/help/help.css'),'utf8');
const app=fs.readFileSync(path.join(root,'apps/help.js'),'utf8');

test('帮助图内联与外部CSS保持一致，避免缓存路径产生两套视觉',()=>{
  const inline=html.match(/<style id="help-inline">([\s\S]*?)<\/style>/);
  assert.ok(inline);assert.equal(inline[1].trim(),css.trim());
  assert.ok(html.includes('href="{{ppath}}help/help.css"'));
});
test('帮助图采用近白外层、浅蓝灰模块，与已验收手册配色一致',()=>{
  for(const value of ['--page: #f7f9fb','--ink: #142b36','--accent: #124858','--paper: rgba(255,255,255,.98)','--panel: rgba(235,241,247,.92)'])assert.ok(css.includes(value),value);
  assert.match(css,/\.hp-paper\s*\{[^}]*background:\s*var\(--paper\)/);
  assert.match(css,/\.hp-group\s*\{[^}]*background:\s*var\(--panel\)/);
});
test('总览与子帮助都按两列呈现，列内容可以自然缩放换行',()=>{
  assert.match(css,/\.hp-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,1fr\)\)/);
  assert.match(css,/\.hp-module-index \.hp-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,1fr\)\)/);
  assert.ok(html.includes("g.group === '功能模块'"));
});
test('完整遍历原始帮助分组与条目，不在模板截断或重新筛选业务',()=>{
  for(const value of ['{{each groups g}}','{{each g.list item}}','{{g.group}}','{{g.desc}}','{{item.title}}','{{item.desc}}'])assert.ok(html.includes(value),value);
  assert.doesNotMatch(html,/\b(?:groups|g\.list)\.(?:slice|filter|splice)\s*\(/);
});
test('保留单双图标及无图标兜底，资源路径不绑定特定机器',()=>{
  for(const value of ['{{if item.icon2Src}}','{{else if item.iconSrc}}','{{ppath}}{{item.iconSrc}}','{{ppath}}{{item.icon2Src}}','<span class="hp-icon"></span>'])assert.ok(html.includes(value),value);
  assert.doesNotMatch(css+html,/(?:file:\/\/\/root\/|C:\\Users\\|192\.168\.)/);
});
test('保留当前背景素材入口，未安装背景时使用浅色底',()=>{
  assert.ok(html.includes('{{if bgImage}}style="--hp-bg:'));
  assert.ok(css.includes('var(--hp-bg, none) center/cover no-repeat'));
  assert.ok(css.includes('background: var(--page)'));
});
test('完整保留富文本提示、返回总览及帮助失败文字兜底',()=>{
  assert.ok(html.includes('{{if note}}'));assert.ok(html.includes('{{@note}}'));
  assert.ok(html.includes('Xhh-TL · 小火花多功能小插件'));
  assert.ok(app.includes('返回总览'));assert.ok(app.includes('groupsToText(groups)'));
});
test('字体通过资源前缀加载并沿用rem倍率，不缩小指令和说明字号',()=>{
  assert.ok(html.includes("url('{{ppath}}font/NotoSansCJKsc-Regular.ttf')"));
  assert.ok(html.includes('font-size: {{scalePx}}px'));
  assert.match(css,/\.hp-cmd\s*\{[^}]*font-size:\s*15rem/);
  assert.match(css,/\.hp-desc\s*\{[^}]*font-size:\s*13rem/);
  assert.match(css,/\.hp-title\s*\{[^}]*line-height:\s*1\.6/);
});
test('移除暗色光晕、阴影、模糊和文本省略，长指令完整换行',()=>{
  assert.doesNotMatch(css,/box-shadow|backdrop-filter|linear-gradient|radial-gradient|text-overflow|line-clamp|white-space:\s*nowrap/);
  assert.doesNotMatch(html,/class="hp-glow/);
  for(const selector of ['hp-title','hp-cmd','hp-desc','hp-note'])assert.match(css,new RegExp('\\.'+selector+'\\s*\\{[^}]*overflow-wrap:\\s*anywhere'));
});
test('业务安装/启用/加载过滤仍由同一帮助入口处理，主子图共用模板',()=>{
  assert.ok(app.includes('buildHelpIndex(filtered)'));
  assert.ok(app.includes('filterHelpGroups(buildHelpGroups())'));
  assert.ok(app.includes("path.join(pluginDir, 'resources/help/help.html')"));
  assert.ok(app.includes('未启用或未加载'));assert.ok(app.includes('重新开启后需重启'));
  assert.ok(html.includes("subTitle ? 'hp-detail' : 'hp-index'"));
});