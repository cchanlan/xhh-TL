# 米游社极验全自动过码服务

给 `xhh-TL` 插件用的**本地过码服务**：`#过码` 和撞码签到时，它自己解米游社的滑块验证码，
用户不用手划。

实测 **单轮约 87%**、平均 1.4 轮通过，**单次约 1.5 秒**。

> ⚠️ 本服务只监听 `127.0.0.1`，不对外暴露。

## 它到底在做什么

米游社的验证码是**极验 v3 私有部署的滑块**。整套流程是**纯 HTTP 协议**，
不需要浏览器、不需要桌面环境、不需要模拟鼠标：

```
① 米游社 createVerification → gt / challenge
② 极验 get.php  → 拿到 c/s（轨迹混淆参数）和背景图/滑块图的下载地址
③ 下载图片 → 还原乱序背景 → 模板匹配出缺口距离
④ 按极验的算法生成 w 参数（AES 加密轨迹 + RSA 加密密钥）
⑤ 极验返回 validate
⑥ 回交米游社 verifyVerfication → 风险清除
```

## 依赖

只需要 Python 3.9+ 和三个 pip 包（`requirements.txt` 里已列好）：

```
bili-ticket-gt-python==0.2.5    # 拿 c/s 和图片地址（Rust 扩展，需要 glibc >= 2.31）
pycryptodome>=3.19              # w 参数里的 AES / RSA
httpx>=0.27                     # HTTP 请求
```

> `bili-ticket-gt-python` 的 0.3.x 版本要求 glibc >= 2.38，Debian 12（glibc 2.36）
> 装不上。0.2.5 是 manylinux_2_31 的，兼容性最好 —— 别升级这个包。

## 部署

### 方式一：一键部署（推荐）

在群里发（需主人权限）：

```
#过码部署
```

它会自动：拉本分支的 `service/` → 建 venv 装依赖 → pm2 起服务 → 把 `auto_verify_addr`
写进配置 → 验活。装完发 `#过码服务状态` 可以看结果。

### 方式二：手动装

```bash
cd service/geetest
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
pm2 start .venv/bin/python --name geetest-solver -- server.py
pm2 save
```

然后把插件配置里的 `auto_verify_addr` 填成 `http://127.0.0.1:8766/solve`。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GT_PORT` | `8766` | 监听端口 |
| `GT_MAX_ROUNDS` | `8` | 单次请求最多重试几轮 |
| `GT_CONCURRENCY` | `4` | 批量请求时的并发数 |
| `GT_DEVICE_ID` / `GT_DEVICE_FP` | 固定值 | 过码用的设备参数，**必须与调用方后续重试时一致** |
| `GT_APP_VERSION` | `2.40.1` | 米游社 App 版本号 |

## 接口

- `GET /health` → `{ok, stats}`，`stats` 里有累计成功/失败、成功率、平均轮次与耗时
- `POST /` body `{cookie}` → `{data:{result:'ok', round}}`
- `POST /` body `{cookies:[...]}` → `{data:{results:[{ok, round}]}}`（并发跑）

## 已知限制

- **只支持滑块题**。极验在更高风险等级下会下发点选/九宫格题，遇到时本服务会跳过该轮
  （日志里会写「题型是 click」）。实测米游社目前只下发滑块。
- **每个 challenge 只能用一次**，用完必须重新申请，所以一轮失败就得整轮重来。
- 失败大多是「缺口差几像素」，靠多轮重试兜住，属于正常现象。

## 来源与致谢

本服务的实现**不是从零发明的**，参考与依赖了这些项目：

- [Amorter/biliTicker_gt](https://github.com/Amorter/biliTicker_gt)（**AGPL-3.0**）——
  **本服务直接依赖它发布的 Python 包 `bili-ticket-gt-python`**（见 `requirements.txt`），
  用它取 c/s 参数、拿图片地址、算缺口距离
- [Hobr/python-geetest3](https://github.com/Hobr/python-geetest3)（GPL-3.0）——
  `w.py` 里 w 参数的生成算法参考了它的实现思路（本仓库为独立重写）
- [ravizhan/geetest-v3-click-crack](https://github.com/ravizhan/geetest-v3-click-crack)（AGPL-3.0）——
  纯协议过码链路的思路参考
- [luguoyixiazi/test_nine](https://github.com/luguoyixiazi/test_nine) ——
  点选 / 九宫格题型的解法调研（当前未采用）

## 声明

**本服务仅供学习交流与技术研究，请勿用于任何商业用途。**

- 使用本服务产生的**一切账号风险由使用者自负**，作者不承担任何责任
- 本服务绕过了验证码这一安全机制，**请仅在你自己的账号上使用**，
  不要用于批量注册、爬取、代练等违反服务条款的场景
- 请遵守米游社 / 极验的服务条款与当地法律法规；因使用不当造成的后果与作者无关
- 若相关权利方认为本项目侵犯了其权益，请联系删除

> ⚠️ **`bili-ticket-gt-python` 是 AGPL-3.0 协议**。AGPL 要求：若你把它作为网络服务
> 提供给他人使用，需要向使用者提供完整源码。本服务设计为**本机自用**，
> 只监听 `127.0.0.1`，请勿将其作为对外服务部署。如需商用，请自行替换该依赖或自行实现等价逻辑。
