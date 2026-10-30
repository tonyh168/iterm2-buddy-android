#!/bin/bash
# 在云服务器上执行，一键装好 frps
#
# 用法：
#   ssh root@你的服务器IP
#   curl -fsSL https://raw.githubusercontent.com/tonyh168/iterm2-buddy-android/main/deploy/frp/setup-server.sh | bash
#
# 或者把本文件 scp 上去再跑。
set -euo pipefail

FRP_VERSION="0.71.1"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ASSET="frp_${FRP_VERSION}_linux_amd64.tar.gz" ;;
  aarch64|arm64) ASSET="frp_${FRP_VERSION}_linux_arm64.tar.gz" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo "==> 下载 frp ${FRP_VERSION}"
cd /tmp
curl -fL --retry 2 -o frp.tar.gz \
  "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ASSET}"
tar xzf frp.tar.gz
DIR="frp_${FRP_VERSION}_linux_$( [ "$ARCH" = "x86_64" ] && echo amd64 || echo arm64 )"

echo "==> 安装到 /usr/local/bin"
install -m 755 "$DIR/frps" /usr/local/bin/frps
install -m 755 "$DIR/frpc" /usr/local/bin/frpc

echo "==> 创建配置目录"
mkdir -p /etc/frp
if [ ! -f /etc/frp/frps.toml ]; then
  TOKEN="$(openssl rand -hex 24)"
  cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
auth.method = "token"
auth.token = "${TOKEN}"
transport.tls.force = true

webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "$(openssl rand -hex 12)"

log.to = "/var/log/frps.log"
log.level = "info"
log.maxDays = 7
EOF
  chmod 600 /etc/frp/frps.toml
  echo
  echo "================ 重要 ================"
  echo "已生成认证令牌，把它填到 Mac 上的 frpc.toml 里："
  echo
  echo "  ${TOKEN}"
  echo
  echo "======================================"
else
  echo "配置已存在，跳过生成"
fi

echo "==> 创建 systemd 服务"
cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable frps
systemctl restart frps

sleep 2
echo "==> 服务状态"
systemctl is-active frps && echo "frps 已启动"

echo
echo "==> 防火墙提示"
echo "还需要在云厂商控制台的【防火墙/安全组】里放行这两个端口："
echo "  7000  （frp 隧道控制端口）"
echo "  8080  （手机访问镜像服务的端口）"
echo
echo "放行后，手机访问： http://$(curl -s ifconfig.me 2>/dev/null || echo '你的服务器IP'):8080/?t=你的令牌"
