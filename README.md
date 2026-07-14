# xhh-TL (小花火体力小组件)

> Yunzai Bot 插件 —— 米游社实时体力查询（原神 / 星穹铁道 / 绝区零 / 崩坏3）；星铁全部深渊四合一；原神全部深渊三合一；幻想真境剧诗。

## 来源

本插件基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 项目中的体力模块改造而来。

## 功能

### 体力查询
- 支持 `#体力` / `#tl` / `#体力总览` 同时查询四游戏体力
- 各游戏别名：`#原神体力` / `#ystl` · `#星铁体力` / `#xttl` · `#绝区零体力` / `#zzztl` · `#崩三体力` / `#bbbtl`
- 支持 @他人查询体力
- 支持 `show_all_bindings` 多账号模式：同一 QQ 绑定的多个 UID 渲染进同一张图，多游戏合并转发
- 支持 `#崩三扫码绑定` 独立扫码绑定崩坏3（自动识别所有渠道服角色）
- 支持 `#开启体力uid` / `#关闭体力uid` 控制查询体力时是否显示游戏UID（每个用户独立设置）
- 图形化卡片输出，包含体力恢复倒计时、委托派遣、每日实训等信息

### 星铁全部深渊（四合一）
- 支持 `*深渊` `*小深渊` / `深渊总览` / `深渊汇总` / `星铁深渊` 等指令
- 一次性查询星铁深渊模式：混沌回忆、虚构叙事、末日幻影、异相仲裁
- 支持上期数据查询：`*全部深渊 上期`
- 指令建议带 `*` 或「星铁」，避免与原神 `#全部深渊` 冲突

### 原神全部深渊（三合一）
- 指令：`#全部深渊` / `#全部深渊上期` / `#原神全部深渊` / `#全部深渊 最高层`
- 一张图合并：
  - **深境螺旋**：默认 9–12 层全层（加「最高层」可只显示最高层）；角色天赋 / 武器 / 圣遗物
  - **幽境危战**：队伍、Boss 图、最强一击 / 最高总伤、机制说明全文、赋光 UP
  - **幻想剧诗关键关**：第 3/6/8/10 幕 + 双圣牌通关队伍
- 三列体力毛玻璃风格；背景与剧诗共用 `role_combat_bg_folder`
- 开关：`gs_all_abyss: true`（锅巴可配）

### 星铁独立深渊查询
- **小混沌**：`*小混沌` / `*小混沌上期` — 查询混沌回忆，渲染角色、光锥、遗器
- **小虚构**：`*小虚构` / `*小虚构上期` — 查询虚构叙事，显示积分和星数
- **小末日**：`*小末日` / `*小末日上期` — 查询末日幻影，显示节点分数和星数
- **小异相**：`*小异相` / `*小异相上期` — 查询异相仲裁，显示 Boss 和关卡详情
- 支持自定义背景图：`*小混沌 背景:图片URL`

### 原神幻想真境剧诗
- **可用角色**：`#幻想剧诗` / `#幻想角色` / `#幻想202607` 等 — 当期限制元素、开幕/特邀/可用角色（Nanoka 数据）
- **小剧诗 / 小幻想**：`#小剧诗` / `#小幻想` / `#小剧诗上期` / `#上期小幻想`
  - 个人通关关键关（3/6/8/10 + 圣牌）
  - 角色卡：头像、命座、等级、天赋、武器、圣遗物（与全部深渊同款）
  - 支持 @他人（需对方绑定 Cookie）
- 自定义背景：锅巴配置 `role_combat_bg_folder`（子文件夹名为角色名，随机抽图）
- 渲染精度跟随 `img_quality`；非体力功能已提高渲染 scale 以减轻模糊

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

> `--no-save` 不会修改 Yunzai 的 package.json。云崽已内置大部分依赖，通常无需手动安装，仅在插件缺少依赖时执行。

依赖：`miao-plugin`（角色数据 / MysApi / 面板）、原神 Cookie 绑定。

## 更新

```bash
# 发送指令
#体力插件更新       拉取最新代码
#小花火体力更新      同上
#体力插件强制更新    放弃本地修改强制更新

# 或手动 git pull
cd plugins/xhh-TL && git pull
```

## 配置

编辑 `config/config.yaml`：

```yaml
# 体力小组件配置
Tl: true                 # 是否启用体力查询
img_quality: 100         # 图片渲染质量 (1-100)，也参与 scale 计算
tl_priority: -999        # 插件优先级 (数字越小越优先)
show_all_bindings: true  # 多账号模式：同一游戏的多个UID渲染进同一张图

# 体力渲染模式
tl_render_mode: merge    # merge=合并模式 single=独立模式
tl_merge_uids_per_image: 0  # 合并模式：每张图最多渲染几个UID（0=全部）
tl_uids_per_image: 2     # 独立模式：每张图渲染几个UID
tl_cards_per_msg: 3      # 独立模式：一条消息发几张卡片，超过则合并转发

# 星铁全部深渊
all_abyss: true
all_abyss_render_mode: desktop  # 桌面端或手机端

# 幻想真境剧诗 / 小剧诗 / 原神全部深渊 共用背景
role_combat: true
role_combat_bg_folder: plugins/miao-plugin/resources/profile/normal-character  # 可写绝对路径

# 原神全部深渊三合一
gs_all_abyss: true
```

也可在 **锅巴** 中配置：体力、全部深渊、剧诗开关与背景路径。

## 崩坏3 绑定

崩坏3 CK 独立存储于 `xhh-TL/data/Stoken/`，与其他游戏隔离。

```bash
#崩三扫码绑定      扫码绑定崩坏3（一个米游社号的所有渠道服角色自动识别）
#bbb扫码绑定       同上
```

## 文件说明

- `apps/TL.js` - 体力查询
- `apps/Abyss.js` - 星铁深渊指令入口
- `apps/allAbyssModule.js` - 星铁全部深渊核心
- `apps/miniChaos.js` / `miniStory.js` / `miniBoss.js` / `miniPeak.js` - 星铁独立深渊
- `apps/miniAllAbyss.js` - 星铁小深渊网格
- `apps/role_combat.js` - 幻想真境剧诗可用角色
- `apps/miniRoleCombat.js` - 小剧诗 / 小幻想（个人通关关键关）
- `apps/gsAllAbyss.js` - 原神全部深渊三合一
- `config/config.yaml` - 配置文件
- `guoba.support.js` - 锅巴配置项
- `resources/Tl/` - 体力模板
- `resources/all-abyss.html` / `all-abyss-mobile.html` - 星铁全部深渊模板
- `resources/jysy/` - 星铁独立深渊模板
- `resources/role_combat/` - 剧诗 / 小剧诗模板
- `resources/gs_all_abyss/` - 原神全部深渊模板

## 混沌回忆显示所有楼层

默认情况下，混沌回忆 API 只返回当前期的一层数据。要显示所有楼层（9-12层），需要修改 genshin-plugin（原库） 的 `apiTool.js`：

**文件位置：** `plugins/genshin/model/mys/apiTool.js`

**找到这段代码（约第216行）：**
```javascript
/** 深渊 （混沌回忆） */
spiralAbyss: {
  url: `${hostRecord}game_record/app/hkrpg/api/challenge`,
  query: `role_id=${this.uid}&schedule_type=${data.schedule_type || 1}&server=${this.server}`,
},
```

**修改为：**
```javascript
/** 深渊 （混沌回忆） */
spiralAbyss: {
  url: `${hostRecord}game_record/app/hkrpg/api/challenge`,
  query: `isPrev=&need_all=true&role_id=${this.uid}&schedule_type=${data.schedule_type || 1}&server=${this.server}`,
},
```

添加 `isPrev=&need_all=true` 参数后，API 会返回所有楼层数据。

## 致谢

- 原项目：[xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) - 星铁深渊 API 参考
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) - 角色数据和渲染框架
- 剧诗静态配置数据：[Nanoka](https://static.nanoka.cc/)

## License

MIT
