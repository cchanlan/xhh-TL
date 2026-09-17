# xhh-TL · solver 分支

**这个分支只放米游社全自动过码服务**，插件本体在 [`master`](https://gitcode.com/ccxhan/xhh-TL) 分支。

## 为什么单独开一个分支

过码服务是独立跑的一个进程（由 pm2 托管），跟插件本体没有代码依赖 ——
多数用户根本用不上，放在 master 里会让每次 `git pull` 都拉下一堆用不到的东西，所以拆出来。

服务是**纯 HTTP 协议**实现，不需要浏览器、桌面环境或模拟鼠标，Linux / Windows 都能跑，
依赖只有 Python 和三个 pip 包。

## 装法

**推荐一键装**：在群里发（需主人权限）

```
#过码部署
```

它会自动拉本分支的 `service/` → 建 venv 装依赖 → 起服务 → 把地址写进配置 → 验活。
装完发 `#过码服务状态` 看结果。

**手动装**：见 [`service/geetest/README.md`](service/geetest/README.md)。

## 装好之后

插件（含 genshin、miao-plugin 等走米游社的指令）**一撞验证码就自动过码并重试原请求**，
用户不用做任何事、也不会收到打扰。

没装也不影响使用：连不上服务就回退成「提示发 `#过码` 手划」，再不行也只是原本那条失败提示。

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

**本项目仅供学习交流与技术研究，请勿用于任何商业用途。**

- 使用本服务产生的**一切账号风险由使用者自负**，作者不承担任何责任
- 本服务绕过了验证码这一安全机制，**请仅在你自己的账号上使用**，
  不要用于批量注册、爬取、代练等违反服务条款的场景
- 请遵守米游社 / 极验的服务条款与当地法律法规；因使用不当造成的后果与作者无关
- 若相关权利方认为本项目侵犯了其权益，请联系删除

> ⚠️ **`bili-ticket-gt-python` 是 AGPL-3.0 协议**。AGPL 要求：若你把它作为网络服务
> 提供给他人使用，需要向使用者提供完整源码。本服务设计为**本机自用**，
> 只监听 `127.0.0.1`，请勿将其作为对外服务部署。如需商用，请自行替换该依赖或自行实现等价逻辑。
