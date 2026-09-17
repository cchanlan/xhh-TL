#!/bin/bash
# 米游社过码服务启动脚本
#
# 纯协议实现，不需要 X11 / 浏览器 / xdotool，直接起 Python 服务即可。
# 用 pm2 托管：pm2 start start.sh --name geetest-solver --interpreter bash
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"

# 优先用本目录的 venv；没有就退回系统 python3
PY="$DIR/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

exec "$PY" "$DIR/server.py"
