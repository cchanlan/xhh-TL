# Xhh-TL (小火花多功能小插件)

> Yunzai Bot 插件 —— 实时体力（原神 / 星铁 / 绝区零 / 鸣潮）、全部深渊汇总、深渊 / 危战配队、幻想剧诗等。

基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 体力模块改造。

## 功能

### 体力查询
- `#体力` / `#tl` 同时查原神 / 星铁 / 绝区零（鸣潮默认不含，见下）；单独查：`#原神体力` `#星铁体力` `#绝区零体力` `#鸣潮体力`
- 支持 @他人、多账号（同 QQ 多 UID 合并出图）
- 三种卡片样式（`tl_card_style`）：`classic` 经典多合一 / `portrait` 立绘卡 / `widget` 桌面小组件卡（含限时活动区块）
- 用户级开关：`#开启/关闭体力uid`、`#开启/关闭原神体力`（星铁 / 绝区零 / 鸣潮同理，控制总览是否包含该游戏）

### 鸣潮体力
自己请求库街区出图，与另外三个游戏同款模板（经典 / 立绘 / 小组件三种样式都支持）。

- `#鸣潮体力` / `#mctl`；纳入 `#体力` 总览需用户自己发 `#开启鸣潮体力`（默认关）
- 卡片内容：结晶波片 + 预计恢复时间、结晶单质、今日活跃度、战歌重奏、逆境深塔、冥歌海墟、终焉矩阵、周度游历、先约电台等级、限时活动
- **凭证不自己管**：只从 gsuid_core 的鸣潮插件（[XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)）数据库里**只读**借用该 QQ 的登录凭证与 UID 绑定，不写库、不锁库、不影响 core 运行
- 前置条件：① 同机跑着 gsuid_core 且装了鸣潮插件；② 该 QQ 已在鸣潮插件那边登录过（如 `w登录`）；③ 锅巴里打开「启用鸣潮体力」（`waves_tl_enable`，默认关）
- 立绘目录 `tl_ww_portrait_folder`：默认 `plugins/xhh-TL/resources/ww_role_pile`（子目录 = 角色 ID，内含图片随机抽取）。**该图库体积过大未随仓库分发**，可自备图库，或直接指向鸣潮插件下载好的官方立绘（平铺目录同样支持）：

```yaml
tl_ww_portrait_folder: /root/gsuid_core/data/XutheringWavesUID/resource/role_pile
```

  目录不存在时立绘位自动回退为插件自带背景图，经典卡样式不受影响。

### 体力阈值推送
- 群内各自设阈值，恢复到阈值以上时 @你 发卡片；原神 / 星铁 / 绝区零分开
- 设置：`#原神体力推送 130`（星铁 `200` / 绝区零 `220`）；全 UID 版加「全」字：`#原神体力全推送 130`
- 关闭：`#原神体力推送关闭`；查看：`#体力推送列表`
- 达阈值后静默，回落再重新监控；默认每 10 分钟检查一次

### 米游社签到
- 手动：`#原神签到` / `#星铁签到` / `#绝区零签到` 立即签一次，多账号自动逐个签
- 自动（opt-in 订阅）：`#原神自动签到` 开启每日自动签，`#原神自动签到关闭` 取消；星铁 / 绝区零同理
- `#签到列表` 查看已订阅的游戏与回报方式（群 @ 或私聊）
- 稳定 device_id + 真 device_fp，触发验证码概率低；撞码时手动指令可内置过码，无需额外装 GT-Manual
- 手动过码：`#米游社验证` / `#过码`（撞验证码后主动清风控）

### 米游币社区任务
与上面的「米游社签到」是两回事：签到领原石走游戏 UID + cookie_token；米游币是在社区做任务（版块签到 + 看帖 + 点赞 + 分享）赚币，走米游社账号 + **stoken**。

- 开启（opt-in 订阅）：`#开启自动米游币`，关闭 `#关闭自动米游币`
- 手动：`#米游币签到` 立即跑一次；`#米游币余额` 只查余额与今日剩余可获取
- `#自动米游币列表` 查看是否已开启
- 覆盖原神 / 星铁 / 绝区零三版块，做满约 +20~22 米游币/账号/天
- ⚠️ 必须有 stoken（`#扫码登录` 才有），普通 CK 做不了
- 同一账号有多份 stoken 时（如 `#扫码登录` 与 gsuid_core 各存一份）会逐个试到能用的那份，不会被过期的那份挡死

### 原神
- `#全部深渊` —— 深境螺旋 + 幽境危战 + 幻想剧诗 三合一
- `#深渊配队` —— 深境螺旋高频双队，绑 CK 按练度排序、灰显未持有
- `#危战配队` —— 幽境危战上 / 中 / 下三关热门队，绑 CK 按练度排序
- `#角色持有率` —— 深渊样本中各角色持有比例，按星级分组
- `#小剧诗` —— 幻想剧诗关键关（3/6/8/10 + 圣牌）个人通关
- `#幻想角色` / `#幻想202607` —— 当期限制元素与可用角色
- 均支持 @他人；配队 / 持有率数据源为 [提瓦特小助手](https://api.yshelper.com)

### 星铁全部深渊（四合一）
- `*全部深渊` —— 混沌回忆、虚构叙事、末日幻影、异相仲裁；上期加「上期」
- 需带 `*` 或「星铁」前缀，避免与原神 `#全部深渊` 冲突

### 版本深渊（Nanoka，查版本非个人）
- 原神：`#版本深渊` `#版本剧诗` `#版本危战`（加「下期」看下期，加「列表」看期数）
- 星铁：`*版本混沌` `*版本虚构` `*版本末日` `*版本异相`

### 帮助
- `#小火花帮助` / `#xhh帮助`

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

依赖：
- **必需**：`miao-plugin`（原版或兼容 fork）
- **绑定数据**：云崽 Cookie/UID 绑定，或 `xiaoyao-cvs-plugin` / `xhh` 扫码 stoken
- **鉴权规则**：检测到云崽 Runtime 时由 Runtime 决定账号是否存活；stoken 文件只能为仍在 Runtime 的账号补全 UID/SToken，不能恢复已删账号。无完整 Runtime 时仍使用 SQLite / stoken 兼容层
- **genshin 插件可选**：无 genshin 时自动启用兼容层，体力 / 深渊 / 剧诗均可独立工作
- **鸣潮体力可选**：需同机的 gsuid_core + 鸣潮插件（只读借凭证）；不装则该功能保持关闭，其余功能不受影响

## 更新

```bash
#体力插件更新        # 或 #体力插件强制更新（放弃本地修改）
```

## 配置

配置分两层，更新插件不覆盖个性化设置：`config/default_config.yaml`（仓库默认）+ `config/config.yaml`（用户配置，本地保留）。首次启动自动生成，新版本只补缺失键。

可编辑 `config/config.yaml` 或在**锅巴**面板配置。常用项：

```yaml
Tl: true                 # 启用体力查询
render_scale: 1.0        # 全局清晰度倍率
show_all_bindings: true  # 多账号合并出图
tl_card_style: portrait  # 卡片样式 classic / portrait / widget

waves_tl_enable: false   # 鸣潮体力总开关（用户还需 #开启鸣潮体力 才进总览）
waves_tl_gsuid_db: ""    # gsuid_core 的 GsData.db 路径，留空自动探测
waves_tl_timeout: 15     # 请求库街区的超时（秒）
tl_ww_portrait_folder: plugins/xhh-TL/resources/ww_role_pile  # 鸣潮立绘目录（需自备）

resin_push_enable: true          # 体力阈值推送总开关
resin_push_cron: "*/10 * * * *"  # 检查频率

auto_sign_enable: true           # 米游社自动签到总开关
auto_sign_cron: "23 0 * * *"     # 每日签到时间；建议 0-6 点随机分钟避开风控高峰
auto_sign_verify_addr: "..."     # 手动撞码时的外部打码服务地址；留空则撞码只提示不过码

bbs_coin_enable: true            # 米游币社区任务总开关（需 stoken）
bbs_coin_cron: "50 0 * * *"      # 每日执行时间；已过 0 点任务刷新，且与自动签到错开
bbs_coin_games: "gs,sr,zzz"      # 做哪些版块：gs=原神 sr=星铁 zzz=绝区零
bbs_coin_gsuid_db: ""            # 可选：gsuid_core 的 GsData.db 路径，留空自动探测

gs_all_abyss: true       # 原神全部深渊
gs_all_abyss_theme: light  # 主题 light / dark
abyss_team: true         # 深渊配队
hard_team: true          # 危战配队
hold_rate: true          # 角色持有率

# 深渊 / 危战 / 配队 / 持有率 / 剧诗共用背景（单图或角色面板目录，留空用默认）
role_combat_bg_folder: plugins/xhh-TL/resources/stat/imgs/bg1.png
```

## 临时文件清理

`data/tmp` 渲染缓存默认每天 4:17 清理超 24 小时的文件。

```yaml
tmp_clean_enable: true
tmp_clean_cron: "17 4 * * *"
tmp_clean_max_age_hours: 24   # 0 = 每次清空
```

主人指令：`#清理临时文件`（加「全部」清空目录）。

## 致谢

本插件站在这些项目肩膀上，若有遗漏欢迎提 issue 补上。

**代码 / 模板 / 资源来源**
- [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) by YUYUYUYU2147 —— 原项目，体力模块与经典卡片模板、体力图标
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) —— 角色数据、渲染框架，立绘卡默认角色图库
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) —— 星铁深渊 API 参考
- [XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID)（[WutheringWavesUID](https://github.com/tyql688/WutheringWavesUID) 的构建版）—— 鸣潮体力接口字段口径与请求头写法参考；结晶波片 / 结晶单质 / 活跃度图标与鸣潮标识取自其资源目录；鸣潮登录凭证也来自它的数据库（只读借用）。其体力卡设计出自 [Wuyi无疑](https://github.com/KimigaiiWuyi)，本插件的鸣潮卡片布局亦受启发
- [gsuid_core](https://github.com/Genshin-bots/gsuid_core)（早柚核心）—— 鸣潮凭证与米游币所需 stoken 的来源库 `GsData.db`（只读打开，不写入）
- [ZZZeroUID](https://github.com/ZZZure/ZZZeroUID) —— 绝区零立绘卡默认角色图
- GT-Manual —— 米游社验证码过码流程参考（已内置等价实现，无需另装）；默认沿用其公益打码服务地址
- [xiaoyao-cvs-plugin](https://github.com/Ctrlcvs/xiaoyao-cvs-plugin) —— CK / stoken 存储路径兼容
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) / [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 宿主框架与渲染链路

**数据接口**
- 米游社 / HoYoLAB 官方接口 —— 实时便笺（体力 widget）、每日签到、米游社社区任务
- [库街区](https://www.kurobbs.com/) 官方接口 —— 鸣潮体力小组件（`widget/game3/getData`）与角色基础数据（`akiBox/baseData`）
- [Nanoka](https://nanoka.cc/) —— 原神 / 星铁版本深渊、剧诗、危战配置
- 提瓦特小助手（`api.yshelper.com`）—— 深渊 / 危战配队与角色持有率统计

以上第三方接口均为其运营方所有，本插件仅做查询与展示；接口变更或下线可能导致对应功能失效。

## License

MIT
