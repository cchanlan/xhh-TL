# xhh-TL (小花火体力小组件)

> Yunzai Bot 插件 —— 米游社实时体力查询 支持 / 星穹铁道 / 绝区零 / 崩坏3 四游戏 ；星铁全部深渊四合一渲染 + 星铁独立深渊查询 。

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
- 一次性查询星铁三个深渊模式：混沌回忆、虚构叙事、末日幻影
- 四列并排渲染成一张图，包含角色、光锥、遗器、天赋等详细信息
- 支持上期数据查询：`*全部深渊 上期`
- 

### 原神全部深渊（三合一）
再给我3年

### 星铁独立深渊查询
- **小混沌**：`*小混沌` / `*小混沌上期` — 查询混沌回忆，渲染角色、光锥、遗器
- **小虚构**：`*小虚构` / `*小虚构上期` — 查询虚构叙事，显示积分和星数
- **小末日**：`*小末日` / `*小末日上期` — 查询末日幻影，显示节点分数和星数
- **小异相**：`*小异相` / `*小异相上期` — 查询异相仲裁，显示Boss和关卡详情
- 
- 支持自定义背景图：`*小混沌 背景:图片URL`

## 安装

```bash
cd Yunzai/plugins
git clone https://github.com/cchanlan/xhh-TL.git
cd xhh-TL && npm install --no-save
```

> `--no-save` 不会修改 Yunzai 的 package.json。云崽已内置大部分依赖，通常无需手动安装，仅在插件缺少依赖时执行。

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
img_quality: 80          # 图片渲染质量 (1-100)
tl_priority: -999        # 插件优先级 (数字越小越优先)
show_all_bindings: true  # 多账号模式：同一游戏的多个UID渲染进同一张图

# 体力渲染模式
tl_render_mode: merge    # merge=合并模式 single=独立模式
tl_merge_uids_per_image: 0  # 合并模式：每张图最多渲染几个UID（0=全部）
tl_uids_per_image: 2     # 独立模式：每张图渲染几个UID
tl_cards_per_msg: 3      # 独立模式：一条消息发几张卡片，超过则合并转发

# 全部深渊功能配置
all_abyss: true          # 是否启用全部深渊查询（混沌、虚构、末日三合一）
all_abyss_render_mode: desktop  # 桌面端(1200px)或手机端(480px)
```

## 崩坏3 绑定

崩坏3 CK 独立存储于 `xhh-TL/data/Stoken/`，与其他游戏隔离。

```bash
#崩三扫码绑定      扫码绑定崩坏3（一个米游社号的所有渠道服角色自动识别）
#bbb扫码绑定       同上
```

## 文件说明

- `TL.js` - 主插件文件，包含体力和深渊规则
- `allAbyssModule.js` - 全部深渊功能的核心实现
- `miniChaos.js` - 混沌回忆独立查询模块
- `miniStory.js` - 虚构叙事独立查询模块
- `miniBoss.js` - 末日幻影独立查询模块
- `miniPeak.js` - 异相仲裁独立查询模块
- `config/config.yaml` - 配置文件
- `resources/all-abyss.html` - 全部深渊三合一渲染模板（桌面版）
- `resources/all-abyss-mobile.html` - 全部深渊三合一渲染模板（手机版）
- `resources/Tl/` - 体力渲染模板和资源
- `resources/jysy/` - 独立深渊查询模板和图标资源

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

## License

MIT
