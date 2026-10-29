#!/bin/bash
# 启动镜像服务（本地）
set -e
cd "$(dirname "$0")"

if [ ! -f .token ]; then
  openssl rand -hex 12 > .token
  chmod 600 .token
  echo "已生成访问令牌，保存在 .token"
fi
TOKEN="$(cat .token)"

exec python3 server.py --token "$TOKEN" "$@"
