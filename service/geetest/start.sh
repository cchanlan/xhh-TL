#!/bin/bash
# 米游社过码服务启动脚本
#
# 起 N 套 Xvfb + openbox，再起服务本体。
# 为什么要 N 套：xdotool 的鼠标指针是 **per-display** 的，一个屏上同一时刻
# 只能拖一个滑块。多账号并发过码时必须各占一个 display，否则互相抢指针。
#
# 用 pm2 托管本脚本即可。
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCREEN="${GT_SCREEN:-1280x1024x24}"
# 并发套数：默认 3（够三账号并发）；每套约 100MB（Xvfb 70 + openbox 31）
SLOTS="${GT_SLOTS:-3}"
BASE_DISPLAY="${GT_DISPLAY_NUM:-77}"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  exit 0
}
trap cleanup TERM INT

DISPLAYS=""
for i in $(seq 0 $((SLOTS - 1))); do
  num=$((BASE_DISPLAY + i))
  # 已有同号 display 就复用，否则自己起
  if [ ! -e "/tmp/.X11-unix/X${num}" ]; then
    Xvfb ":${num}" -screen 0 "$SCREEN" -nolisten tcp >"/tmp/gt_xvfb_${num}.log" 2>&1 &
    PIDS+=($!)
    for _ in $(seq 1 20); do
      [ -e "/tmp/.X11-unix/X${num}" ] && break
      sleep 0.5
    done
  fi
  # 每个 display 各起一个 openbox：没有窗口管理器时 X 窗口不映射，事件送不进浏览器
  if ! pgrep -f "openbox" >/dev/null 2>&1 || ! DISPLAY=":${num}" xdotool getdisplaygeometry >/dev/null 2>&1; then
    DISPLAY=":${num}" openbox >"/tmp/gt_openbox_${num}.log" 2>&1 &
    PIDS+=($!)
  fi
  DISPLAYS="${DISPLAYS}${DISPLAYS:+,}:${num}"
done

sleep 2
export GT_DISPLAYS="$DISPLAYS"
echo "[geetest] 已准备 ${SLOTS} 套显示环境: $DISPLAYS"

exec node "$DIR/server.mjs"
