# 参与开发

先读 [README](README.md)、[开发与测试](docs/DEVELOPMENT.md) 和[交接文档](docs/HANDOFF.md)。交接中的部署与运行状态是历史快照，问题仍需以源码或复验确认。

## 分支与提交

- `main` 保存主线；新工作使用 `codex/<主题>`，例如 `codex/channel-pagination`。
- 开始前检查 `git status --short` 和 `git diff`。工作区可能已有用户修改；不要重置、覆盖或自动暂存无关内容。
- 一次提交围绕一个可以说明和回退的目的。建议使用 `feat:`、`fix:`、`docs:`、`test:`、`chore:` 前缀；跨模块耦合的历史功能可作为明确标注的基线提交，不要假装恢复了原开发顺序。
- 使用具体路径暂存，再检查 `git diff --cached --stat` 和 `git diff --cached`。本地提交不等于推送、部署或发布。
- 已共享的历史用 `git revert <commit>` 追加撤销记录；不要改写他人提交或强制推送主线。

```powershell
git status --short
git switch -c codex/your-topic
# 编辑并运行适用检查后，逐个选择文件：
git add docs/DEVELOPMENT.md
git diff --cached --check
git diff --cached
git commit -m "docs: clarify local development"
```

首次克隆若未配置提交身份，请在本机设置自己的 `user.name` / `user.email`；不要在项目中写入或代填别人的身份。

## 检查与评审

提交前运行 `npm run check`、`npm test` 和 `git diff --check`。执行器改动运行 Python 离线测试，SQL/API 改动运行对应本地集成脚本。脚本的端口、状态目录和 fixture 前置条件见[测试说明](docs/DEVELOPMENT.md)。纯文档变更应检查链接、命令及源码描述是否一致。

PR 说明写清问题、行为变化、迁移/兼容影响、实际验证与未覆盖范围。模拟 YouTube、真实 FFmpeg、真实 YouTube 和实体播放器分别记录；不以离线通过替代真实客户端验收。

## 文件与凭据

`.gitattributes` 统一仓库文本换行；PowerShell 脚本检出为 CRLF，其他列出的源码为 LF。`.editorconfig` 使用 UTF-8，不要求重排现有代码。

提交示例配置与锁文件；不要提交真实 `wrangler.jsonc`、`.env`、`.dev.vars`、`.secrets/`、cookies、私人 feed、HAR、日志、数据库和测试凭据。忽略规则不能保护已经被跟踪的文件，提交前仍应检查暂存内容。更多边界见 [SECURITY.md](SECURITY.md)。

迁移仅追加新编号，不改写已应用迁移；发布和版本调整见[发布说明](docs/RELEASING.md)。
