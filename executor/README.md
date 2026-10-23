# YouTast 执行器

这是机器端执行器，主动领取任务、下载并输出 AAC/M4A（兼容旧 MP3），再上传到你的 Cloudflare 应用。无需公网入站端口。一个密钥只属于一个用户；多台机器请分别创建密钥，便于撤销和排查。

应用地址：https://your-worker.workers.dev

## Docker 启动

1. 在应用中注册并登录。在「执行器」页面为本机创建密钥，复制仅显示一次的值。
2. 将 `.env.example` 复制为 `.env`，将 `YOUTAST_URL` 设置为自己的应用地址，把 `YOUTAST_TOKEN` 的占位值替换为刚生成的密钥。不要把 `.env` 上传到仓库或发到聊天中。
3. 在本目录启动：

```bash
docker compose up -d --build
docker compose logs -f
```

Linux/macOS 可先运行 `chmod 600 .env`，限制文件权限。Windows 可通过编辑器修改 `.env`，不要把密钥直接写入命令行历史。

后续在其他机器解压同一个包，使用各自的执行器密钥即可。`restart: unless-stopped` 会在 Docker 重启后恢复执行器；是否随系统启动取决于该机器的 Docker 服务配置。

```bash
# 停止
docker compose down
# 升级依赖并重新构建
docker compose build --pull --no-cache
docker compose up -d
```

镜像以非 root 用户运行，文件系统只读，临时音频与缓存位于有容量上限的 `/tmp`。处理结束删除临时音频。当前开发机器未安装 Docker，因此镜像构建仍需在目标机器验证。

## 不使用 Docker

安装 Python 3.11+、FFmpeg，以及 Node.js 22+ 或 Deno 2.3+。创建虚拟环境并安装：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -U -r requirements.txt
export YOUTAST_URL='https://your-worker.workers.dev'
read -rs -p 'Executor token: ' YOUTAST_TOKEN; export YOUTAST_TOKEN; echo
.venv/bin/python agent.py
```

PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U -r requirements.txt
$env:YOUTAST_URL = 'https://your-worker.workers.dev'
$executorSecret = Read-Host 'Executor token' -AsSecureString
$env:YOUTAST_TOKEN = [System.Net.NetworkCredential]::new('', $executorSecret).Password
.\.venv\Scripts\python.exe agent.py
```

不使用 Docker 时，`.env` 不会自动读取，请按上面的命令设置环境变量。关闭终端或按 Ctrl+C 会停止执行器；长期运行可由机器管理员配置系统服务。

## 运行说明

- 单进程按网页设置最多处理3个任务；同一用户所有机器共享并发与启动间隔限制，默认总并发1。空闲时退避轮询，最多间隔约5分钟。不同进程通过云端原子领取操作协调。
- 租约每分钟续期，失联 10 分钟后可重新领取；失败会退避，最多尝试 3 次，可在网页手动重试。
- 默认优先原始AAC免转码封装M4A；按语言优先级选音轨，AAC不存在或原文件超过88 MB时，回退AAC编码。节省空间模式始终编码AAC，MP3模式供旧播放器兼容。转码默认64kbps，可在用户或频道设置选择48/64/96/128kbps；原始AAC不受转码码率约束，可能比64kbps MP3更大。视频最长3小时，较高码率会按 90 MB 输出上限提前缩短允许时长。源下载上限 250 MB、上传最长 10 分钟。
- 文字语言通过 YouTube 的本地化元数据选择，未提供译文则保留原文；不会按此设置选择配音音轨。已存在音频可只刷新标题、简介、封面和章节，不重新下载音频。协议版本 2 支持新设置及元数据任务。
- 工作机器必须能正常访问 YouTube。若要求人机验证或登录，可以配置下面的本机 cookies 文件；执行器不会自动读取浏览器会话。
- 应用存储默认全站 8 GB、每用户 2 GB，受 Cloudflare 账号共享免费额度和用量影响，不能保证账号永不收费。

撤销某台机器时，在网页「执行器」页面撤销其密钥，再停止进程或容器。

## 本机 YouTube cookies

按 [yt-dlp 官方说明](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) 在浏览器中登录，并导出仅含 `youtube.com` 的 Netscape `cookies.txt`。文件只保存在可信执行器机器上；不要上传到 Cloudflare、Git 或聊天。账户会话可能过期，失效时重新导出。官方也提醒使用账户下载可能导致账户被限制，建议采用单独的会话并控制请求频率。

直接运行 Python 时，通过环境变量指定本机文件的绝对路径，再启动执行器：

```powershell
$env:YOUTAST_COOKIES_FILE = 'C:\private\youtube-cookies.txt'
.\.venv\Scripts\python.exe agent.py
```

项目自带 Windows 后台启动器时，将 `YOUTAST_COOKIES_FILE=文件绝对路径` 加入 `.secrets/windows-executor.env` 后重启执行器。执行器为每个任务创建临时 cookies 副本，yt-dlp 的更新不会覆盖用户的原始导出文件；这不保证已被 YouTube 撤销或轮换的会话仍能使用。cookies 按域名规则发送；应用 API 的请求器不加载该文件。不会将 cookies 文件、下载元数据或原始错误日志上传给应用。Docker 使用者可只读挂载原始秘密文件并设置对应环境变量；默认 compose 不挂载会话文件。

## 下载仍返回 403 时：本机 PO Token

部分视频在 cookies 可用时仍需要 PO Token。按 [yt-dlp 官方指南](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) 推荐的方案，当前 Windows 已验证 `bgutil-ytdlp-pot-provider 2.0.2` 的本地脚本模式可下载公开视频 `eH0yNDJJ74s`，生成约 22 分钟的 MP3。脚本模式无需开放监听端口。

1. 在执行器虚拟环境安装可选依赖：`python -m pip install -r requirements-pot.txt`。
2. 按 [provider 官方说明](https://github.com/Brainicism/bgutil-ytdlp-pot-provider#installation) 安装版本 2.0.2 的 Node provider，构建其 `server/build/generate_once.js`。需要 Node.js 22+。本机安装已应用兼容的依赖安全修复，生产依赖审计为 0 项。
3. 设置 `YOUTAST_POT_PROVIDER_HOME` 为 provider 的 `server` 目录绝对路径。Windows 后台模式将此设置写入本机 `.secrets/windows-executor.env` 并重启；直接运行 Python 时设置同名环境变量。

启用后使用 `mweb` 客户端及本机 PO Token 插件；cookies 仍只在本机读取。Node provider 和其缓存不包含在公开 ZIP 中；安装包只提供可选 Python 依赖清单。默认 Docker 配置尚未集成此可选 Node provider。

若应用返回 Cloudflare Error 1027，表示服务计划的每日请求额度耗尽。执行器会等待 UTC 零点（北京时间 08:00）重置，网页也会显示明确提示。这与 YouTube 的登录验证或 403 是不同的问题。

## YouTube 请求控制

在网页「执行器」页面设置同一用户全部机器共享的并发数和任务启动间隔。默认1并发、60秒启动间隔、提取请求间隔2秒、下载前等待10–20秒。Cloudflare原子分配限制跨机器并发，执行器最多运行3个任务线程，每任务独立临时目录与cookies副本；下载分片并发固定1。设置仅作用于新任务，降低并发或暂停不杀死已有任务。验证/限流会让账号进入冷却，修复网络/cookies后可在网页恢复。旧安装请下载新版包并重启；源码升级也要重启已运行的进程。提高并发需要足够CPU、内存和临时空间；Docker默认/tmp上限768MB。限速不能保证避免YouTube验证。

## 合并来源取最新N

新版支持1–100的自定义候选数量，并上报X-Executor-Content-Control:1。开启最新N后，作者列表会提取相对发布日期；不会为了给不活跃作者补名额去下载旧视频。由Cloudflare汇总全部扫描结果并选取频道内最新N后分配转换，下载仍遵守共享请求限制。列表的相对日期仅近似，音频转换完成后以完整元数据日期校准；playlist按列表顺序取候选。旧安装需升级并重启以支持自定义数量/最新N。所有YouTube cookies仍只保存在本机。

AAC/M4A包含原视频章节，MP4头部前置以支持流式播放与跳转。免转码复制音频包，不直连YouTube临时URL；RSS仍由私有R2提供，支持HEAD/Range、配额和撤销。已有MP3不会自动重下/转码。新版上报X-Executor-Audio-Control:1，旧执行器不会领取M4A转换任务，升级后需重启。

AAC转码声道/采样率遵循Apple RSS建议：48kbps为24kHz单声道，64/96kbps为48kHz单声道，128kbps为48kHz、最多双声道（不把单声道上混）。原始AAC免转码时保留声道/采样率/响度，不强制重新编码做音量归一。参考 https://podcasters.apple.com/support/893-audio-requirements 。

## 自动收录直播回放

作者/streams列表会定期扫描，只有直播结束且回放有有限时长后才收录；is_live、is_upcoming、post_live不会下载。单条直播链接未就绪时按频道同步间隔继续检查，通常默认6小时，不占用长时间录制任务。原限制3小时/90MB仍有效。新版上报X-Executor-Replay-Control:1；旧执行器不会领取直播列表或待回放扫描。源视频与回放仍按视频ID去重、按频道最新N筛选。
