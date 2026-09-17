# 米游社极验全自动过码服务

给 `xhh-TL` 插件用的**本地过码服务**：`#过码` 和撞码签到时，它自己解米游社的滑块验证码，
用户不用手划。

实测成功率 **100%**（单轮约 80%，靠多轮重试兜底），单账号 20~70 秒。

> ⚠️ 本服务只监听 `127.0.0.1`，不对外暴露。它需要在本机跑浏览器并模拟真实鼠标操作，
> **只能部署在 Linux 且有桌面环境（X11）的机器上**。Windows / macOS 请继续用手动过码。

## 它到底在做什么

米游社的验证码是**极验 v3 私有部署的滑块**（不是点选九宫格）。流程：

```
① 米游社 createVerification → gt / challenge
② 浏览器加载极验 gt.js，调 inst.verify() 推进到滑块题
③ 抓 canvas 三图（bg / fullbg / slice），差分算出缺口位置
④ 用系统级真实鼠标拖动滑块（不是 CDP 注入，否则被判 bot）
⑤ 极验返回新的 challenge + validate
⑥ 回交米游社 verifyVerfication → 风险清除
```

## 依赖

```bash
# Debian / Ubuntu
apt install -y xdotool xvfb openbox python3-venv

# Python 依赖（缺口识别）
python3 -m venv .venv
.venv/bin/pip install opencv-python-headless numpy
```

- **Node**：用云崽自带的即可（需要 `puppeteer` 与 `node-fetch`）
- **Chromium**：`/usr/bin/chromium`（`start.sh` 里可用 `GT_CHROMIUM` 改）
- **xdotool + openbox**：缺一不可。没有窗口管理器时 X 窗口不映射，鼠标事件送不进浏览器

## 部署

### 方式一：一键部署（推荐）

在群里发（需主人权限）：

```
#过码部署
```

它会自动：拉本分支的 `service/` → 建 venv 装依赖 → pm2 起服务 → 把 `auto_verify_addr`
写进配置 → 验活。装完发 `#过码服务状态` 可以看结果。

**前提**：Linux + 桌面环境，且装好 `xdotool` / `xvfb` / `openbox` / `python3-venv` / `pm2`
（缺了它会告诉你该执行哪条 apt 命令）。

### 方式二：手动部署

1. 拿到本分支的 `service/geetest/`（在插件目录下）：

```bash
cd /root/Yunzai/plugins/xhh-TL
git fetch origin solver
git checkout origin/solver -- service
```

2. 装依赖（见上）。

3. 改 `service/geetest/server.mjs` 顶部两处路径（如果跟默认不一样）：

```js
const PYTHON   = process.env.GT_PYTHON   || '<你的 venv>/bin/python'
const CHROMIUM = process.env.GT_CHROMIUM || '/usr/bin/chromium'
```

4. 用 pm2 托管：

```bash
pm2 start service/geetest/start.sh --name geetest-solver --interpreter bash
pm2 save
```

5. 验证：

```bash
curl http://127.0.0.1:8766/health     # → {"ok":true}
```

6. 在锅巴面板（或 `config/config.yaml`）把 **本地全自动过码地址** 填成
   `http://127.0.0.1:8766/solve`，重启云崽。

## 接口

```
GET  /health          → {"ok":true}
POST /solve           body: {"cookie": "<米游社 cookie>"}
                      → {"msg":"","data":{"result":"ok","round":N}}
```

只接受本机请求；`cookie` 只用于本次过码，不落盘。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GT_PORT` | `8766` | 监听端口 |
| `GT_DISPLAY` | `:77` | X display（**别用 :99**，常被别的程序占满） |
| `GT_DISPLAY_NUM` | `77` | `start.sh` 自建 Xvfb 用的编号 |
| `GT_MAX_ROUNDS` | `8` | 最多重试轮数 |
| `GT_PYTHON` | — | Python 解释器路径 |
| `GT_CHROMIUM` | `/usr/bin/chromium` | 浏览器路径 |

## 排障

| 现象 | 原因 |
|---|---|
| `Can't open display` | 没起 Xvfb，或 `DISPLAY` 没传进服务进程 |
| `Maximum number of clients reached` | display 被别的程序占满，换个编号 |
| 日志一直「未过」 | openbox 没起（鼠标事件送不进浏览器），或缺口识别受干扰 |
| 回交报「拼图已过期」 | 用了旧的 challenge；应回交极验返回的那个 |

## 实现要点（改代码前先看）

1. **必须 `browser.disconnect()`** —— CDP 处于 attach 状态时极验一律判 bot，`ajax` 回 `forbidden`
2. **拖动只能用 xdotool** —— CDP 注入的鼠标事件会被识别
3. **必须有窗口管理器**（openbox）—— 否则 X 窗口不映射，事件送不到
4. **抓图前要强制显示 `fullbg` canvas** —— 它默认 `display:none`，不显示就拿不到无缺口的底图
5. **缺口用差分法**（bg vs fullbg）—— 比模板匹配/边缘匹配稳
6. **xdotool 的 `sleep` 要放进参数数组**（`['mousemove',x,y,'sleep','0.28']`），
   拆成多次独立调用反而可能不派发事件
7. **回交要用极验返回的新 challenge**（带 `lk`/`5r`/`i6` 后缀），用最初申请的会报「拼图已过期」

## 说明

仅供学习交流。过码会清除账号的验证码风控，使用风险自负。
