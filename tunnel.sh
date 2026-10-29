#!/bin/bash
# 建立公网隧道（Cloudflare Quick Tunnel）
#
# 用法:
#   ./tunnel.sh                    公开链接（靠服务端令牌兜底）
#   ./tunnel.sh you@example.com    额外加一层邮箱 OTP 验证
set -e
cd "$(dirname "$0")"

CF="./bin/cloudflared"
if [ ! -x "$CF" ]; then
  echo "找不到 bin/cloudflared，先下载："
  echo "  ./scripts/get-cloudflared.sh"
  exit 1
fi

PORT="${PORT:-7861}"
ARGS=(tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate --protocol http2)

if [ -n "$1" ]; then
  ARGS+=(--allowed-mail "$1")
  echo "已启用邮箱验证: $1"
fi

echo "隧道启动中，留意下方 https://*.trycloudflare.com 地址"
exec "$CF" "${ARGS[@]}"
