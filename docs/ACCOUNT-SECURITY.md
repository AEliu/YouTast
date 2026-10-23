# 登录密码与账号恢复

## 用户改密

在侧栏底部头像/用户名进入用户设置，输入当前密码、新密码和确认密码。新密码需为12–128字符，并与当前密码不同。成功后全部网页登录会话失效，需要用新密码重新登录。

POST `/api/auth/password` 接收 `current_password`、`new_password`，需要登录并校验同源。错误当前密码返回403，字段错误400，限流429；凭据并发变化可能返回409或登录失效401。限流沿用登录的每IP每15分钟15次尝试。

更改密码不更改执行器凭据或私人订阅令牌；可以分别在执行器和频道入口管理它们。无邮箱自助找回、2FA或自助删除账号功能。

## 管理员协助恢复

在管理后台的目标账号行选择“重置密码”，重新输入**自己的管理员密码**，生成新的32位十六进制随机密码。新密码只在本次弹窗返回，关闭后清除弹窗内容；管理员应先核实求助者身份，再通过可信方式交给账号使用者，提醒登录后自行修改。

POST `/api/admin/users/:id/password` 仅管理员可用，body为 `current_password`；普通用户403。管理员不能通过此接口重置自己，应使用用户设置改密。重置保留目标账号的角色、停用状态和数据；停用账号即使密码已恢复，仍须由管理员另行启用后才能登录。

自助改密、管理员重置均以数据库条件更新处理并发，撤销目标用户全部网页登录会话。登录写入新会话时再次核验凭据，防止旧密码在途验证与重置交错后生成仍有效的会话。审计只记录 `user.password.change`、`user.password.reset` 等动作与操作者/目标，不含密码或哈希。

## 最后一位管理员无法登录

拥有应用Cloudflare账号权限的操作员可使用CLI恢复。先核对目标配置，并部署包含登录凭据二次核验的Worker；工具不修改角色或启用状态，不重新创建用户。输出只允许是 `.secrets/` 目录直接包含的JSON文件，默认不覆盖已有文件；终端不显示密码。

```powershell
# 本地演练；状态目录必须是你要操作的独立本地环境
node scripts/recover-account.mjs --local --persist-to .wrangler/recovery-lab --username admin --confirm-reset admin --output .secrets/recovery-admin-local.json
# 真实实例：先确认本机 wrangler.jsonc 的账号/D1/Worker 目标
node scripts/recover-account.mjs --remote --username admin --confirm-reset admin --output .secrets/recovery-admin.json
```

两个模式必须明确选择一个，确认用户名必须完全一致。使用自己的目标用户名替换示例admin；不存在的账号不会创建。恢复需Wrangler具有对应D1权限，网页管理员会话不是此工具的凭据。

工具先在私密文件中落盘并同步pending计划，再做条件更新、撤销会话和写入无密码审计；成功后以新文件替换为complete记录。网络中断或执行失败不会删除pending文件，避免密码可能已更新却丢失唯一恢复凭据。

```powershell
# 仅继续同一个尚为 pending 的计划；保持同一目标与输出文件
node scripts/recover-account.mjs --remote --username admin --confirm-reset admin --output .secrets/recovery-admin.json --resume
```

续跑会识别已应用的新凭据并完成会话撤销；若账号已独立改为其他凭据，则拒绝覆盖。complete计划不能再次续跑；需要再次重置时明确使用新的输出文件。私密文件包含新密码，pending阶段也包含旧凭据摘要，仅保留在可信本机，按需要限制Windows ACL或Unix文件权限，不提交、不公开上传。

## 本轮验证

2026-10-23：无新增迁移，未修改执行器或真实用户密码。

- 语法检查、20项JS单元及本地完整integration流程通过；integration本地账号现在通过测试结束钩子按精确身份清理。
- `tests/password-race.test.js` 用真实迁移和SQLite运行Worker，在旧密码派生完成后人为暂停登录，再执行改密并恢复该请求，确定性确认旧登录无法生成会话。
- `tests/passwords.mjs` 在独立8794服务与 `.wrangler/password-state` 中验证自助改密、两会话及在途旧密码登录失效、RSS/执行器凭据独立性、管理员重新验证、停用状态保留、普通用户/Origin/输入/限流、并发条件更新和审计脱敏。
- 浏览器验证两次新密码不一致、错误当前密码仍停留表单、改密后退出及新密码登录；管理员深链接登录、重置自己的入口隐藏、错误管理员密码、临时密码登录、关闭弹窗清除凭据和390×844无横向溢出。修复登录到已有 `#admin` 深链接后管理数据未加载的关联问题。
- `tests/account_recovery.mjs` 使用唯一一次性本地D1目录验证操作员确认参数、最后管理员/停用状态不变、会话撤销、私密输出不进入日志、两种中断续跑及并发改密拒绝；测试目录和恢复文件结束后删除。
- password测试保留一个可复用的本地fixture管理员，凭据保存在按状态目录区分的被忽略 `test-results/password-admin-*.json`（仅测试用途）；正常测试账号已精确清理。不要批量删除真实账号或跨环境复用此fixture。

复验：准备专用8794服务后设置 `TEST_ORIGIN` / `TEST_PERSIST_TO`，执行 `npm run test:passwords`；`npm run test:recovery` 自行创建并删除独立本地状态，无需运行服务。原始UI截图在被忽略的 `test-results/password-settings-mobile.png`。

生产已部署 `b91c8543-65cc-4bb6-b440-469707f2c5ea`（源码 `d807ba4`）。临时普通账号完成自助改密、管理员重新验证后重置、旧密码/会话失效、新密码登录、普通用户权限和审计脱敏验证；临时频道/账号已独立SQL确认零残留。真实管理员密码未修改。现有私人RSS的HEAD、206 Range与完整解码独立复验通过。

操作员CLI随后修复远程SQL文件导入的确认及输出差异：明确传 --yes，写入不依赖导入进度文本作为JSON，而以独立只读查询确认状态。一次性本地恢复演练和生产临时普通账号恢复均通过，临时账号精确清理确认。远程文件导入可能短暂影响D1服务，应安排在低流量时操作；不能把CLI的零退出码单独当作恢复成功。

原始记录在被忽略的 `test-results/password-production.json`、`operator-contract-production.json`；首次清理输出解析失败的原始记录另行保留，独立查询确认清理后才记录通过。本轮验证不代表独立安全审计，也不包含邮箱/2FA恢复。
