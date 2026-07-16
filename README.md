# Xhh-TL (小花火多功能小插件)

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
- 图片编码质量由 `img_quality` 控制，实际输出分辨率由 `render_scale` 统一控制；所有模板均使用参与布局的 Chromium `zoom` 渲染

### Nanoka 版本深渊（静态配置，不查个人成绩）
- 数据源：[Nanoka](https://nanoka.cc/) / `static.nanoka.cc`（与 `#幻想剧诗` 同源）
- 渲染：深色门户卡片；怪物图标优先 Nanoka 静态资源，失败回退色块角标
- **通用规则**
  - **正式 / 下期**：指令带「下期」走测试包最新数据；默认走正式服
  - 期数回看：`上期` / `第N期` / `列表`
  - 原神深渊层序、星铁节点均为 **高 → 低**
- **原神**
  - `#版本深渊` / `#版本螺旋` / `#下期深渊` / `#下期螺旋` — 深境螺旋祝福 + **仅 12→11 层**怪物（含 HP）
  - `#版本剧诗` / `#下期剧诗` — 幻想真境剧诗限制元素与关键关 Boss
  - `#版本危战` / `#下期危战` / `#幽境危战` — 幽境危战（leyline）：**无畏 | 绝境** 两列强敌 + 机制
  - `#版本深渊列表` / `#下期深渊列表` / `#版本危战列表` — 最近期数
- **星铁**（前缀 `*` / `星铁` / `#*`，框架会标准化为 `#星铁…`）
  - 期数约定：**最大 id = 下期，第二大 id = 正式**
  - `*版本混沌` / `*下期混沌`（`*版本深渊` / `*版本挑战` 同混沌）— 混沌回忆（maze）  
    - 仅 **12→9 层**；**第 12 层含星启**（普通 20 回合 / 星启 30 回合）  
    - 双波次怪物 + 弱点 + HP
  - `*版本虚构` / `*下期虚构` — 虚构叙事（maze_extra / story）  
    - 仅 **阶段 4（双节点+星启）** 与 **阶段 3**
  - `*版本末日` / `*下期末日` — 末日幻影（maze_boss）  
    - 仅 **阶段 4（双节点+星启）** 与 **阶段 3**
  - `*版本异相` / `*下期异相` — 异相仲裁（maze_peak）  
    - 绝境 / 首领 / 预选关；波次优先 `infinite_list` + InfiniteElite 血量
  - 对应列表：`*版本混沌列表` 等
- **血量**
  - 原神：深渊怪物直接使用 Nanoka `hp`，展示为 `HP x.x万`
  - 星铁：`HPBase × HPModify × HardLevel.HPRatio × Elite/InfiniteElite.HPRatio`；多阶段显示 `HP P1 … / P2 …`

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

> `--no-save` 不会修改 Yunzai 的 package.json。云崽已内置大部分依赖，通常无需手动安装，仅在插件缺少依赖时执行。

依赖：
- **必需**：`miao-plugin`（[原版](https://github.com/yoimiya-kokomi/miao-plugin) 或兼容 fork 均可）
- **绑定数据**（满足其一即可）：
  - 云崽 Cookie / UID 绑定（`data/db`，常见于安装了 genshin 库的环境）
  - `xiaoyao-cvs-plugin` / `xhh` 扫码 stoken（`data/yaml` / `Stoken`）
- **genshin 插件：可选**
  - **有 genshin**：走系统 Runtime / MysInfo（与以前一致）
  - **无 genshin**：本插件自动启用兼容层（`utils/userBind.js` + `runtimePatch.js` + `mysClient.js`），体力 / 深渊 / 剧诗均可独立工作

> 无 genshin 时请确保用户已扫码绑定 stoken，或 `data/db` 中仍有历史 CK 数据。

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

配置分两层，**更新插件不会覆盖你的个性化设置**：

| 文件 | 说明 |
|------|------|
| `config/default_config.yaml` | 仓库默认（随版本更新） |
| `config/config.yaml` | **用户配置**（gitignore，本地保留） |

首次启动会自动从 default 复制生成 `config.yaml`。新版本若增加配置项，会**只补缺失键**，不改你已有的值。

编辑 `config/config.yaml`（或锅巴）：

```yaml
# 体力小组件配置
Tl: true                 # 是否启用体力查询
img_quality: 100         # 图片编码质量 (1-100)，100 为最高质量
render_scale: 1.0        # 全局渲染倍率；1.0=推荐分辨率，1.25/1.5 可输出更清晰的大图
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

# SToken/CK 搜索路径（多行，按优先级）。留空=默认 xhh / 逍遥 / 本插件
# stoken_paths: |
#   plugins/xhh/data/Stoken
#   plugins/xiaoyao-cvs-plugin/data/yaml
#   /data/my-ck
stoken_paths: ""

# 崩三扫码绑定保存目录
bh3_stoken_dir: plugins/xhh-TL/data/Stoken
```

也可在 **锅巴** 中配置：体力、全部深渊、剧诗开关与背景路径、**CK/SToken 路径**。

## 崩坏3 绑定

崩坏3 CK 独立存储于 `xhh-TL/data/Stoken/`，与其他游戏隔离。

```bash
#崩三扫码绑定      扫码绑定崩坏3（一个米游社号的所有渠道服角色自动识别）
#bbb扫码绑定       同上
```

## 文件说明

- `apps/TL.js` - 体力查询
- `utils/userBind.js` - UID/CK 绑定兼容层（不 import genshin）
- `utils/runtimePatch.js` - 无 genshin 时补齐 `e.runtime.getMysInfo`，供 miao MysApi 使用
- `utils/mysClient.js` - 轻量米游社请求客户端（深渊 / 剧诗 API）
- `utils/pluginConfig.js` - 配置读取 + 可自定义 stoken/ck 路径
- `apps/Abyss.js` - 星铁深渊指令入口
- `apps/allAbyssModule.js` - 星铁全部深渊核心
- `apps/miniChaos.js` / `miniStory.js` / `miniBoss.js` / `miniPeak.js` - 星铁独立深渊
- `apps/miniAllAbyss.js` - 星铁小深渊网格
- `apps/role_combat.js` - 幻想真境剧诗可用角色
- `apps/miniRoleCombat.js` - 小剧诗 / 小幻想（个人通关关键关）
- `apps/tmpCleaner.js` - data/tmp 定时清理
- `apps/nanokaAbyss.js` - Nanoka 版本深渊/剧诗/星铁挑战查询
- `apps/gsAllAbyss.js` - 原神全部深渊三合一
- `config/default_config.yaml` - 默认配置（随仓库更新）
- `config/config.yaml` - 用户配置（本地，更新不覆盖）
- `guoba.support.js` - 锅巴配置项
- `resources/Tl/` - 体力模板
- `resources/all-abyss.html` / `all-abyss-mobile.html` - 星铁全部深渊模板
- `resources/jysy/` - 星铁独立深渊模板
- `resources/role_combat/` - 剧诗 / 小剧诗模板
- `resources/gs_all_abyss/` - 原神全部深渊模板

## 临时文件清理

`data/tmp` 用于小深渊田字格等渲染缓存，默认每天 **4:17** 清理超过 **24 小时** 的文件。

```yaml
tmp_clean_enable: true
tmp_clean_cron: "17 4 * * *"
tmp_clean_max_age_hours: 24   # 0 = 每次清空全部
```

主人指令：`#清理临时文件` / `#小花火清理tmp`（加「全部」可清空目录）

## 无 genshin 兼容说明

| 场景 | 行为 |
|------|------|
| 机器安装了 genshin | 优先使用系统 MysInfo / NoteUser；失败时回退到本插件兼容层 |
| 机器未安装 genshin | 自动注入 `getMysInfo` / `getMysApi`，用 SQLite + stoken 解析 UID/CK，并用内置 `mysClient` 请求米游社 |
| 仅有 stoken、没有 cookie_token | 兼容层会尝试用 stoken 换取 cookie_token 后再查深渊/剧诗 |
| 仅查体力 | 仍优先用 stoken 打 widget 接口（与是否有 genshin 无关） |

## 混沌回忆显示所有楼层

本插件在请求星铁混沌/虚构/末日/异相时**已自动带上** `need_all=true`，**无需修改** genshin 的 `apiTool.js`。

实现方式：`prepareMysContext` 后通过内置 `mysClient`（LiteMysApi）发米游社请求，与是否安装 genshin 无关。


## 致谢

- 原项目：[xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) - 星铁深渊 API 参考
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) - 角色数据和渲染框架
- 剧诗静态配置数据：[Nanoka](https://static.nanoka.cc/)

## License

MIT
