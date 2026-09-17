# xhh-TL · solver 分支

**这个分支只放米游社全自动过码服务**，插件本体在 [`master`](https://gitcode.com/ccxhan/xhh-TL) 分支。

## 为什么单独开一个分支

服务依赖 `xdotool` / `openbox` / `opencv` 和一整套 X11 环境，**只有 Linux 桌面环境能跑**，
多数用户用不上。放在 master 里会让每次 `git pull` 都拉下一堆用不到的东西，所以拆出来。

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
