# 理赔 Temporal worker

[English](README.md) | 中文

Cordis 的 `claims-worker` 配置管理此模块的生命周期。通过 `claims/runtime/launch.mjs` 设置 `DSH_PROFILE=claims-worker` 启动，无需另设产品入口。使用 `npm --prefix claims/worker ci --workspaces=false --ignore-scripts` 安装依赖。演示使用的私有依赖树与 pnpm 管理的包相互独立。

`startWorker({address, namespace, taskQueue, workApiUrl, serviceToken, dispatchPollMs, onError})` 返回 `{done, stop}`。默认地址为 `temporal:7233`，命名空间为 `default`，队列为 `claims-work`，轮询间隔为 2000 毫秒。必须提供 `workApiUrl` 和已解析的私有 `serviceToken`。配置在调用前解析 `WORKER_API_TOKEN_FILE` 或 `WORKER_API_TOKEN`。`onError` 接收暂时性的轮询错误，默认向标准错误输出长度受限的诊断信息。API、身份验证或 JSON 出现永久性错误时，`done` 会被拒绝。worker 启动前先检查两个发件箱；启动后会持续重试暂时性轮询错误，直到停止。投递失败的消息不丢弃，也不确认。配置须监视 `done`，释放资源时等待幂等的 `stop()` 完成。停止过程会让 worker 和轮询器处理完在途工作，再关闭连接。

`submitClient({address, namespace, taskQueue})` 将受信任的网关连接到同一个命名空间和队列。`submit({operationId})` 启动经过审核的操作，`startWage({requestId,workItemId})` 启动已经获准的工资核验请求。两者均返回 `{workflowId,runId,alreadyStarted,closed}`，Temporal 保留执行历史期间不允许复用工作流 ID。历史保留期结束后，领域服务仍通过持久化的操作和回执台账防止操作重复生效。`signalWageEvidence({requestId,eventId})`、`signalWageReview(requestId)`、`requestReconciliation(operationId)` 和 `reconcileWage(requestId)` 负责发送信号，不授予案件访问权，也不审批工作。`status(workflowId)` 查询进度，`result(workflowId)` 等待执行完成，`close()` 释放连接。标识符使用格式受限的不透明字符串。自定义的 `partnerTimeoutMs`、`reviewTimeoutMs` 和 `reconciliationTimeoutMs` 必须是正的毫秒数，最多 30 天。省略时采用部署说明中记录的工作流默认值。使用不同输入重复启动工作流并不会替换原始输入。

所有活动都通过已验证身份的内部 API 路由执行，HTTP 和活动重试次数均有限制。工作 API 负责幂等性、授权和操作生效回执。进程可能在目标系统执行操作后、活动结果返回前发生故障。即使 Temporal 能够回放确定性的工作流历史，仍须持久保存操作 ID，并在结果为 `unknown` 时显式核对。路由顺序、fixture（测试前置数据）、计时器和可执行检查见[部署与恢复](../deploy/README.zh.md)。
