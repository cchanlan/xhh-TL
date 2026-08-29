# xhh-TL · 小火花多功能小插件

> Yunzai 插件：四游戏实时体力（原神 / 星铁 / 绝区零 / 鸣潮）、体力阈值推送、米游社签到与米游币、
> 原神与星铁的成绩汇总与配队、星铁抽卡记录。出图统一走毛玻璃模板。

体力模块基于 [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) 改造，其余功能自建。

## 功能速览

| 模块 | 代表指令 | 需要 |
| --- | --- | --- |
| 体力查询 | `#体力` `#原神体力` `#鸣潮体力` | CK / stoken（鸣潮借 gsuid_core） |
| 体力推送 | `#原神体力推送 130` | 同上，需在群里设 |
| 米游社签到 | `#原神签到` `#原神自动签到` | cookie_token |
| 米游币任务 | `#米游币签到` `#开启自动米游币` | **stoken** |
| 原神成绩 | `#全部深渊` `#小剧诗` `#幻想角色` | 完整 CK |
| 配队 / 持有率 | `#深渊配队` `#危战配队` `#持有率` | 无 CK 也能出通用榜 |
| 队伍伤害 | `#队伍伤害 钟离,班尼特,香菱,行秋` | miao 面板缓存 |
| 星铁成绩 | `*全部深渊` | 完整 CK |
| 星铁抽卡记录 | `*更新抽卡记录` `*抽卡记录` `*导入记录` | **stoken**，不用抽卡链接 |
| 版本配置 | `#版本深渊` `*版本混沌` | 无需绑定 |
| 帮助 | `#小火花帮助` | — |

## 体力

```
#体力 / #tl                          原神 + 星铁 + 绝区零总览（鸣潮默认不含）
#原神体力 #星铁体力 #绝区零体力 #鸣潮体力    单查，支持 @他人
#开启体力uid / #关闭体力uid              卡片是否显示 UID
#开启原神体力 / #关闭原神体力             控制总览是否含该游戏
#关闭原神123456789                     按 UID 屏蔽某个号（不解绑、不影响推送）
#体力屏蔽列表
```

三种卡片样式（`tl_card_style`）：`classic` 经典多合一 / `portrait` 大立绘 / `widget` 桌面小组件。
多账号合并出图，张数超 `tl_cards_per_msg` 自动转合并转发。数据取米游社实时便笺（优先 stoken）。

**鸣潮**需要同机的 gsuid_core + 鸣潮插件（只读借它的 UID 绑定与登录凭证），并在锅巴打开
`waves_tl_enable`、用户自己发 `#开启鸣潮体力`；Windows 必须手填 `GsData.db` 路径。
立绘图库体积大未随仓库分发，可指向鸣潮插件已下载好的目录。

## 体力推送

群内每人各自设阈值，恢复到阈值以上时在该群 @你并发图。四游戏独立。

```
#原神体力推送 130       上限 200；星铁 300、绝区零 240、鸣潮 240
#原神体力全推送 130     监控名下所有 UID
#原神体力推送关闭
#体力推送列表
```

达标只 @ 一次，回落后自动重新武装；主号推送与全推送互斥；只能在群里设，默认 10 分钟一轮
（`resin_push_cron`）。

## 米游社签到 / 米游币

两回事：签到领原石走游戏 UID + cookie_token；米游币是在社区做任务，走米游社账号 + **stoken**。

```
#原神签到 / #星铁签到 / #绝区零签到     立即签，多账号逐个签
#原神自动签到 / #原神自动签到关闭       订阅每日自动签
#签到列表  #米游社验证 / #过码

#米游币签到  #米游币余额
#开启自动米游币 / #关闭自动米游币  #自动米游币列表
```

签到用稳定 `device_id` + 真设备指纹，撞码概率低；手动指令撞码可内置过码（装了本插件就能删掉
GT-Manual）。米游币覆盖三个版块，做满约 +20~22 币/账号/天。

## 原神

```
#全部深渊              深境螺旋 + 幽境危战 + 小剧诗关键关，三列合一
#小剧诗 / #小幻想       幻想真境剧诗关键关（加「上期」看上期）
#幻想角色 / #幻想剧诗   当期限制元素与可用角色；#下期幻想角色、#幻想202607
#深渊配队 / #危战配队   高频满星队，绑 CK 后按练度排序、灰显未持有
#持有率                深渊样本里各角色持有比例
#队伍伤害 钟离,班尼特,香菱,行秋
```

配队与持有率数据源是[提瓦特小助手](https://api.yshelper.com)，无 CK 也能出通用榜。

**队伍伤害**面板取 miao 的缓存，队里每人都得先 `#更新面板`。队伍后面可接手法
（`班尼特e,希诺宁e,a1,q`，不写角色名沿用上一个），角色名后可接换装（`换六命` `换精5`
`换护摩之杖` `换4千岩` `换天赋101313`）。换装是估算，圣遗物词条沿用原面板。
完整写法见 `#队伍伤害帮助`。小助手只收录了部分套路，功能位太多的队会直接算不了。

## 星铁

```
*全部深渊 / *深渊总览     混沌 + 虚构 + 末日 + 异相一张图（加「上期」）
```

必须带 `*` 或「星铁」前缀，避免与原神 `#全部深渊` 冲突。

## 星铁抽卡记录

```
*更新抽卡记录    从官方小程序同源接口拉五星与垫抽，合并进本地记录后直接出图
*抽卡记录        仿小程序「跃迁记录统计」出图；*武器记录 / *常驻记录 等同理
*全部记录        总览版：每池一块，统计 + 五星头像墙
*导入记录        发完指令再把文件丢过来（三分钟内）
```

直接把**游戏内抽卡链接**发过来也行——那条路能拿到完整逐抽记录，默认增量、加「全量」可强拉。

- 走 stoken 换 `e_hkrpg_token`，**不需要抽卡链接、也不需要 authkey**
- 小程序接口只给五星和垫抽数。为了让总抽数与保底成立，五星之间用三星占位补足
  （每次更新重建，所以幂等）；代价是「未出四星」偏大，四星统计得靠链接或导入
- 真实记录只增不删，按「item_id + id 前 10 位时间戳」判重，反复更新不会重复计数
- 导入支持 SRGF v1.0 / UIGF v4.x / UIGF v2.x / Excel `.xlsx` / csv，认不出结构时会兜底
  在 JSON 里找带 `gacha_type` 的记录数组
- 这几条指令的优先级压在 genshin / xiaoyao-cvs 之前，避免被抢；原神的抽卡链接照旧交回 genshin

## 版本配置（不查个人成绩）

```
#版本深渊 #版本剧诗 #版本危战      原神当期配置，支持「列表 / 上期 / 第N期」
*版本混沌 *版本虚构 *版本末日 *版本异相    星铁挑战库
```

数据来自 [Nanoka](https://nanoka.cc/) 与 [lunaris.moe](https://gi.lunaris.moe/leyline)，无需绑定。

## 安装

在**云崽根目录**执行：

```bash
git clone --depth=1 https://github.com/cchanlan/xhh-TL.git ./plugins/xhh-TL
# 国内直连更快：https://gitcode.com/ccxhan/xhh-TL.git

pnpm install --filter=xhh-TL
# 没用 pnpm 的话：npm install --no-save --prefix ./plugins/xhh-TL
```

重启生效。首次启动会从 `config/default_config.yaml` 生成 `config/config.yaml`。

**必需**：`miao-plugin`（角色数据与渲染框架）。
**可选**：`genshin`（没有则自动走内置兼容层）、`Guoba-Plugin`（图形化配置）、
gsuid_core + 鸣潮插件（鸣潮体力）、Node ≥ 22.5（鸣潮读库更省事）。

## 配置

两层：`config/default_config.yaml`（随版本更新）+ `config/config.yaml`（本地保留），
更新只补缺失键、不覆盖你改过的值。改后者，或直接用**锅巴面板**。常用项：

```yaml
render_scale: 1.0           # 全局出图清晰度倍率（上限 2.5）
tl_card_style: classic      # 体力卡样式 classic / portrait / widget
tl_cards_per_msg: 3         # 超过这个张数改用合并转发
waves_tl_enable: false      # 鸣潮体力总开关
waves_tl_gsuid_db: ""       # GsData.db 路径，Windows 必填
resin_push_cron: "*/10 * * * *"   # 体力推送轮询
auto_sign_cron: "0 30 8 * * *"    # 自动签到时间
team_damage: true           # 队伍伤害（与 FanSky_Qs 同名指令冲突时可关）
```

## 数据与隐私

凭证只从本机既有来源读取（云崽绑定库、`xiaoyao-cvs-plugin` 等的 stoken yaml、gsuid_core 的
`GsData.db` 只读借用），插件自己不落盘任何账号密码，也不外传。抽卡记录写进云崽的
`data/srJson/<QQ>/<UID>/`，与 genshin 共用同一份库。出图缓存在 `temp/`，可用 `#小火花清理缓存` / `#清理缓存` 清掉。

## 致谢

- [xhh](https://github.com/YUYUYUYU2147/xhh/tree/v2) —— 原项目，体力模块与经典卡片模板
- [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin) —— 角色数据、练度模型、渲染框架、立绘图库；配队打分算法
- [xiaoyao-cvs-plugin](https://github.com/Ctrlcvs/xiaoyao-cvs-plugin) —— 米游币任务移植来源，CK / stoken 路径兼容
- [XutheringWavesUID](https://github.com/Loping151/XutheringWavesUID) / [WutheringWavesUID](https://github.com/tyql688/WutheringWavesUID) —— 鸣潮接口口径与图标资源，卡片设计出自 [Wuyi无疑](https://github.com/KimigaiiWuyi)
- [gsuid_core](https://github.com/Genshin-bots/gsuid_core) —— 鸣潮 / 米游币凭证来源库，签到设备指纹思路
- [StarRail-plugin](https://github.com/TsukinaKasumi/StarRail-plugin) —— 星铁深渊 API 参考
- [ZZZeroUID](https://github.com/ZZZure/ZZZeroUID) —— 绝区零立绘
- GT-Manual —— 过码流程参考（已内置等价实现）
- [Yunzai-Bot](https://github.com/yoimiya-kokomi/Yunzai-Bot) / [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) / [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 宿主与配置面板

数据接口：米游社 / HoYoLAB 官方、[库街区](https://www.kurobbs.com/)、提瓦特小助手、
[Nanoka](https://nanoka.cc/)、[lunaris.moe](https://gi.lunaris.moe/leyline)、
[Project Amber](https://gi.yatta.moe/) 与 [Enka.Network](https://enka.network/)（图源兜底）。

## 声明

仅供学习交流，请勿用于商业用途；使用本插件产生的账号风险自负。



