# 健康诊断与备份恢复

## 只读健康检查

```powershell
python scripts/health-check.py --config .secrets/windows-executor.env --output test-results/health.json
npm run test:health
```

脚本只请求 executor/status，不领取任务。退出码：0 为正常，1 为心跳过旧、能力不足等降级，2 为配置、网络、认证或响应错误。默认心跳阈值400秒，可用 `--max-age` 调整到60–3600秒。输出只含白名单诊断字段，不包含令牌、姓名、订阅链接或原始错误正文；拒绝重定向，HTTP仅允许显式 `--allow-local` 的127.0.0.1地址。

这只证明查询时的API认证、数据库通路和最近执行器轮询，不能证明YouTube可下载、R2内容可播放、主机所有进程正常，也没有接入告警投递或账单服务。默认CI执行6项离线HTTP契约测试，不访问生产。

## 备份前提与范围

`scripts/backup-state.py` 保存一份D1 SQL快照和全部 `episodes.object_key`、`object_gc.object_key` 所引用的唯一R2对象，记录SHA-256与大小。包含账号密码摘要、私人订阅令牌等敏感数据，输出只允许新建在被忽略的 `.secrets/` 下；不会覆盖已有备份。不要提交或公开上传，异机存放时使用加密介质或加密传输。校验和用于检测意外损坏，不代表备份来源可信。

**必须先停止会改变数据或音频的操作**：执行器任务、上传、网页修改、定时同步和GC；只暂停一个执行器或看到activeJobs=0不足以保证全站静止。工具不自动修改生产策略，也不提供维护模式。确认所有写入已停止后，才传 `--quiescent`。工具拒绝运行中任务，并在复制音频前后比较引用集合，但这不能替代跨D1/R2的写入隔离，无法保证任意并发写入时的时间点一致性。

```powershell
# 独立本地状态；停止该测试服务和相关执行器后使用
python scripts/backup-state.py backup --state .wrangler/lab-state --output .secrets/lab-backup --quiescent
# 生产：先核对 wrangler.jsonc 目标并完成上述全站静止条件
python scripts/backup-state.py backup --remote --output .secrets/production-backup --quiescent --max-bytes 2000000000
```

默认音频总大小上限100,000,000字节，超出时明确提高 `--max-bytes`；可用 `--bucket` 指定实际桶名。D1需Wrangler权限，R2下载需对应读取权限；配置应包含DB和AUDIO绑定。备份不会主动删除源资源，不包含没有任何数据库引用的R2对象、Cloudflare资源配置、Secrets、YouTube cookies、执行器本地文件或完整账号账单。

缺失对象（包括GC记录引用的对象）、大小冲突、网络错误或引用变化均使备份失败。仅最后写入 `manifest.json` 且 `complete=true` 才算完成；失败目录保留供本机检查，不能拿来恢复。原始SQL导出也不是完整音频备份。

## 恢复到隔离本地环境

```powershell
python scripts/backup-state.py restore-local --backup .secrets/lab-backup --state .wrangler/restoration-lab
# 检查恢复副本；仅绑定本机，不启动执行器
npx wrangler dev --ip 127.0.0.1 --port 8798 --persist-to .wrangler/restoration-lab
```

恢复只支持**新建**的 `.wrangler/` 子目录，没有远程恢复参数，不覆盖任何现有状态。先校验所有SQL、对象、覆盖范围，再创建目标。导入后检查数据库完整性及外键，并从目标R2重新读回全部对象校验哈希；失败目标保留，不能视为完成。

恢复副本撤销所有网页登录会话、随机化执行器令牌摘要、暂停已有执行策略并清空清理锁。用户密码和频道订阅令牌仍属于敏感数据；不要把本地副本暴露到公网。后续若要恢复生产，需另行制定资源映射、访问控制、维护窗口及回滚步骤，本工具不执行这一步。

## 已执行的验证与边界

2026-10-23：`npm run test:backup` 在唯一一次性本地状态中应用全部15个迁移，备份、恢复D1和真实本地R2绑定；确认节目记录、私人feed标识和3968字节对象完全一致，旧会话/执行器令牌失效且策略暂停。验证损坏SQL、损坏音频、缺失源对象和已存在目标均被拒绝，演练目录清理。

另以只读方式导出过生产D1并验证SQL可在SQLite中载入、完整性及引用解析正常，随后删除该私密兼容性产物；当时63个唯一引用合计818,529,605字节。**未执行生产全量R2备份、生产恢复或业务播放恢复验收**。本地演练使用占位字节，不能称为可播放音频；历史生产RSS解码验证是独立证据。

目前没有定时备份、异地留存、告警投递或完整灾难恢复承诺。实体播放器、长周期运行、生产维护窗口演练仍需对应条件。

早期首次本地演练曾遇SQLite连接未关闭和导入格式问题，修复后重跑通过。该失败尝试的4个唯一隔离目录因自动审批阻止递归删除而保留在 `.wrangler/backup-*-ea38bf6fba644293b15d0e56d193ff58` 与 `.secrets/backup-drill-ea38bf6fba644293b15d0e56d193ff58`，仅含测试fixture；后续成功演练自行清理，不把早期目录保留误记为全部演练文件均已删除。
