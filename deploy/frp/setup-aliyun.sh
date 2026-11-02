#!/bin/bash
# 在 Mac 上执行：配置 frpc 连接阿里云服务器
#
# 用法:
#   ./deploy/frp/setup-aliyun.sh <服务器IP> <认证令牌> [远端端口]
#
# 例:
#   ./deploy/frp/setup-aliyun.sh 47.95.15.173 bf1de48e... 80
#
# 服务器端需已运行 frps（bindPort 默认 12321）
set -euo pipefail
cd "$(dirname "$0")/../.."

SRV="${1:-}"
TOKEN="${2:-}"
RPORT="${3:-80}"

if [ -z "$SRV" ] || [ -z "$TOKEN" ]; then
  echo "用法: $0 <服务器IP> <认证令牌> [远端端口，默认80]"
  echo
  echo "令牌在服务器的 /etc/frp/frps.toml 里，或查看:"
  echo "  ssh <服务器> 'sudo grep auth.token /etc/frp/frps.toml'"
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
  curl -sL --noproxy '*' -o /tmp/frp-mac.tgz \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ASSET}"
  tar xzf /tmp/frp-mac.tgz -C /tmp
  install -m 755 "/tmp/frp_${FRP_VERSION}_darwin_$( [ "$ARCH" = arm64 ] && echo arm64 || echo amd64 )/frpc" bin/frpc
  xattr -d com.apple.quarantine bin/frpc 2>/dev/null || true
  rm -rf /tmp/frp_${FRP_VERSION}_darwin_* /tmp/frp-mac.tgz
fi

cat > ~/.frp/frpc-aliyun.toml <<EOF
serverAddr = "${SRV}"
serverPort = 12321

auth.method = "token"
auth.token = "${TOKEN}"

transport.tls.enable = true
transport.heartbeatInterval = 20
transport.heartbeatTimeout = 90

log.to = "/tmp/frpc-aliyun.log"
log.level = "info"
log.maxDays = 3

[[proxies]]
name = "iterm-mirror"
type = "tcp"
localIP = "127.0.0.1"
localPort = 7861
remotePort = ${RPORT}
EOF
chmod 600 ~/.frp/frpc-aliyun.toml

echo "✓ 配置已写入 ~/.frp/frpc-aliyun.toml"
echo
echo "启动:  ./tunnel-aliyun.sh start"
echo "访问:  http://${SRV}$( [ "$RPORT" != "80" ] && echo ":$RPORT" )/?t=\$(cat .token)"
