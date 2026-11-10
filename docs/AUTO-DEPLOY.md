# 自动部署

Cloudflare Workers Builds 连接本仓库的生产分支；构建先运行语法检查和 JavaScript 测试，再打包执行器与部署 Worker。构建时以 `YOUTAST_D1_ID` 变量填充 `wrangler.example.jsonc` 中的数据库 ID，实际配置不进入仓库。连接时先关闭自动构建，配置完毕并核对生产分支后再启用。参见 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

构建命令：`python3 scripts/cloudflare-build-config.py && npm ci && npm run check && npm test && npm run build:qrcode && python3 scripts/package-executor.py`。部署命令：`npx wrangler deploy`。关闭预览构建，避免测试分支使用生产数据库。

数据库迁移不自动执行。部署依赖新迁移的代码前，先备份 D1、确认兼容性并手动执行 `npm run db:remote`；Workers Builds 默认令牌不一定具备 D1 写入权限。

VPS 的 `youtast-auto-update.timer` 定期下载已发布的执行器 ZIP 和校验和，验证后停止领取任务并等待运行中的任务完成，再更新服务。YouTube cookies 和执行器密钥只留在 VPS。应用站点和校验和由同一来源发布，校验可以发现传输错误，不能抵御发布权限被滥用。更新状态通过 `systemctl status youtast-auto-update.service` 和 `journalctl -u youtast-auto-update.service` 检查。

安装前，首次手动升级到支持 SIGUSR1 排空的执行器；旧执行器不支持该信号。安装 `deploy/youtast-auto-update.service` 和 `.timer` 到 systemd，安装 `scripts/vps-auto-update.py` 到 `/opt/youtast/scripts/`，再运行 `systemctl daemon-reload` 和 `systemctl enable --now youtast-auto-update.timer`。确认服务状态及心跳。回滚前暂停定时器，否则它会再次安装当前发布版本。
