# Debian VPS 部署执行器

以下步骤适用于有 systemd 的 Debian VPS，以 root 执行服务器命令。执行器以独立的 `youtast` 系统用户运行，主动连接 YouTast，无需开放入站端口。示例目录与当前部署一致；替换地址和文件路径，不要把密钥或 cookies 提交到 Git 或发送到聊天。

## 安装程序和依赖

在本机项目根目录打包，复制到服务器；`VPS_HOST`、SSH 密钥路径按实际修改：

```powershell
python scripts/package-executor.py
scp -i "$env:USERPROFILE\.ssh\id_ed25519" dist/youtast-executor-0.1.0.zip root@VPS_HOST:/tmp/youtast-executor.zip
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@VPS_HOST
```

下列解压步骤用于**新安装**；已有部署升级应先备份配置、确认任务状态并按后文处理，避免覆盖运行中的程序。安装包需包含 `scripts/windows-runner.py` 和 `scripts/windows-cleanup.py`；这两个脚本也支持本指南的 Linux systemd 配置。

```bash
apt-get update
apt-get install -y python3 python3-venv ffmpeg curl unzip
install -d -m 755 /opt/youtast
unzip /tmp/youtast-executor.zip -d /tmp/youtast-package
cp -a /tmp/youtast-package/youtast-executor/. /opt/youtast/
python3 -m venv /opt/youtast/.venv
/opt/youtast/.venv/bin/pip install -U -r /opt/youtast/requirements.txt
id youtast >/dev/null 2>&1 || useradd --system --home-dir /var/lib/youtast --shell /usr/sbin/nologin youtast
install -d -o youtast -g youtast -m 700 /opt/youtast/.wrangler/windows-executor
install -d -o root -g youtast -m 750 /etc/youtast
```

执行器还需要 PATH 中有 Node.js 22+ 或 Deno 2.3+。例如按 [Deno 官方安装说明](https://docs.deno.com/runtime/getting_started/installation/)安装到 `/opt/youtast/deno`，并验证：

```bash
curl -fsSL https://deno.land/install.sh -o /tmp/youtast-deno-install.sh
DENO_INSTALL=/opt/youtast/deno sh /tmp/youtast-deno-install.sh
/opt/youtast/deno/bin/deno --version
```

确保服务用户可以读取、执行 `/opt/youtast/deno` 下的文件。仅 `yt-dlp` 和 FFmpeg 不足以替代受支持的 JavaScript 运行时。

## 配置机器密钥

在 YouTast 网站「执行器」页面为这台 VPS 创建单独的密钥。以下命令在服务器交互终端执行：输入实际应用 HTTPS 地址；密钥在提示时粘贴，输入不会回显，也不会放入 shell 历史。

```bash
umask 077
read -r -p 'YouTast URL: ' YOUTAST_URL
read -r -s -p 'Executor token: ' YOUTAST_TOKEN; echo
printf 'YOUTAST_URL=%s\nYOUTAST_TOKEN=%s\n' "$YOUTAST_URL" "$YOUTAST_TOKEN" > /etc/youtast/executor.env
unset YOUTAST_URL YOUTAST_TOKEN
chown root:youtast /etc/youtast/executor.env
chmod 640 /etc/youtast/executor.env
```

配置文件采用每行 `KEY=value` 格式，启动器读取 `YOUTAST_URL`、`YOUTAST_TOKEN` 和可选的 `YOUTAST_COOKIES_FILE` 等值。服务用户需要读取权限，其他用户不应能读取；`/etc/youtast` 的组遍历权限也必须保留。

## systemd 服务与清理

以下文件中的路径对应上面的安装方式。直接停止或重启服务会发送 SIGTERM，执行器会取消正在运行的下载；`TimeoutStopSec=infinity` 不会改变这一行为。自动更新方案使用单独的排空信号等待任务完成，详见[自动部署](AUTO-DEPLOY.md)。

```bash
cat > /etc/systemd/system/youtast-executor.service <<'EOF'
[Unit]
Description=YouTast outbound executor
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=youtast
Group=youtast
WorkingDirectory=/opt/youtast
Environment=PATH=/opt/youtast/deno/bin:/usr/local/bin:/usr/bin:/bin
Environment=XDG_CACHE_HOME=/opt/youtast/.wrangler/windows-executor/cache
ExecStart=/opt/youtast/.venv/bin/python /opt/youtast/scripts/windows-runner.py --config /etc/youtast/executor.env
Restart=on-failure
RestartSec=30
KillMode=mixed
TimeoutStopSec=infinity
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/youtast/.wrangler/windows-executor
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/youtast-cleanup.service <<'EOF'
[Unit]
Description=Clean stale YouTast executor files
[Service]
Type=oneshot
User=youtast
Group=youtast
ExecStart=/opt/youtast/.venv/bin/python /opt/youtast/scripts/windows-cleanup.py
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/youtast/.wrangler/windows-executor
EOF

cat > /etc/systemd/system/youtast-cleanup.timer <<'EOF'
[Unit]
Description=Regular YouTast executor cleanup
[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now youtast-executor.service youtast-cleanup.timer
systemctl start youtast-cleanup.service
systemctl status youtast-executor.service --no-pager
systemctl status youtast-cleanup.timer --no-pager
```

清理器删除超过 7 天的缓存；缓存超过 256 MiB 时优先删除旧文件。最近 24 小时的缓存不会删除，因此 256 MiB 是清理目标而非硬上限。任务临时文件正常结束时删除；异常退出遗留的专用临时目录至少 24 小时后清理，通过锁保护仍在运行的任务。这个规则不删除云端音频、手工保存的音频，也不处理旧版本在系统临时目录留下的文件。开机后 5 分钟首次检查，之后约每 6 小时检查。

## 配置 YouTube cookies

可从可信浏览器导出 **仅包含 `youtube.com` 域名**的 Netscape 格式 cookies 文件。服务端会检查格式、域名以及是否至少有一个未过期 cookie；此检查不保证 YouTube 一定接受会话。不要使用浏览器完整 cookie 数据库。

在 Windows 本机将导出的文件安全复制到 VPS；先创建仅 root 可写的目标文件，复制完成后再赋予服务用户读取权限。以下是独立的本机 PowerShell 命令，替换路径和主机：

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" root@VPS_HOST 'umask 077; install -m 600 /dev/null /etc/youtast/youtube-cookies.txt'
scp -i "$env:USERPROFILE\.ssh\id_ed25519" 'C:\private\youtube-cookies.txt' root@VPS_HOST:/etc/youtast/youtube-cookies.txt
```

回到 VPS，将这一行加入 `/etc/youtast/executor.env`（如果已有同名行，请编辑原行，确保只出现一次），然后验证并重启：

```bash
chown root:youtast /etc/youtast/youtube-cookies.txt
chmod 640 /etc/youtast/youtube-cookies.txt
printf '%s\n' 'YOUTAST_COOKIES_FILE=/etc/youtast/youtube-cookies.txt' >> /etc/youtast/executor.env
runuser -u youtast -- /opt/youtast/.venv/bin/python -c 'import sys; sys.path[:0]=["/opt/youtast/executor","/opt/youtast"]; import agent; agent.youtube_cookie_file("/etc/youtast/youtube-cookies.txt"); print("Cookies file validated")'
systemctl restart youtast-executor.service
systemctl is-active youtast-executor.service
```

每个任务使用临时副本，不覆盖原始导出。账号会话可能失效，需要时重新导出并替换；若 YouTube 仍要求验证或返回 403，应检查会话、网络和可能需要的 PO Token，详见[执行器说明](../executor/README.md)。cookies 在可信 VPS 本地使用，不应上传至 Cloudflare 或随日志分享。

## 运维与验证

```bash
systemctl status youtast-executor.service --no-pager
systemctl status youtast-cleanup.timer --no-pager
systemctl show youtast-cleanup.service -p Result -p ExecMainStatus
tail -n 50 /opt/youtast/.wrangler/windows-executor/executor.log
du -sh /opt/youtast/.wrangler/windows-executor/cache /opt/youtast/.wrangler/windows-executor/temp 2>/dev/null
systemctl restart youtast-executor.service  # 会取消正在运行的下载，请先确认空闲
```

服务为 active 只表示进程在运行；应在网站的「执行器」页面确认心跳，并检查实际任务是否成功。日志可能涉及任务信息，分享前先检查。撤销机器时在网站撤销其密钥，再停止服务；无需删除云端已完成音频。
