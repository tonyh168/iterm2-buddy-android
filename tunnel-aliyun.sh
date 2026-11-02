#!/bin/bash
# 通过阿里云服务器（frp）把本地镜像服务暴露到公网
#
# 用法:
#   ./tunnel-aliyun.sh          前台运行（Ctrl-C 停止）
#   ./tunnel-aliyun.sh start    后台运行
#   ./tunnel-aliyun.sh stop     停止
#   ./tunnel-aliyun.sh status   查看状态
set -euo pipefail
cd "$(dirname "$0")"

CONF="$HOME/.frp/frpc-aliyun.toml"
LOG="/tmp/frpc-aliyun.log"
PIDFILE="/tmp/frpc-aliyun.pid"

if [ ! -f "$CONF" ]; then
  echo "缺少配置 $CONF"
  echo "请先执行： ./deploy/frp/setup-aliyun.sh <服务器IP> <令牌>"
  exit 1
fi

if [ ! -x bin/frpc ]; then
  echo "缺少 bin/frpc，请先执行： ./deploy/frp/setup-client.sh <IP> <令牌>"
  exit 1
fi

# 从配置里读出服务器地址和 remotePort，拼出访问地址
SRV="$(grep -E '^serverAddr' "$CONF" | cut -d'"' -f2)"
RPORT="$(grep -E '^remotePort' "$CONF" | cut -d'=' -f2 | tr -d ' ')"
# 80 端口是 http 默认端口，不显示
PORT_PART=""
[ -n "$RPORT" ] && [ "$RPORT" != "80" ] && PORT_PART=":$RPORT"

case "${1:-fg}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已在运行 (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    nohup ./bin/frpc -c "$CONF" >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "✓ 已启动 (pid $(cat "$PIDFILE"))"
      echo "  日志: $LOG"
      echo "  地址: http://${SRV}${PORT_PART}/?t=$(cat .token 2>/dev/null || echo '<令牌>')"
    else
      echo "✗ 启动失败，查看日志: $LOG"
      rm -f "$PIDFILE"
      exit 1
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "已停止" || echo "进程不存在"
      rm -f "$PIDFILE"
    else
      for p in $(pgrep -f "frpc-aliyun.toml" 2>/dev/null); do kill "$p" 2>/dev/null; done
      echo "已停止"
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "✓ frpc 运行中 (pid $(cat "$PIDFILE"))"
      grep -E "start proxy success|login to server success" "$LOG" 2>/dev/null | tail -2
      echo
      T="$(cat .token 2>/dev/null)"
      curl -s --noproxy '*' -o /dev/null -m 8 \
        -w "公网可达性: %{http_code}  耗时 %{time_total}s\n" \
        "http://${SRV}${PORT_PART}/?t=$T" || echo "公网不可达"
    else
      echo "✗ frpc 未运行"
      exit 1
    fi
    ;;
  fg|*)
    echo "隧道目标: http://${SRV}${PORT_PART}/"
    exec ./bin/frpc -c "$CONF"
    ;;
esac
