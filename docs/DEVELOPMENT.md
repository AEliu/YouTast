# 开发与测试

## 环境与启动

网页/API 需要 Node.js 22+、npm 和 Python 3.11+（`npm run check` 包含 Python 编译检查）。执行器及媒体测试还需 FFmpeg、FFprobe、`executor/requirements.txt`，以及 Node.js 22+ 或 Deno 2.3+。npm 使用提交的锁文件安装；Python 依赖目前是最低版本约束，不是完整锁定环境。

在仓库根目录执行，已有配置时不要重复复制覆盖：

```powershell
npm ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars 的邀请口令；真实部署资源只写入本机 wrangler.jsonc
npm run db:local
npm run dev
```

打开 <http://127.0.0.1:8787>。执行器安装见 [executor/README.md](../executor/README.md)。本地 Cron 不自动执行，需 Wrangler scheduled 测试入口；生产每 15 分钟检查到期任务。不要将本机执行器指向临时测试服务，以免影响真实任务。

## 代码导航

| 目录或文件 | 职责 |
| --- | --- |
| `src/worker.js` | Worker 路由、身份校验、任务租约、RSS/媒体、Cron |
| `src/admin.js`、`src/invitations.js` | 后台账号/配额与邀请码 |
| `src/preferences.js`、`src/sorting.js` | 默认值、范围、音频 profile 与排序 |
| `src/episode-window.js`、`src/storage-policy.js` | 最新 N 与空间回收 |
| `src/audio.js`、`src/channel-detail.js` | 媒体类型与频道详情分页 |
| `public/` | 原生 HTML/CSS/ES Modules；无前端框架 |
| `executor/` | 主动轮询的 Python 下载/转码执行器 |
| `migrations/` | D1 schema、索引、触发器、视图；当前到 0015 |
| `tests/`、`scripts/` | 回归、打包、诊断与实例运维 |

架构、接口与已知问题详见 [HANDOFF.md](HANDOFF.md)。优先从相关模块与迁移阅读，不要只改前端显示而忽略服务端校验、能力门禁与 SQL 约束。

## 无服务离线检查

```powershell
npm run check
npm test
git diff --check
# 安装执行器依赖并确保 ffmpeg/ffprobe 在 PATH 后：
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'executor_*.py'
```

Linux/macOS 使用 `.venv/bin/python`。unittest discovery 只收集 unittest 用例，**不会运行** `executor_processes.py` 中的双进程集成 main。媒体用例调用真实 FFmpeg，其 YouTube 输入是离线 fixture；不需要云端凭据，不证明真实 YouTube 可用。

基础 CI 在 Linux 运行语法检查、JS 单元和 Python 离线用例；不自动部署，不使用生产凭据，不运行真实 YouTube 或实体播放器验收。

## 本地 API 集成

这些脚本会创建账号/频道、上传占位音频或直接修改本地 SQLite。请在独立克隆中运行，或明确核对各脚本的 `--persist-to` 与 Worker 状态目录一致。仅更改服务端状态目录而不改脚本，会让请求和 SQL fixture 指向不同数据库。不要并行运行共享数据库的脚本。

在独立测试克隆中，准备被忽略的 `test-results/` 目录并启动服务：

```powershell
New-Item -ItemType Directory -Force test-results | Out-Null
npm run db:local
npx wrangler dev --ip 127.0.0.1 --port 8787 --var REGISTRATION_INVITE:local-integration-invite-only --test-scheduled
# 另一个终端按需逐项运行：
npm run test:integration
node tests/channel_sort.mjs
node tests/channel_detail.mjs
node tests/audio_formats.mjs
node tests/live_replays.mjs
```

`local-integration-invite-only` 是公开测试口令，仅限本地。`channel_detail.mjs` 会清空本地 `login_limits`；`--keep` 保存测试凭据且保留频道，只用于临时人工检查。部分脚本只清理频道，不删除测试账号；隔离测试环境可整体保留用于排查，不要对真实用户库批量清理。

| 专项 | 环境与注意事项 |
| --- | --- |
| `tests/preferences_metadata.mjs`、`tests/sources_reuse.mjs`、`tests/job_recovery.mjs` | 先读脚本的端口、策略和本地 SQL 路径 |
| `tests/admin.mjs`、`tests/invitations.mjs`、`tests/execution_policy.mjs`、`tests/latest_cleanup.mjs` | 默认 8791 与 `.wrangler/admin-state`；部分依赖 admin 测试生成的 `test-results/admin-ui-user.json`，并非独立单测 |
| `tests/quota.mjs` | 默认 8788 与 `.wrangler/quota-state`，测试配额设 50 字节；准备命令见 README |
| `tests/storage_recovery.mjs` | 本地 D1/R2 回收专项；内含独立状态处理，先阅读脚本 |
| `tests/executor_processes.py` | 已启动的 8787 测试服务、真实 FFmpeg/FFprobe、离线 YouTube fixture，启动两个执行器进程 |

集成里的短占位字节只证明 API 契约，不能视为可播放音频。`scripts/verify-*.py`、`tests/real_youtube.py` 和 `npm run test:production` 另属真实实例/上游操作，会请求网络，部分会创建资源；不纳入默认检查。

## 验证记录

每次交付记录：提交、日期、环境、命令、结果、模拟范围、残留和未验证项。截图与原始产物保存在被忽略的 `test-results/`，公共文档只保留脱敏摘要。历史验收与本轮重新验证分开记录，不能把旧 PID 或部署版本当成当前健康证明。
