# 全局列表、搜索与测试清理验证

日期：2026-10-23（Asia/Shanghai）。本轮从 HANDOFF 中的可执行待办推进全局分页、频道搜索和测试账号残留修复。无新增迁移，不变更音频生成策略、执行器协议或用户保留设置。

## 行为与边界

- 新增登录后 GET `/api/episodes`、`/api/jobs`，参数 `offset`（0–1,000,000 的整数）、`q`（去掉首尾空白后最多200字符），每页30条。越界回末页，空列表归零。
- 网页全局列表使用新接口，完整遍历所有可见节目与任务；旧 `/api/dashboard` 保留100条节目、80项任务摘要以兼容现有调用者。
- 节目搜索覆盖标题、视频ID、作者、简介；全局任务搜索节目或频道名称，频道任务按节目名称搜索。仅在当前用户/频道可见范围内匹配，旧缓存仍单独在 archive 分类中。
- 搜索为字面子串匹配，`%`、`_`、反斜杠不充当通配符，参数全部绑定。ASCII大小写不敏感，不提供分词、拼音或相似度排序。缺日期作者组先计算完整列表的排序依据，再过滤，搜索不会改变原有相对顺序。
- hash 保存分页与编码后的 `q`，支持复制、刷新、前进/后退。新的搜索回第一页，翻页保留查询；越界用 replaceState 修正，不追加历史。无匹配与频道无节目使用不同空态。
- 详情、排序、偏好元数据、AAC格式、直播回放、执行策略及新增列表专项使用 `tests/local-fixture.mjs`。清理仅允许本地HTTP origin，匹配本轮注册返回的用户ID和用户名，不按前缀删除，不清空 login_limits；管理员fixture不在删除范围内。详情的 --keep 只在成功后保留账号，失败仍清理。

## 已执行验证

独立本地 Worker `127.0.0.1:8793`，状态目录 `.wrangler/handoff-state`，迁移0001–0015。原8787预览数据与生产数据未用于本轮本地fixture。

| 验证 | 结果 |
| --- | --- |
| 语法检查与 JS 单元 | 19项通过，覆盖输入边界、搜索字段转义、分页链接保留查询、无匹配空态 |
| Python 离线 unittest | 32项重新通过，无YouTube请求；执行器业务代码未修改 |
| `tests/collections.mjs` | 152条节目/82项任务，所有节目无重复完整可达，超过旧100/80条截断；越界归末页、搜索35条分页、中文、字面符号、注入字符串、非法参数和跨用户隔离通过 |
| 作者缺日期排序 | 搜索排除缺日期行后，仍保留作者组原回退顺序 |
| 六项既有API专项 | channel_detail、channel_sort、preferences_metadata、audio_formats、live_replays、execution_policy通过 |
| 账号清理 | 六项专项结束后精确账号均不存在；详情注册后主动抛错并指定 --keep，同样确认零账号残留 |
| 浏览器完整列表 | 125条节目/85项任务越界修正到121–125/61–85条；旧100条摘要之外的节目弹窗正常 |
| 浏览器搜索与导航 | 搜索35条到末页5条；刷新、前进/后退、清除搜索、频道搜索零匹配均通过 |
| 窄屏 | 390×844视口无横向溢出，搜索和分页可操作；截图在被忽略的 test-results/collections-search-mobile.png，未进行实体手机验收 |

## 复验

先按 [DEVELOPMENT.md](DEVELOPMENT.md) 准备本地环境。独立测试服务与 SQL fixture 必须使用同一个状态目录：

```powershell
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/handoff-state
npx wrangler dev --ip 127.0.0.1 --port 8793 --persist-to .wrangler/handoff-state --var REGISTRATION_INVITE:local-integration-invite-only
# 另一终端
$env:TEST_ORIGIN = 'http://127.0.0.1:8793'
$env:TEST_PERSIST_TO = '.wrangler/handoff-state'
node tests/collections.mjs
node tests/channel_detail.mjs
```

上述六项专项均支持这对环境变量。测试有数据写入，不能连接生产。`collections.mjs --keep` 成功后可在本机保留浏览器fixture和私密测试凭据；正常运行和失败时按精确账号清理。旧admin/invitation等跨脚本fixture尚有保留用途，不宣称所有旧测试残留已统一处理。

## 生产发布与复验

源码 `d9c8077` 已合并推送到 main，发布版本 `a62b2e26-1079-48e1-a471-5e3bb661a9af`；发布前版本 `781c0c3f-8b37-49da-89f6-c604e43857ae`。无新增迁移、无执行器重启。执行器包内容未变，SHA-256仍为 `f81552e558d2793395fef5f3959297318f2d12da89a1330d2f589b442d01e44b`。

- 线上 app.js、list-ui.js、channel-detail.js、style.css 与发布源码逐字节一致。
- 仅在临时管理员频道插入152条元数据节目和82项已完成任务，验证完整无重复遍历、越界归末页、总数增加与原有数据一致；未上传R2音频、未请求YouTube。
- 频道作者搜索35条，越界后返回末页5条；匿名401，非法 offset 和超长搜索返回400。
- 临时频道删除后详情404，两个列表按唯一测试关键词过滤均为零条，确认本次fixture已清理。
- 独立读取既有私有RSS，1条152,492字节音频的HEAD、206 Range与FFmpeg完整解码通过。

原始结果：被忽略的 `test-results/collections-production.json`、`test-results/collections-deploy.txt` 和 `.wrangler/windows-executor/rss-result.json`。生产契约复验不替代真实YouTube或实体播放器验收。
