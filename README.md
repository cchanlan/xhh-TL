# xhh-TL · 小火花多功能小插件

> Yunzai-Bot 插件：四游戏实时体力（原神 / 星铁 / 绝区零 / 鸣潮）、体力阈值推送、米游社签到与米游币任务、原神与星铁的深渊成绩汇总、深渊 / 危战配队、幻想剧诗、版本深渊配置。

体力模块基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 改造，其余功能陆续自建。所有出图都走同一套毛玻璃模板，风格统一。

## 功能速览

| 模块 | 代表指令 | 需要 |
| --- | --- | --- |
| 体力查询 | `#体力` `#原神体力` `#鸣潮体力` | CK / stoken（鸣潮借 core） |
| 体力阈值推送 | `#原神体力推送 130` | 同上，且需在群里设 |
| 米游社签到 | `#原神签到` `#原神自动签到` | cookie_token |
| 米游币任务 | `#米游币签到` `#开启自动米游币` | **stoken** |
| 原神成绩 | `#全部深渊` `#小剧诗` | 完整 CK |
| 配队 / 持有率 | `#深渊配队` `#危战配队` `#持有率` | 无 CK 也能出通用榜 |
| 星铁成绩 | `*全部深渊` | 完整 CK |
| 版本配置 | `#版本深渊` `*版本混沌` | 无需绑定 |
| 帮助 | `#小火花帮助` | — |

---

## 体力查询

- 总览：`#体力` / `#tl` / `#体力总览` / `#全体力` / `#四游戏体力` —— 一次查原神 + 星铁 + 绝区零（鸣潮默认不含，见下）
- 单查：`#原神体力`（`#ystl`）、`#星铁体力`（`#xttl` / `*体力`）、`#绝区零体力`（`#zzztl`）、`#鸣潮体力`（`#mctl`）
- 支持 @他人；多账号（同 QQ 多 UID）合并出图，张数超过 `tl_cards_per_msg` 自动转合并转发
- 三种卡片样式（`tl_card_style`）：
  - `classic` 经典多合一卡片
  - `portrait` 大立绘卡（右侧角色立绘 + 进度条 + 状态清单）
  - `widget` 桌面小组件竖卡（仿官方小组件，含限时活动区块）
- 用户级开关（各人各自设，存 redis）：
  - `#开启体力uid` / `#关闭体力uid` —— 卡片是否显示游戏 UID
  - `#开启原神体力` / `#关闭原神体力` —— 控制**总览**是否包含该游戏，星铁 / 绝区零 / 鸣潮同理；单独查询不受影响

数据取米游社「实时便笺」widget 接口（优先 stoken），拿不到时退回 cookie 版 `dailyNote`，字段同名可直接复用。原神卡的限时活动另需完整 CK 拉 `act_calendar`，失败静默隐藏、不影响出图。

### 鸣潮体力

自己请求库街区出图，与另外三个游戏同款模板（经典 / 立绘 / 小组件都支持）。

- 卡片内容：结晶波片 + 预计恢复时间、结晶单质、今日活跃度、战歌重奏剩余次数、逆境深塔、冥歌海墟、终焉矩阵、周度游历、先约电台等级、库街区签到态、限时活动
- **凭证不自己管**：只从 gsuid_core 的鸣潮插件（[XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)）的 `GsData.db` 里**只读**借用该 QQ 的 UID 绑定（`wavesbind`）与登录凭证（`wavesuser`），不写库、不锁库、不影响 core 运行；被 core 标记「无效」的账号自动跳过
- 前置条件：① 同机跑着 gsuid_core 且装了鸣潮插件；② 该 QQ 已在那边登录过（如 `w登录`）；③ 锅巴里打开「启用鸣潮体力」（`waves_tl_enable`，默认关）；④ Node ≥ 22.5（用 `node:sqlite` 只读打开数据库，低版本自动降级为不可用）
- 纳入 `#体力` 总览还需用户自己发 `#开启鸣潮体力`（默认关）。艾特别人查总览时以**发起人**的开关为准，但被艾特者自己关过就尊重他
- 立绘目录 `tl_ww_portrait_folder`：默认 `plugins/xhh-TL/resources/ww_role_pile`（子目录 = 角色 ID，内含图片随机抽取）。**该图库体积过大未随仓库分发**，可自备，或直接指向鸣潮插件下载好的官方立绘（平铺目录同样支持）：

  ```yaml
  tl_ww_portrait_folder: /root/gsuid_core/data/XutheringWavesUID/resource/role_pile
  ```

  目录不存在时立绘位自动回退为插件自带背景图，经典卡不受影响。

---

## 体力阈值推送

群内每人各自设阈值，体力恢复到阈值（含）以上时在该群 @你 并发一张立绘卡。原神 / 星铁 / 绝区零 / 鸣潮各自独立。

```
#原神体力推送 130       原粹树脂 ≥130 提醒（上限 200）
#星铁体力推送 200       开拓力  ≥200 提醒（上限 300）
#绝区零体力推送 220     电量    ≥220 提醒（上限 240）
#开启鸣潮体力推送 200   结晶波片 ≥200 提醒（上限 240）

#原神体力全推送 130     监控名下所有 UID，各自达标各自提醒（星铁/绝区零/鸣潮同理）
#原神体力推送关闭       或 #关闭原神体力推送
#体力推送列表           查看自己的订阅
```

- 「开启 / 打开」前缀可省，关闭词前置后置都认；`鸣潮` 可写 `mc`、`绝区零` 可写 `zzz`
- 达到阈值只 @ 一次，回落到阈值以下自动重新武装，下次满足再提醒
- 主号推送与全推送**互斥**：开一个会自动关掉同游戏的另一个（否则主 UID 会被推两次）
- 开启时先实查一次，查不到就拒绝订阅（避免没绑的号或串号进推送队列）
- 只能在群里设置，只在该群提醒；默认每 10 分钟检查一次（`resin_push_cron`）

---

## 米游社签到

领每日原石 / 星琼 / 菲林，走游戏 UID + cookie_token。

```
#原神签到 / #星铁签到 / #绝区零签到      立即签一次，多账号自动逐个签
#原神自动签到 / #原神自动签到关闭        opt-in 订阅每日自动签（星铁/绝区零同理）
#签到列表                              查看已订阅的游戏与回报方式
#米游社验证 / #过码                     主动清风险分
```

- 星铁可写 `崩铁` / `星穹铁道` / `xt`，原神可写 `ys`
- 稳定 `device_id`（按 UID 派生）+ 请求前 `getFp` 拿真设备指纹，触发验证码概率低
- 撞码时**手动**指令可内置过码（等价 GT-Manual 的流程，装了本插件即可删掉 GT-Manual）；定时自动签无人手划滑块，撞码只跳过并记录
- 签到完成出汇总图，按 `auto_sign_theme` 取主题

---

## 米游币社区任务

与上面的签到是两回事：签到领原石走游戏 UID + cookie_token；米游币是在社区做任务（版块签到 + 看帖 + 点赞 + 分享）赚币，走米游社账号 + **stoken**。

```
#开启自动米游币 / #关闭自动米游币     opt-in 订阅每日自动做任务
#米游币签到                        立即跑一次
#米游币余额                        只查余额与今日剩余可获取
#自动米游币列表                    查看是否已开启
```

- 覆盖原神 / 星铁 / 绝区零三版块（`bbs_coin_games` 可裁剪），做满约 +20~22 米游币 / 账号 / 天
- ⚠️ 必须有 stoken（`#扫码登录` 才有），普通 CK 做不了
- 同一账号有多份 stoken 时（如扫码登录与 gsuid_core 各存一份）会逐个试到能用的那份，不会被过期的那份挡死；优先用 gsuid_core 里那份（带该账号注册过的真实 device_id/fp，更不易风控）
- 按官方日任务上限收敛请求数（约 12~15 次 / 账号），不做无意义的 40+ 次刷帖

---

## 原神 · 成绩汇总

需绑定完整 Cookie；均支持 @他人。

- `#全部深渊` —— 深境螺旋 + 幽境危战 + 小剧诗关键关（3/6/8/10 幕 + 双圣牌）三列合一
- `#小剧诗` / `#小幻想`（加「上期」看上期）—— 幻想真境剧诗关键关个人通关速览
- `#幻想角色` / `#幻想剧诗` —— 当期限制元素、特邀与可用角色；`#下期幻想角色` 看下期，`#幻想202607` / `#幻想2026年7月` 按月回看
- `#深渊配队` / `#深渊组队` / `#深渊配对` —— 12 层满星高频「上半 + 下半」双队，绑 CK 后按本人练度打分排序、灰显未持有
- `#危战配队` / `#幽境危战配队` —— 幽境危战上 / 中 / 下三半区热门完整队，同样按练度排序
- `#角色持有率` / `#持有率` / `#角色拥有率` —— 深渊统计样本中各角色持有比例，按星级分组，绑 CK 后高亮已持有

配队与持有率的数据源是[提瓦特小助手](https://api.yshelper.com)，无 CK 也能出通用榜（只是不含练度）；返回体较大，做 1 小时内存缓存。

---

## 星铁 · 全部深渊（四合一）

- `*全部深渊` / `*深渊总览` / `*深渊汇总` / `#星铁全部深渊` —— 混沌回忆、虚构叙事、末日幻影、异相仲裁一张图
- 加「上期」查上期：`*全部深渊上期` / `*上期全部深渊`
- 必须带 `*` 或「星铁」前缀，避免与原神 `#全部深渊` 冲突；不提供 `*深渊` 这类短指令（防误触）

---

## 版本配置（查版本，不查个人成绩）

无需绑定。原神深渊 / 剧诗与星铁挑战库来自 Nanoka，幽境危战来自 lunaris.moe。

```
原神：#版本深渊  #下期深渊  #版本剧诗  #下期剧诗  #版本危战  #下期危战
星铁：*版本混沌  *版本虚构  *版本末日  *版本异相（各自都有「下期」版本）
期数：指令后接「列表」看最近期数，接「上期」或「第N期」看指定期
```

---

## 管理与运维

- `#小火花帮助` / `#xhh帮助` / `#小火花菜单` —— 指令总览图
- `#清理临时文件`（**主人**，加「全部」清空目录）—— 手动清 `data/tmp` 渲染缓存
- `#删除ck` 钩子 —— 配合 genshin 的删号动作，把被删账号记进本地名单，避免残留 stoken 让该号在体力查询里「复活」。用户重新扫码登录同一个号会自动移出名单（比对 stoken 指纹），无需改 xiaoyao
- `#体力插件更新` / `#小火花更新`（加「强制」放弃本地修改）—— 拉取更新并合并转发更新日志；强制更新也会保留 `config/config.yaml`

---

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

重启 Yunzai 生效。首次启动自动从 `config/default_config.yaml` 生成 `config/config.yaml`。

### 前置与依赖

- **必需**：`miao-plugin`（原版或兼容 fork）—— 角色数据、练度、渲染框架
  - `#全部深渊` 里的幽境危战列需要 miao 带 `HardChallenge` 模型的版本
- **绑定数据**：云崽 Cookie/UID 绑定，或 `xiaoyao-cvs-plugin` / `xhh` 的扫码 stoken
- **鉴权规则**：检测到云崽 Runtime 时由 Runtime 决定账号是否存活；stoken 文件只能为仍在 Runtime 的账号补全 UID/SToken，不能恢复已删账号。无完整 Runtime 时使用内置的 SQLite / stoken 兼容层
- **`genshin` 插件可选**：无 genshin 时自动启用兼容层（`LiteMysApi` + `userBind`），体力 / 深渊 / 剧诗均可独立工作
- **鸣潮体力可选**：需同机的 gsuid_core + 鸣潮插件（只读借凭证）与 Node ≥ 22.5；不装则该功能保持关闭，其余不受影响
- **锅巴可选**：装了 `Guoba-Plugin` 可在面板里图形化配置全部选项

---

## 配置

分两层，更新插件不覆盖个性化设置：`config/default_config.yaml`（仓库默认，随版本更新）+ `config/config.yaml`（用户配置，本地保留）。新版本只补缺失键。

改 `config/config.yaml` 或用**锅巴**面板。常用项：

```yaml
# ===== 体力查询 =====
Tl: true                    # 启用体力查询
render_scale: 1.0           # 全局清晰度倍率（0.8~1.5，最终 scale 上限 2.5）
tl_card_style: classic      # 卡片样式 classic / portrait / widget
show_all_bindings: true     # 多账号合并出图
tl_cards_per_msg: 3         # 超过这个张数改用合并转发
tl_widget_activity: true    # 小组件卡是否显示「限时活动」
tl_widget_activity_limit: 4 # 限时活动最多几条
tl_portrait_folder: plugins/miao-plugin/resources/profile/normal-character  # 原神/星铁立绘目录
tl_zzz_portrait_folder: plugins/xhh-TL/resources/zzzrole                    # 绝区零立绘目录
tl_portrait_bg: plugins/xhh-TL/resources/stat/imgs/bg1.png                  # 立绘卡底图

# ===== 鸣潮体力 =====
waves_tl_enable: false      # 总开关（用户还需 #开启鸣潮体力 才进总览）
waves_tl_gsuid_db: ""       # gsuid_core 的 GsData.db 路径，留空自动探测
waves_tl_timeout: 15        # 请求库街区的超时（秒）
tl_ww_portrait_folder: plugins/xhh-TL/resources/ww_role_pile  # 鸣潮立绘目录（需自备）

# ===== 体力阈值推送 =====
resin_push_enable: true
resin_push_cron: "*/10 * * * *"

# ===== 米游社签到 =====
auto_sign_enable: true
auto_sign_cron: "23 0 * * *"     # 建议 0-6 点随机分钟，避开整点风控高峰
auto_sign_theme: ""              # 汇总图主题，留空跟随全部深渊主题
auto_sign_verify_addr: "..."     # 手动撞码时的外部打码服务；留空则只提示不过码

# ===== 米游币社区任务 =====
bbs_coin_enable: true
bbs_coin_cron: "50 0 * * *"      # 已过 0 点任务刷新，且与自动签到错开
bbs_coin_games: "gs,sr,zzz"      # 做哪些版块
bbs_coin_gsuid_db: ""            # 可选，留空自动探测

# ===== 深渊系 =====
gs_all_abyss: true               # 原神全部深渊
gs_all_abyss_theme: light        # 主题 light / dark
all_abyss: true                  # 星铁全部深渊
abyss_team: true                 # 深渊配队
hard_team: true                  # 危战配队
hold_rate: true                  # 角色持有率
role_combat: true                # 幻想剧诗
# 各模块主题留空则跟随 gs_all_abyss_theme：
abyss_team_theme: ""
hard_team_theme: ""
hold_rate_theme: ""
# 深渊 / 危战 / 配队 / 持有率 / 剧诗共用背景（单图或角色面板目录）
role_combat_bg_folder: plugins/xhh-TL/resources/stat/imgs/bg1.png
help_bg: plugins/xhh-TL/resources/stat/imgs/bg2.png

# ===== 其它 =====
stoken_paths: ""                 # 自定义 SToken/CK 搜索路径（多行），留空用默认
tmp_clean_enable: true           # data/tmp 定时清理
tmp_clean_cron: "17 4 * * *"
tmp_clean_max_age_hours: 24      # 0 = 每次清空
```

各模块还有 `*_priority` 可调匹配优先级，一般不需要动。

---

## 数据与隐私

如实说明本插件会碰到哪些数据，方便自行判断：

- **只读别人的库**：gsuid_core 的 `GsData.db` 以只读模式打开，用来取鸣潮凭证与米游币所需 stoken，不写入、不加锁
- **过码会外发**：`#过码` / 撞码自动过码时，会把 `uid + gt + challenge` 发给 `auto_sign_verify_addr` 指向的第三方打码服务（**不含 cookie**）。真正解验证码的是那个外部服务，本插件不含解题能力；服务下线或限流则过码失效。不想外发就把该项留空
- **凭证不出本机**：CK / stoken 只用于向米游社、库街区官方接口发请求，不上传任何第三方
- **第三方接口**：提瓦特小助手、Nanoka、lunaris.moe 等均为其运营方所有，本插件仅查询与展示；接口变更或下线会导致对应功能失效

---

## 致谢

本插件站在这些项目肩膀上。若有遗漏欢迎提 issue 补上。

### 代码 / 模板 / 资源

- [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147 —— 原项目，体力模块与经典卡片模板、体力图标
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) —— 角色数据与练度模型（`Character` / `Player` / `MysApi` / `HardChallenge`）、渲染框架，立绘卡默认角色图库；`#深渊配队` 的「上半 + 下半」拼队打分算法沿用其实现。同时兼容社区 fork（如 ccxhan 分支）的模型差异
- [xiaoyao-cvs-plugin](https://github.com/Ctrlcvs/xiaoyao-cvs-plugin) —— 米游币社区任务移植来源（本插件修掉了其 `gids`/`forumId` 混用与 DS2 签名体两处问题并收敛请求数）；CK / stoken 存储路径兼容
- [XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)（[WutheringWavesUID](https://github.com/tyql688/WutheringWavesUID) 的构建版）—— 鸣潮体力接口字段口径与请求头写法参考；结晶波片 / 结晶单质 / 活跃度图标与鸣潮标识取自其资源目录；鸣潮登录凭证也来自它的数据库（只读借用）。其体力卡设计出自 [Wuyi无疑](https://github.com/KimigaiiWuyi)，本插件的鸣潮卡片布局亦受启发
- [gsuid_core](https://github.com/Genshin-bots/gsuid_core)（早柚核心）—— 鸣潮凭证与米游币 stoken 的来源库 `GsData.db`；签到的「稳定 device_id + 真 device_fp」做法也参考其思路
- GT-Manual —— 米游社验证码过码流程参考（已内置等价实现，无需另装）；默认沿用其公益打码服务地址
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) —— 星铁深渊 API 参考
- [ZZZeroUID](https://github.com/ZZZure/ZZZeroUID) —— 绝区零立绘卡默认角色图
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) / [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 宿主框架与 puppeteer 渲染链路
- [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 配置面板支持（`guoba.support.js`）

### 数据接口

- 米游社 / HoYoLAB 官方接口 —— 实时便笺（体力 widget）、`dailyNote`、每日签到（`event/luna/*`）、社区任务、深渊 / 危战 / 剧诗战绩
- [库街区](https://www.kurobbs.com/) 官方接口 —— 鸣潮体力小组件（`gamer/widget/game3/getData`）与角色基础数据（`aki/roleBox/akiBox/baseData`）
- 提瓦特小助手（`api.yshelper.com`）—— 深渊 / 幽境危战配队与角色持有率统计（替代已下线的 lelaer 接口）
- [Nanoka](https://nanoka.cc/) —— 原神深境螺旋 / 幻想剧诗、星铁挑战库的版本配置与静态资源
- [lunaris.moe](https://gi.lunaris.moe/leyline) —— 幽境危战版本期数数据与怪物 / 元素静态资源
- [Project Amber](https://gi.yatta.moe/) 与 [Enka.Network](https://enka.network/) —— 版本深渊卡里怪物 / UI 图标的兜底图源

### 运行时依赖（npm）

[node-fetch](https://github.com/node-fetch/node-fetch) · [sharp](https://github.com/lovell/sharp) · [yaml](https://github.com/eemeli/yaml) · [moment](https://github.com/moment/moment) · [lodash](https://github.com/lodash/lodash) · [md5](https://github.com/pvorb/node-md5)

---

## License

MIT
