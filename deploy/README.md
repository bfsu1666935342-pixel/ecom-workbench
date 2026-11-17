# 用域名访问（不下载、不解压）

目标：同事打开 `https://work.example.com`，登录后直接用；不用下载 zip，也不用装 Node。

> **先看限制**：当前工作台是**单用户**工具。同一个域名 + 同一个 Basic Auth 后面，所有人共享：
>
> - `data/sessions`：最近对话
> - `workspace/`：生成的文件、上传的附件
> - `data/mcp.json`：领星等 MCP 的 Key
>
> 只适合“你自己从公司/家里访问”。要让多个同事各用各的，见文末「多人用怎么办」。

---

## 如果你只是要「更新方便」：源码直跑 + 自动更新

工作台还没完善时，**不要每改一次就打 zip、发 Release、下载解压**。更省事的方式是：

- 服务器上直接 `git clone` 两个仓库，用系统 Node 跑源码；
- 服务器每 2 分钟拉一次 `main`；
- 只改技能 → 工作台热重载，浏览器 F5；
- 改了服务端代码 → 自动重启一次；
- `data/` 和 `workspace/` 不进 Git，更新不会丢对话、MCP Key 和文件。

这样你在公司/家里改完：

```bash
git push
```

域名那边最多 2 分钟就是新版本，不用打包、不用发给别人。

### 先按第 1～4 节把服务跑起来

自动更新只是加在已经能运行的实例上。先完成：

1. `/opt/ecom/ecom-workbench` 和 `/opt/ecom/ecom-skills` 两个仓库并排；
2. systemd 的 `ecom-workbench` 能正常启动；
3. Caddy + Basic Auth 能打开域名。

### 装自动更新

```bash
cd /opt/ecom/ecom-workbench

# 允许 ecom 用户免密重启服务（路径按 which systemctl 调整）
sudo visudo -f /etc/sudoers.d/ecom-workbench
# 写入：ecom ALL=(root) NOPASSWD: /usr/bin/systemctl restart ecom-workbench

sudo cp deploy/ecom-update.service deploy/ecom-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ecom-update.timer

# 立刻手动跑一次，确认能拉到代码
sudo systemctl start ecom-update.service
journalctl -u ecom-update.service -n 30 --no-pager
```

之后每 2 分钟检查一次。看下一次触发：

```bash
systemctl list-timers | grep ecom
```

### 手动更新

不想等 2 分钟，或想先看输出：

```bash
cd /opt/ecom/ecom-workbench
bash deploy/update.sh
```

脚本会：

1. `git fetch` + `reset --hard origin/main` 工作台；
2. 同样更新 `ecom-skills`；
3. 如果工作台代码变了，`systemctl restart ecom-workbench`；
4. 如果只有技能变了，不重启，等热重载。

### 注意

- 服务器上的两个 checkout 是**只读部署目录**，不要在服务器上改代码；本地改完 push，服务器 `reset --hard` 会覆盖。
- 现在默认跟 `main`，push 到 main 就等于上线。工作台还不完善时，建议：
  - 平时在 `preview` 分支改，稳定后再合到 main；或
  - 把 `deploy/ecom-update.service` 里的 `ECOM_BRANCH` 改成 `preview`。
- 如果服务重启失败，域商会看到 502；先看 `journalctl -u ecom-workbench -n 100`，修完再 push。
- GitHub 在服务器上拉不动时，先解决服务器到 GitHub 的网络（代理/镜像），自动更新脚本本身不负责翻墙。

---

## 需要准备

1. 一台 Linux 服务器（2 核 2G 起，Ubuntu 24.04 即可）
2. 一个域名，例如 `work.example.com`，DNS A 记录指向服务器 IP
3. 服务器开放 80 / 443（Caddy 自动签 HTTPS 证书）
4. 服务器上安装 Node.js 24 和 Caddy

> 如果域名解析在公司内网/Cloudflare 代理后面，Caddy 的自动 HTTPS 可能签不下来；
> 公司内网可以用内部 DNS + 内部 CA，或先按本文最后「Cloudflare Tunnel」的方式走。

---

## 1. 放两个仓库

工作台和技能库要并排，`config.json` 里的 `extraSkillsDirs: ["../ecom-skills"]` 才找得到。

```bash
sudo useradd -r -m -d /opt/ecom -s /usr/sbin/nologin ecom
sudo mkdir -p /opt/ecom
sudo chown ecom:ecom /opt/ecom

sudo -u ecom git clone https://github.com/bfsu1666935342-pixel/ecom-workbench.git /opt/ecom/ecom-workbench
sudo -u ecom git clone https://github.com/bfsu1666935342-pixel/ecom-skills.git /opt/ecom/ecom-skills

sudo -u ecom mkdir -p /opt/ecom/ecom-workbench/{data,workspace}
```

目录应该是：

```text
/opt/ecom/
├─ ecom-workbench/
└─ ecom-skills/
```

---

## 2. 装 Node 和 Caddy

```bash
# Node 24（示例，按官方文档换最新 24.x）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

node -v   # v24.x
caddy version
```

---

## 3. 起服务

把 `deploy/ecom-workbench.service` 里的域名改成你的，然后：

```bash
sudo cp /opt/ecom/ecom-workbench/deploy/ecom-workbench.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ecom-workbench
sudo systemctl status ecom-workbench
```

先确认本机通了：

```bash
curl http://127.0.0.1:7861/api/health
# {"ok":true,...}
```

---

## 4. Caddy + 登录密码

生成密码哈希：

```bash
caddy hash-password --plaintext '换成一个强密码'
```

把输出整段填进 `deploy/Caddyfile` 的 `<BCRYPT_HASH>`，域名也改掉，然后：

```bash
sudo cp /opt/ecom/ecom-workbench/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

打开 `https://work.example.com`，浏览器会先弹 Basic Auth，输入用户名 `ecom` 和刚才的密码。

进入工作台后：

- 每个浏览器各自在「设置」里填自己的 DeepSeek API Key（存在浏览器 localStorage，不存服务器）。
- MCP 的地址/Key 存在服务器的 `data/mcp.json`，Basic Auth 后面共享；只给可信的人登录。
- 生成的文件在服务器 `/opt/ecom/ecom-workbench/workspace`；页面里可以下载。
- 「打开文件夹」按钮在无桌面的 Linux 上不可用，用下载即可。

---

## 5. 更新

```bash
cd /opt/ecom/ecom-workbench && sudo -u ecom git pull
cd /opt/ecom/ecom-skills && sudo -u ecom git pull
sudo systemctl restart ecom-workbench
```

技能库改动不需要重启：工作台会热重载，浏览器 F5 即可。
工作台代码改动后重启一次。

---

## 6. 备份

```bash
sudo tar czf /root/ecom-backup-$(date +%F).tar.gz \
  -C /opt/ecom/ecom-workbench data workspace
```

`data/` 里有对话和 MCP Key，不要公开。

---

## 7. 多人用怎么办

现在**不要**把同一个域名账号发给多个同事，否则他们会看到彼此的对话和文件。

三种可行路线：

1. **一人一个实例**（最稳）：`a-work.example.com`、`b-work.example.com` 各跑一份，各自独立的 `data/`、`workspace/`、端口。
2. **一人一个容器**：同一台服务器用 Docker 起多份，Caddy 按子域名分流。
3. **改造成多用户**：加登录、`data/users/<id>/`、按用户隔离 workspace 和 MCP 配置；这是代码改造，不是配置能解决的。

如果你只是自己从公司访问，按本文单用户方案就够了。

---

## 附：没有服务器，用 Cloudflare Tunnel

适合：不想买 VPS，办公室电脑可以长期开机。

```bash
# 在工作台所在电脑上
cloudflared tunnel --url http://127.0.0.1:7861
```

Cloudflare 会给你一个临时域名；绑定自己的域名需要在 Cloudflare Zero Trust 里建 Tunnel，
再套一层 **Cloudflare Access** 做登录。电脑关机/断网，域名就打不开。

这种方式同样受“单用户共享数据”的限制。

---

## 常见问题

**打开域名 502**
Caddy 连不到 `127.0.0.1:7861`：看 `systemctl status ecom-workbench`，确认服务在跑、端口没被占。

**能打开页面，但发消息 403**
反向代理没把 `Origin`/`Host` 传对，或 `ECOM_PUBLIC_ORIGIN` 没设成实际的 `https://域名`。
service 文件里已经加了这一行，改完 `systemctl daemon-reload && systemctl restart ecom-workbench`。

**回答不流式，转圈很久才一次性出来**
Caddy 的 `flush_interval -1` 没生效；确认 Caddyfile 里在 `reverse_proxy` 块内。

**大陆服务器要不要备案**
域名解析到中国大陆服务器通常需要 ICP 备案；没有备案就用香港/新加坡节点，或公司内网域名。
