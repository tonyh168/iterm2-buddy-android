#!/bin/bash
# 下载 cloudflared（不把 20MB 二进制提交进仓库）
set -e
cd "$(dirname "$0")/.."
mkdir -p bin

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  ASSET="cloudflared-darwin-arm64.tgz" ;;
      x86_64) ASSET="cloudflared-darwin-amd64.tgz" ;;
      *) echo "不支持的架构: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      aarch64|arm64) ASSET="cloudflared-linux-arm64" ;;
      x86_64)        ASSET="cloudflared-linux-amd64" ;;
      *) echo "不支持的架构: $ARCH"; exit 1 ;;
    esac
    ;;
  *) echo "不支持的系统: $OS"; exit 1 ;;
esac

URL="https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}"
echo "下载 $ASSET ..."
curl -fL --retry 2 -o "bin/${ASSET}" "$URL"

if [[ "$ASSET" == *.tgz ]]; then
  tar xzf "bin/${ASSET}" -C bin
  rm -f "bin/${ASSET}"
else
  mv "bin/${ASSET}" bin/cloudflared
fi

chmod +x bin/cloudflared
# macOS 上去掉隔离属性，否则首次运行会被拦
xattr -d com.apple.quarantine bin/cloudflared 2>/dev/null || true

echo "完成：$(./bin/cloudflared --version)"
