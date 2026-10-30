# 用国内云服务器 + frp 降低延迟

## 为什么需要这个

Cloudflare Quick Tunnel 免费且省事，但国内访问时边缘节点通常落在**东京**，导致一次往返要**跨境两趟**：

```
手机 →(57ms)→ 东京边缘 →(57ms)→ 你的 Mac     单次往返 ≈ 114ms
```

改用一台国内轻量服务器做中转，两个跳跃都在境内：

```
手机 →(20ms)→ 国内服务器 →(20ms)→ 你的 Mac    单次往返 ≈ 40ms
```

原理和 Cloudflare Tunnel 完全相同——**Mac 主动向外连服务器**，所以依然不需要公网 IP。

## 成本

只要试用一个月的话是 **0 元**。

| 云商 | 免费试用 | 带宽 | 时长 |
|---|---|---|---|
| 阿里云轻量（推荐） | 2核1G / 40G | **200M 峰值** | 1 个月 |
| 腾讯云轻量 | 2核2G / 40G | 3M 固定 | 1 个月 |

> 推荐阿里云是因为 200M 峰值带宽能吃掉突发流量（切换 pane 时有 16KB 一次性推流），3M 会卡一下。内存 1G 完全够，frps 自身只占 10-20MB。

付费的话，阿里云 68 元/年、腾讯云 99 元/年（新老同价、续费不涨）。

## 一、申请服务器

1. 打开 <https://free.aliyun.com>
2. 完成个人实名认证（支付宝刷脸，约 2 分钟）
3. 筛选「计算」→「轻量应用服务器」
4. 选 **2核1G**，地域选**离你最近的**（北京用户选北京）
5. 0 元开通

拿到公网 IP 后继续。

## 二、配置服务器

```bash
ssh root@你的服务器IP
```

然后二选一：

**方式 A：直接跑脚本**（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/tonyh168/iterm2-buddy-android/main/deploy/frp/setup-server.sh | bash
```

脚本会：下载 frp、安装到 `/usr/local/bin`、生成随机令牌、写配置、创建 systemd 服务并启动。

**务必记下脚本最后打印的令牌**，下一步要用。

**方式 B：手动配置**

```bash
FRP_VERSION=0.71.1
curl -fL -o /tmp/frp.tar.gz \
  "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz"
tar xzf /tmp/frp.tar.gz -C /tmp
install -m 755 /tmp/frp_${FRP_VERSION}_linux_amd64/frps /usr/local/bin/frps

mkdir -p /etc/frp
# 把仓库里的 deploy/frp/frps.toml 复制到 /etc/frp/ 并改掉 auth.token
```

## 三、放行防火墙（最容易漏的一步）

去云厂商控制台的 **防火墙 / 安全组**，放行：

| 端口 | 用途 |
|---|---|
| `7000` | frp 隧道控制端口 |
| `8080` | 手机访问镜像服务 |

**轻量服务器默认只开 22/80/443，不开这两个端口就永远连不上。** 这是新手最常卡住的地方。

## 四、配置 Mac

```bash
cd ~/Desktop/iterm-mirror
./deploy/frp/setup-client.sh <服务器IP> <认证令牌>
```

然后运行：

```bash
./bin/frpc -c ~/.frp/frpc.toml
```

看到 `start proxy success` 就通了。

## 五、手机访问

```bash
http://<服务器IP>:8080/?t=$(cat .token)
```

---

## 和 Cloudflare Tunnel 的取舍

| | Cloudflare Tunnel | 自建 frp |
|---|---|---|
| 成本 | 免费 | 试用免费 / 68-99 元/年 |
| 单次往返 | ~114 ms | **~40 ms** |
| HTTPS | 自动有 | 需要域名+备案，否则是 HTTP |
| 地址稳定性 | 重启就变 | **固定 IP，不变** |
| 流量上限 | 无限 | 套餐流量包（够用） |
| 维护 | 零 | 自己管服务器 |

**自建的额外好处：地址固定。** Cloudflare Quick Tunnel 每次重启都换子域名，手机书签会失效；自建 frp 的 `IP:8080` 永远不变。

## 安全须知

**自建方案默认没有 HTTPS。** 令牌和终端内容会在 `手机 ↔ 服务器` 之间以明文传输。

已经做的：配置里开了 `transport.tls.force` / `transport.tls.enable`，所以 **Mac ↔ 服务器** 这一段是加密的。

没解决的：**手机 ↔ 服务器** 这段仍是明文。同网络的人能抓包。

要彻底解决有三条路：

1. **加个域名 + Caddy 自动 HTTPS**（需要 ICP 备案）
2. **用 Tailscale 替代**（端到端加密，免费，但手机要装 App）
3. 接受风险，仅在自己信任的网络使用

## 排错

**连不上服务器**

```bash
# 服务器上确认 frps 在跑
systemctl status frps
ss -tlnp | grep 7000
```

九成是防火墙没放行 7000。

**连上了但手机打不开页面**

```bash
# 服务器上确认 8080 有监听
ss -tlnp | grep 8080
```

没监听说明 frpc 没连上，看 Mac 上的 `~/.frp/frpc.toml` 令牌是否和服务端一致。

**画面卡顿但延迟低**

那是手机端渲染瓶颈，不是网络问题。可以关掉「跟随」、切到较小的 pane 试试。

## 已验证

在 macOS 上用 frp 0.71.1 做过完整端到端测试：

| 项目 | 结果 |
|---|---|
| frps / frpc 配置语法 | 均通过 `verify` |
| TCP 转发 | ✓ 18080 → 7861 |
| 令牌鉴权 | ✓ 无令牌 401，带令牌 200 |
| WebSocket | ✓ 握手 20ms，心跳 0.4ms |
| 全量快照 | ✓ 272 列 × 61 行正常传输 |
