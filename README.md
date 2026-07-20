# Xhh-TL (小花火多功能小插件)

> Yunzai Bot 插件 —— 米游社实时体力查询（原神 / 星穹铁道）；星铁全部深渊四合一；原神全部深渊三合一；幻想真境剧诗。

## 来源

本插件基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 项目中的体力模块改造而来。

## 功能

### 帮助
- `#小火花帮助` / `#小花火帮助` / `#xhh帮助` 
- 别名：`#小火花菜单` / `#小花火命令` / `#xhh-TL帮助` 等

### 体力查询
- 支持 `#体力` / `#tl` / `#体力总览` 同时查询原神 / 星铁体力
- 各游戏别名：`#原神体力` / `#ystl` · `#星铁体力` / `#xttl`
- 支持 @他人查询体力
- 支持 `show_all_bindings` 多账号模式：同一 QQ 绑定的多个 UID 渲染进同一张图，多游戏合并转发
- 支持 `#开启体力uid` / `#关闭体力uid` 控制查询体力时是否显示游戏UID（每个用户独立设置）
- 图形化卡片输出，包含体力恢复倒计时、委托派遣、每日实训等信息
- **回复规则**：单图结果引用触发消息；多图合并转发**不引用**；相关「正在…」进度提示约 30 秒后自动撤回

### 体力阈值推送
- 每个用户在**群里**各自设定阈值，体力恢复到阈值（含）以上时，机器人在该群 **@你** 并发送体力立绘卡片
- 原神 / 星铁**分开**：分开指令、分开阈值、分开推送
  - 原神看**原粹树脂**（`current_resin`）：`#原神体力推送 130`
  - 星铁看**开拓力**（`current_stamina`）：`#星铁体力推送 200`
- 关闭：`#原神体力推送关闭` / `#星铁体力推送关闭`
- 查看订阅：`#体力推送列表`
- **只提醒一次**：达到阈值推送后进入静默，体力回落到阈值以下后自动重新监控，下次再满再提醒
- 默认每 10 分钟检查一次（`resin_push_cron` 可调，不建议太频繁以免米游社风控）；订阅存于 `data/resin_push.json`
- 复用体力查询与立绘卡出图，无需额外绑定；开关：`resin_push_enable`（锅巴可配）
- **已删 CK 对账**：在装有 genshin 的环境下，`#删除ck` 只从 Yunzai 绑定库移除账号，却不会清理扫码/逍遥写入的 stoken yaml，导致被删账号残留 stoken 被体力查询「复活」。本插件注册一条低优先级 `#删除ck` 钩子（`apps/delCkHook.js`），在删除前后快照存活账号求差，把被删的 stuid 连同当时 stoken 指纹记入本地名单（`data/deleted_ck.yaml`），体力查询时据此判死；重新扫码登录覆盖 stoken 后指纹变化，自动移出名单并放行（自愈，无需改 genshin / 逍遥）。无 genshin 环境不会触发，零副作用。

### 星铁全部深渊（四合一）
- 支持 `*全部深渊` / `*深渊总览` / `*深渊汇总` / `#星铁全部深渊`（不支持 `*深渊`）
- 一次性查询星铁深渊模式：混沌回忆、虚构叙事、末日幻影、异相仲裁
- 支持上期：`*全部深渊上期` / `*上期全部深渊`
- 指令需带 `*` 或「星铁」前缀，避免与原神 `#全部深渊` 冲突

### 原神全部深渊（三合一）
- 指令：`#全部深渊` 或 `全部深渊`
- 支持 `@某人 #全部深渊`：查询对方数据
- 一张图合并三列（等宽）：
  - **深境螺旋**：默认仅展示 **11–12 层**（不展示 9/10 层）；战绩条金色边框
  - **幽境危战**：Boss、最强一击 / 最高总伤、机制说明、赋光 UP
  - **幻想剧诗关键关**：第 3/6/8/10 幕 + 双圣牌通关队伍；多怪物讨伐优先横向排布
- 三列体力毛玻璃风格；背景与剧诗共用 `role_combat_bg_folder`
- 开关：`gs_all_abyss: true`（锅巴可配）
- **主题**：`gs_all_abyss_theme` — `light` 浅色白玻璃 / `dark` 深色半透明（锅巴「全部深渊主题」）
- 查询时会提示「正在获取…」，约 30 秒后自动撤回；结果图引用触发消息

### 原神幻想真境剧诗
- **可用角色**：`#幻想剧诗` / `#幻想角色` / `#幻想202607` 等 — 当期限制元素、开幕/特邀/可用角色（Nanoka 数据）
- **小剧诗 / 小幻想**：`#小剧诗` / `#小幻想` / `#小剧诗上期` / `#上期小幻想`
  - 个人通关关键关（3/6/8/10 + 圣牌）
  - 支持 @他人（需对方绑定 Cookie）
- 自定义背景：锅巴 `role_combat_bg_folder`
  - 默认：`plugins/xhh-TL/resources/stat/imgs/bg1.png`（插件自带，Win/Linux 通用）
  - 也可填角色面板目录（子文件夹=角色名，随机抽图）
  - 配置为空/路径无效时自动回退默认图
- 清晰度由 `render_scale` 控制（全局倍率微调，推荐 1.0~1.5）

### Nanoka 版本深渊（静态配置，不查个人成绩）
- 数据源：[Nanoka](https://nanoka.cc/) / `static.nanoka.cc`（与 `#幻想剧诗` 同源）
- 渲染：深色门户卡片；怪物图标优先 Nanoka 静态资源，失败回退色块角标
- **通用规则**
  - **正式 / 下期**：指令带「下期」走测试包最新数据；默认走正式服
  - 期数回看：`上期` / `第N期` / `列表`
  - 原神深渊层序、星铁节点均为 **高 → 低**
  - 指令严格整句匹配（可无 `#`，尾部多字不触发）
- **原神**
  - `#版本深渊` / `#版本螺旋` / `#下期深渊` / `#下期螺旋` — 深境螺旋祝福 + 
  - `#版本剧诗` / `#下期剧诗` — 幻想真境剧诗限制元素与关键关 Boss
  - `#版本危战` / `#下期危战` / 
  - `#版本深渊列表` / `#下期深渊列表` / `#版本危战列表` — 最近期数
- **星铁**（前缀 `*` / `星铁` / `#*`，框架会标准化为 `#星铁…`）
  - `*版本混沌` / `*下期混沌`（`*版本深渊` / `*版本挑战` 同混沌）— 混沌回忆（maze）  
  - `*版本虚构` / `*下期虚构` — 虚构叙事（maze_extra / story）  
  - `*版本末日` / `*下期末日` — 末日幻影（maze_boss）  
  - `*版本异相` / `*下期异相` — 异相仲裁（maze_peak）  
    - 绝境 / 首领 / 预选关；波次优先 `infinite_list` + InfiniteElite 血量
  - 对应列表：`*版本混沌列表` 等


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
render_scale: 1.0        # 全局倍率微调；1.0 使用各模板推荐倍率
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
# 默认插件自带图（Win/Linux 通用相对路径）；也可改角色面板目录
role_combat_bg_folder: plugins/xhh-TL/resources/stat/imgs/bg1.png

# 原神全部深渊三合一
gs_all_abyss: true
# 毛玻璃主题：light=浅色白玻璃 / dark=深色半透明（锅巴「全部深渊主题」）
gs_all_abyss_theme: light

# 体力阈值推送（阈值由用户在群里用指令各自设置，存 data/resin_push.json）
resin_push_enable: true          # 是否启用体力阈值推送
resin_push_cron: "*/10 * * * *"  # 检查频率 cron，默认每 10 分钟；不建议太频繁

# SToken/CK 搜索路径（多行，按优先级）。留空=默认 xhh / 逍遥 / 本插件
# stoken_paths: |
#   plugins/xhh/data/Stoken
#   plugins/xiaoyao-cvs-plugin/data/yaml
#   /data/my-ck
stoken_paths: ""
```

> 阈值本身由每个用户在群里用指令各自设置（存于 `data/resin_push.json`），锅巴/配置只控制全局开关与检查频率。

也可在 **锅巴** 中配置：体力、体力阈值推送（开关 + 频率）、全部深渊（含浅色/深色主题）、剧诗开关与背景路径、**CK/SToken 路径**、`render_scale`。

## 文件说明

- `apps/TL.js` - 体力查询
- `apps/resinPush.js` - 体力阈值推送（达阈值在群 @用户 发图，原神/星铁分开）
- `apps/help.js` - `#小火花帮助` 指令总览图
- `apps/delCkHook.js` - `#删除ck` 对账钩子（记录被 genshin 删除的账号，防残留 stoken 复活体力）
- `utils/deletedCk.js` - 已删 CK 本地名单（`data/deleted_ck.yaml`，含 stoken 指纹自愈）
- `utils/userBind.js` - UID/CK 绑定兼容层（不 import genshin）
- `utils/runtimePatch.js` - 无 genshin 时补齐 `e.runtime.getMysInfo`，供 miao MysApi 使用
- `utils/mysClient.js` - 轻量米游社请求客户端（深渊 / 剧诗 API）
- `utils/pluginConfig.js` - 配置读取 + 路径解析（Win/Linux）+ 背景图选取
- `utils/renderImage.js` - 渲染结果 Buffer 提取
- `utils/replyHelper.js` - 统一回复：单图引用、合并转发不引用、「正在…」30 秒撤回
- `apps/Abyss.js` - 星铁全部深渊指令入口
- `apps/allAbyssModule.js` - 星铁全部深渊核心
- `apps/role_combat.js` - 幻想真境剧诗可用角色
- `apps/miniRoleCombat.js` - 小剧诗 / 小幻想（个人通关关键关）
- `apps/tmpCleaner.js` - data/tmp 定时清理
- `apps/nanokaAbyss.js` - Nanoka 版本深渊/剧诗/星铁挑战查询
- `apps/gsAllAbyss.js` - 原神全部深渊三合一
- `config/default_config.yaml` - 默认配置（随仓库更新）
- `config/config.yaml` - 用户配置（本地，更新不覆盖）
- `guoba.support.js` - 锅巴配置项
- `resources/Tl/` - 体力模板
- `resources/help/` - 帮助图模板
- `resources/all-abyss.html` / `all-abyss-mobile.html` - 星铁全部深渊模板（角色/图标素材走 miao-plugin）
- `resources/role_combat/` - 剧诗 / 小剧诗模板
- `resources/gs_all_abyss/` - 原神全部深渊模板
- `resources/nanoka_abyss/` - Nanoka 深渊模板
- `resources/stat/imgs/bg1.png` / `bg2.png` - 默认背景图

## 临时文件清理

`data/tmp` 用于渲染缓存，默认每天 **4:17** 清理超过 **24 小时** 的文件。

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
| 仅查体力 | 优先用 stoken 打 widget 接口；stoken 缺失时回退到 SQLite/redis 绑定里的完整 CK（与深渊同源），尽量做到「能查深渊就能查体力」 |

## 混沌回忆显示所有楼层

本插件在请求星铁混沌/虚构/末日/异相时**已自动带上** `need_all=true`，**无需修改** genshin 的 `apiTool.js`。

实现方式：`prepareMysContext` 后通过内置 `mysClient`（LiteMysApi）发米游社请求，与是否安装 genshin 无关。


## 致谢

- 原项目：[xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) - 星铁深渊 API 参考
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) - 角色数据和渲染框架
- 剧诗静态配置数据：[Nanoka](https://nanoka.cc/)
- 立绘体力模板[xwuid](https://github.com/Loping151/XutheringWavesUID)

## License

MIT
