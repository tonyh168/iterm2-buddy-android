# 用阿里云服务器 + frp 替代 Cloudflare Tunnel

## 为什么换

| | Cloudflare Quick Tunnel | 阿里云 frp |
|---|---|---|
| 页面首次加载 | ~950 ms | **~120 ms** |
| 打字→回显 | ~142 ms | **~75 ms** |
| 地址 | 每次重启都变 | **固定 IP** |
| 依赖 | Cloudflare 边缘（东京） | 自己的服务器 |
| HTTPS | 自动有 | 无（HTTP），除非配域名+备案 |

实测这台阿里云在北京，本机 ping 中位 35 ms，一次往返两个跳跃都在境内。

## 前置条件

1. 云服务器已装好 frps（本文档下方有说明）
2. 安全组放行 **两个** 端口：
   - `12321` — frpc 连服务器的隧道端口
   - `80` — 手机访问的端口

> 如果 80 想留给别的服务，可以换任意已放行端口，改 `remotePort` 即可。

## 一、服务器端（只需一次）

```bash
ssh <你的服务器>
```

下载安装 frp：

```bash
cd /tmp
curl -sL -o frps.tgz \
  https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_linux_amd64.tar.gz
tar xzf frps.tgz
sudo install -m 755 frp_0.71.1_linux_amd64/frps /usr/local/bin/
sudo install -m 755 frp_0.71.1_linux_amd64/frpc /usr/local/bin/
```

生成令牌并写配置：

```bash
TOKEN=$(openssl rand -hex 24)
echo "记下令牌: $TOKEN"

sudo mkdir -p /etc/frp
sudo tee /etc/frp/frps.toml >/dev/null <<EOF
bindPort = 12321
auth.method = "token"
auth.token = "$TOKEN"
transport.tls.force = true

log.to = "/var/log/frps.log"
log.level = "info"
log.maxDays = 7
EOF
sudo chmod 600 /etc/frp/frps.toml
```

创建 systemd 服务：

```bash
sudo tee /etc/systemd/system/frps.service >/dev/null <<'EOF'
[Unit]
Description=frp server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now frps
sudo systemctl status frps
```

> `User=root` 是必需的——`remotePort=80` 需要绑定低端口权限。

## 二、Mac 端

```bash
cd ~/Desktop/iterm-mirror
./deploy/frp/setup-aliyun.sh <服务器IP> <令牌> 80
```

启动：

```bash
./tunnel-aliyun.sh start     # 后台
./tunnel-aliyun.sh status    # 查看状态 + 公网可达性
./tunnel-aliyun.sh stop      # 停止
./tunnel-aliyun.sh           # 前台运行，Ctrl-C 退出
```

## 三、手机访问

```
http://<服务器IP>/?t=<.token 里的令牌>
```

80 端口是 HTTP 默认端口，地址里不用带端口号。

## 架构

```
手机 ──HTTP:80──> 阿里云 frps ──[frpc 主动建立的长连接]──> Mac frpc ──> 127.0.0.1:7861
```

关键和 Cloudflare 一致：**Mac 主动向外连**，所以不需要公网 IP、不用改路由器。

区别是中间那台服务器是自己的，节点在国内，所以快。

## 和 SSH 反向隧道的对比

也试过纯 SSH 方案（`ssh -R 0.0.0.0:PORT:127.0.0.1:7861`），但：

| | SSH `-R` | frp |
|---|---|---|
| 打字回显 | 341 ms | **75 ms** |
| 心跳中位 | 80 ms，p90 158 ms | 80 ms，p90 稳定 |
| 断线重连 | 需自己写逻辑 | 内置心跳+重连 |
| 多路复用 | 单 TCP 串行 | 独立流 |

SSH 隧道所有请求挤在一条 TCP 上，容易队头阻塞，实时性明显更差。所以选了 frp。

> 顺带说明：如果只想临时试一下，SSH 方案零安装，`ssh -R` 就能用，只是体验一般。

## 安全须知

**当前是明文 HTTP。** 令牌和终端内容在 `手机 ↔ 服务器` 之间明文传输。

已经做的：`transport.tls.force` / `transport.tls.enable` 让 **Mac ↔ 服务器** 那段加密。

没解决的：**手机 ↔ 服务器** 那段。

彻底解决的办法：
1. 绑域名 + Caddy 自动 HTTPS（需要 ICP 备案）
2. 走 Tailscale（端到端加密）
3. 接受风险，只在可信网络用

## 排错

**手机连不上**

```bash
# 服务器上看 frps 有没有监听
sudo ss -tln | grep -E ':(12321|80) '

# 服务器上看 frpc 有没有连上
sudo tail -20 /var/log/frps.log | grep -i "client\|proxy"
```

八成是安全组没放行，或 `remotePort` 与已占用端口冲突。

**frpc 连不上服务器**

```bash
tail -20 /tmp/frpc-aliyun.log
```

看到 `connect to server error: EOF` 通常是令牌不对，或服务端 `transport.tls.force` 与客户端 `transport.tls.enable` 不匹配。

**页面能开但打字没反应**

先确认本地服务在跑：

```bash
curl --noproxy '*' http://127.0.0.1:7861/
```

这里的 502 类错误是 SSH 客户端连不上本地端口——也就是镜像服务挂了，不是隧道问题。

## 已验证

2026-11-02 在阿里云 47.95.15.173（Alibaba Cloud Linux 3）+ macOS 上实测：

| 项目 | 结果 |
|---|---|
| frps systemd 自启 | ✓ active |
| 服务器 80 / 12321 监听 | ✓ |
| HTTP 令牌鉴权 | ✓ 无令牌 401，带令牌 200 |
| 页面加载 | 117 ms（Cloudflare 950 ms） |
| WebSocket 握手 | ~270 ms |
| 心跳往返中位 | 80 ms |
| **打字→回显中位** | **75 ms**（Cloudflare 142 ms） |
| pane 读取 | ✓ 5 个 pane 正常 |
