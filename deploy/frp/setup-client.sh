#!/bin/bash
# 在 Mac 上执行：装好 frpc 并连上服务器
#
# 用法：
#   ./deploy/frp/setup-client.sh <服务器IP> <认证令牌>
#
# 例：
#   ./deploy/frp/setup-client.sh 43.1.2.3 abc123def456...
set -euo pipefail
cd "$(dirname "$0")/../.."

SERVER_IP="${1:-}"
TOKEN="${2:-}"

if [ -z "$SERVER_IP" ] || [ -z "$TOKEN" ]; then
  echo "用法: $0 <服务器IP> <认证令牌>"
  echo
  echo "令牌可以在服务器的 /etc/frp/frps.toml 里找到，"
  echo "或者运行 setup-server.sh 结束时打印出来的那一串。"
  exit 1
fi

FRP_VERSION="0.71.1"
mkdir -p bin ~/.frp

if [ ! -x bin/frpc ]; then
  echo "==> 下载 frpc"
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64)  ASSET="frp_${FRP_VERSION}_darwin_arm64.tar.gz" ;;
    x86_64) ASSET="frp_${FRP_VERSION}_darwin_amd64.tar.gz" ;;
    *) echo "不支持的架构: $ARCH"; exit 1 ;;
  esac
  curl -fL --retry 2 -o /tmp/frp-mac.tar.gz \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ASSET}"
  tar xzf /tmp/frp-mac.tar.gz -C /tmp
  DIR="/tmp/frp_${FRP_VERSION}_darwin_$( [ "$ARCH" = "arm64" ] && echo arm64 || echo amd64 )"
  install -m 755 "$DIR/frpc" bin/frpc
  xattr -d com.apple.quarantine bin/frpc 2>/dev/null || true
  rm -rf "$DIR" /tmp/frp-mac.tar.gz
fi

echo "==> 写入配置"
cat > ~/.frp/frpc.toml <<EOF
serverAddr = "${SERVER_IP}"
serverPort = 7000

auth.method = "token"
auth.token = "${TOKEN}"

transport.tls.enable = true
transport.heartbeatInterval = 20
transport.heartbeatTimeout = 90

log.to = "/tmp/frpc.log"
log.level = "info"
log.maxDays = 3

[[proxies]]
name = "iterm-mirror"
type = "tcp"
localIP = "127.0.0.1"
localPort = 7861
remotePort = 8080
EOF
chmod 600 ~/.frp/frpc.toml

echo "配置已写入 ~/.frp/frpc.toml"
echo
echo "启动命令："
echo "  ./bin/frpc -c ~/.frp/frpc.toml"
echo
echo "启动后手机访问："
echo "  http://${SERVER_IP}:8080/?t=\$(cat .token)"
