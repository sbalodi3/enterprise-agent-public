# 理赔工作台

[English](README.md) | 中文

通过 Entra Local 登录后直接进入 Agent Chat。Chat 打开标准 harness agent（智能体）和个人工作区。Workbench 打开理赔员获准访问的案件、报案受理件、收件箱和审核项。**Overview** 下的理赔助手每次处理一条选定的记录。

要向观众演示合成 JURIS、合作方工资证明交换、报案通话录音和交互式案件时间线，请参阅[理赔服务集成演示](showcase/README.zh.md)。

<a id="start-the-demonstration"></a>

## 启动演示

在仓库根目录使用 Node 24 和[本地部署指南](deploy/README.zh.md)中的容器引擎运行以下命令。默认配置会构建 Linux harness 镜像，创建私有的本地凭据，配置演示专用的 Entra 员工目录，并启动支持回放的工作台。

```sh
node claims/deploy/up.mjs
```

打开[应用](http://localhost:3080)并登录。选择 Maya Chen 或 Alex Rivera 以理赔员身份进入，或选择 Jordan Lee 查看主管的案件组合。若要让两个身份同时保持登录，请使用独立的浏览器配置。

如需完整演示，先一次性下载固定版本的 Qwen3-4B Q4_K_M 权重，再启动可选服务。下载器会校验 SHA-256。可以通过 `CLAIMS_MODEL_URL` 和 `CLAIMS_MODEL_ID` 配置本地模型端点。

```sh
node claims/deploy/download-model.mjs
node claims/deploy/up.mjs --story --observe --model
```

容器使用命名卷持久保存 PostgreSQL 数据、Temporal 历史记录和原生 harness 会话。重启 Web 宿主会结束浏览器登录会话。部署详情、镜像固定版本、卷的行为和操作命令见[本地部署指南](deploy/README.zh.md)。

## 使用桌面聊天和本地文件夹

集成演示也可以在 Workbench 侧边面板和托管 Chat 中与理赔助手实时对话。两个界面使用同一份受保护的 transcript（文本记录）和同一组只读工具。有关本地启动、选择员工和查阅原始证据的步骤，请参阅 [WC-103 对话演示](showcase/README.zh.md#use-the-claims-agent-from-either-page)。

所有员工通过同一个工作台地址登录并打开 `/chat`。每位员工拥有独立的聊天记录和持久化文件卷。工作区工具按需启动专用沙箱。输入 *What are my open auto claims?* 可查看分配给自己的未结个人车险和商业车险案件。追问 *How many of those?* 可获得全部匹配案件的数量，包括后续页面中的案件。*List all open auto claims* 会查询自己有权查看的所有未结车险案件。也可以单独查询个人车险、商业车险、今日到期或等待中的案件。选择卡片中的案件即可打开其工作台概览。刷新工作台后，同一聊天中的卡片也会更新。如需模型现场回答，启动上面启用了模型的服务。在 Chat 侧栏选择 **Workbench** 可在同一窗口查看理赔工作台。在侧栏选择 **Return to chat** 可恢复当前会话的草稿、附件和正在生成的回复。选择 **Ask agent** 可打开当前案件或个人案件组合的 Workbench 助手。选择 **Open in Chat** 可在 Chat 中继续该对话。再次打开 Workbench 时会恢复上次有权访问的记录和标签页。退出会结束两种模式的访问，并关闭浏览器中正在使用的聊天连接。

输入 *Do I have any open action items?* 可查看 Workbench 中分配给自己、可以处理的工作，以及收件箱中尚未回答的问题或待办事项。没有完成记录的请求单独列出，不计入已确认的待办总数。输入 *Show my unread notifications* 可查看 Workbench Inbox，输入 *Show unread email in my Outlook inbox* 可查看已连接的 Outlook Mail 中的未读邮件。查看列表会保留消息的已读或未读状态。如果只提到收件箱且两个来源都可用，可以在聊天中选择来源。

要使用 Mac 上的文件夹，运行可选的本地配套程序。先按根目录包 manifest（元数据清单）中指定的版本，使用 `pnpm install --frozen-lockfile` 和 `pnpm run build` 构建一次仓库。在宿主机终端中运行：

```sh
CLAIMS_DESKTOP_USER=maya node claims/runtime/launch.mjs --desktop-chat
```

工作台的 `/open-companion` 入口可打开 Mac 聊天。保持配套程序运行，以 Maya 身份登录即可进入本地 Agent Chat。如需手动附加案件，点击 **Workspace Write** 旁的 **Choose scope**，选择整个案件或指定文档，再点击 **Apply scope**。固定后，agent 就能在这次对话中使用所选的案件信息。也可以直接在提问中点名案件。Chat 会将匹配到的案件标为 **Current**，后续可继续追问。查询案件组合时，已固定的案件仍会保留。在 Chat 内点击 **New session** 可开始另一段对话。选择 **Add workspace**，找到文件夹（也可使用 **Edit path**），再点击 **Open**。原生 agent 使用当前操作系统账户的权限访问该文件夹。配套程序复用同一套 Entra Local 登录，将聊天状态保存在 `.desktop-chat-home/<employee subject>`。托管聊天和工作站聊天各自保存历史记录。已配对的独立聊天配置仍保留在磁盘上原来的主目录中。

工作站默认分配给 `maya`。可将 `CLAIMS_DESKTOP_USER` 设为相应员工的演示 ID 以更改分配。其他已登录的员工使用各自的托管聊天。配套程序停止后，**Chat** 打开该员工的托管工作区。启用模型的服务通过回环端口 3082 向工作站提供模型推理。托管 Chat 按请求验证工作台会话，普通聊天和理赔聊天均无需启动员工容器。

<a id="connect-outlook-mail"></a>

## 连接 Outlook 邮箱

在 Chat 侧栏打开 **App connections**，为 Microsoft Outlook 打开 **Allow agent access** 并确认。选择分配给当前员工的工作账户。服务器确认可以访问该邮箱后，卡片会显示经过验证的地址。返回 Chat，选择 **Outlook Mail**，输入 *Find emails about the Westfield invoice*。点击邮件主题即可阅读，也可以输入 *Open the second one* 打开结果中的第二封邮件。关闭开关会停止读取，包括尚未完成的请求。已返回的回答保留在该员工的 Chat 历史记录中。

默认搜索优先返回标识符或主题短语完全匹配的邮件，匹配程度相近时优先显示较新的邮件。使用 *latest* 可按收件时间排列已索引的匹配项。*Recent* 指浏览器所在时区内含今天在内的最近 30 个日历日。明确指定的日期优先。若只返回部分结果，界面会提示缩小搜索范围。要起草邮件，请取消选择 **Outlook Mail** 并使用普通输入框。起草邮件不会读取邮箱。

### 运行本地 Outlook 模拟器

从仓库根目录安装固定版本的 [Inbox Zero Emulate](https://github.com/inbox-zero/emulate) 测试依赖。使用 Node 24，并保持第一个终端中的模拟器运行。每次运行使用一个新的私有目录。

```sh
npm ci --prefix claims/tests/outlook-emulator
mkdir -m 700 "$TMPDIR/outlook-demo"
node claims/tests/outlook-emulator/lab.mjs --docker --app-origin http://localhost:3080 --write-env "$TMPDIR/outlook-demo/local.env"
```

在 macOS 上使用 Podman 时，将 `--docker` 改为 `--podman`，并在应用终端中设置 `CONTAINER_ENGINE=podman`。

在第二个终端加载生成的配置，使用“启动演示”中下载的权重启动启用了模型的演示。以 Maya 或 Alex 的身份登录，然后在本地登录窗口选择对应的 `@example.test` 地址。两位员工的发票编号不同。重启模拟器会生成新的身份和凭据，请用新配置重启工作台并重新连接邮箱。

```sh
set -a
. "$TMPDIR/outlook-demo/local.env"
set +a
node claims/deploy/up.mjs --model
```

要在 CMS-MCP 演示中使用 Outlook，先准备[固定版本的案件快照](showcase/README.zh.md#explore-cms-mcp-claims)。在模拟器命令中加入 `--cms` 并使用 `--app-origin http://127.0.0.1:3180`。加载生成的配置后，运行 `node claims/deploy/up.mjs --showcase --cms-mcp --model`。20 名 CMS 理赔员分别收到其十起来源案件的往来邮件和审核进展。选择任一理赔员，打开 **App connections**，使用该员工的合成邮箱地址授权。从 Workbench 复制案件编号，然后输入 *Find my Outlook emails about CLM-000020*，并将示例编号换成复制的编号。在普通 Chat 中查询案件状态时，应用会按该员工的理赔权限读取记录。Workbench 转派会更改案件访问权限。原收件人的现有邮件仍保存在其邮箱。

模拟器负责 Microsoft 登录、令牌刷新和邮箱读取。[本地 Graph Search fixture](tests/outlook-emulator/graph-fixture.mjs) 为同一合成邮箱生成按收件时间排序的搜索响应。要运行[邮箱隔离测试](tests/outlook-emulator/integration.test.mjs)，将 `CLAIMS_TEST_DATABASE_URL` 设为一次性 PostgreSQL 数据库的连接地址，然后运行 `npm --prefix claims/tests/outlook-emulator test`。CMS 测试默认读取已准备好的 `.artifacts/claims-showcase/cms-mcp/snapshot.json` 文件。也可使用 `CLAIMS_CMS_TEST_SNAPSHOT` 提供其他绝对路径。Microsoft 租户的授权、索引以及 Outlook 网页链接需要在租户中单独验证。

工作台负责保管 Microsoft 客户端机密和令牌加密密钥。部署到租户时，将工作台的 `/claims/connections/microsoft/callback` 注册为 Web 重定向地址，启用委托权限 `Mail.Read`，并配置员工身份与 Entra 对象 ID 之间的固定映射。[服务器配置](connections/oauth.mjs) 定义了所需的设置。每个[助手操作](connections/operations.mjs) 都声明其所需的应用授权。[Graph 传输层](connections/graph-client.mjs) 会在每次 HTTP 调用前检查授权，包括重试。要添加日历、Teams、文件或人员资料，请注册相应操作，并请求对应的委托权限范围和令牌受众。Work IQ 适配器必须在服务器端构建资源路径，并明确发送已启用数据源的非空列表。日历事件权限允许读取事件及其与会者。会议聊天、转录和录制内容分别需要相应权限。若提供方将 OneDrive 与 SharePoint 的结果归为一组，可使用同一个 Files 开关。启用适配器前，应确认租户同意、数据源限制和计费要求。[Work IQ 检索和前置条件](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/retrieve)

## 完成一个班次的工作

1. **以 Maya 的身份分流。** 在 **Must act this shift** 下打开 **WC-101**。该案的回电截止时间解释了它为何排在未匹配的受理件和等待工资证明的请求之前。比较按规则和按截止日期排序的视图。查看记录时刷新，只要记录仍可见，选中状态就会保留。
2. **询问单个案件。** 打开 **Evidence & timeline**，阅读案件日志，再使用 **Overview** 下的助手。选择 **Replay fixture** 或 **Local model**。优先级说明、证据对比、时间线和交接是不同任务。现场生成优先级说明时，模型选择并排列记录中的事实。工作台提供确切的截止时间和来源引用。现场对比时，模型选择段落，服务器逐条对照原文验证引文。保存的结果保留创建者、案件修订版本、配置发布版本和运行模式。
3. **准备多份交接草稿。** 选择多行记录并准备交接。每条选中的记录都单独检查授权，使用独立的 harness 会话。运行失败时会指出受影响的工作项。交接内容是草稿。
4. **在退出后接收工作。** 用专用的生产方凭据投递语音报案 fixture（测试前置数据），然后使用相同的事件 ID 再投递一次。重新打开 **Inbox**，检查通话文本和时间线。重试后只保留一条待办。团队受理模式允许理赔员认领工作项。同事可以围绕共享记录互发问题和答复。[Fixture 入口约定](integrations/README.zh.md)
5. **移交案件。** 打开 Maya 负责的一条记录，将其移交给 Alex。分别刷新两个浏览器。Alex 可以执行后续操作。Maya 先前查看的详情、证据和已保存的回答均要求当前仍具有访问权。旧提案不能授权对新修订版本的写入。
6. **运行工资核验工作流。** 启动场景服务后，以案件负责人的身份打开 **WC-102**，选择 **Request wage evidence**。在 **Reviews** 中投递模拟的合作方回调。待 worker 处理后刷新，检查确切的拟议更改及其摘要，再决定批准或拒绝。演示恢复时，先在 **Demo controls** 中启用 **Lose next approval acknowledgement**，再批准并刷新以查看未知结果，随后请求核对。确认回执标识唯一一次生效的模拟操作。操作记录和邮箱都区分等待中、结果未知和已确认三种状态。
7. **评估分流。** 对显示的决策集合记录反馈、打开证据并准备审核。以主管身份打开 **Demo controls**，评估合成排序。检查在指定审核量下的召回率和精确率、遗漏的必办工作、标签覆盖率、有争议的标签，以及到首次匹配操作为止的实际耗时。比较不同排序的耗时时，每种排序都需要相应的观测数据。

## 工作台如何使用 harness

| 部分 | 实现 | 示例 |
| --- | --- | --- |
| 配置 | 版本化的部门 manifest 定义主体类型、允许的工具、流程、模型别名、评估规则和证据策略。生成的 dsh 组合载入其预设。 | 员工选择案件或报案受理件后即可发起一次 Claims 运行。[Manifest](profiles/claims-v1.json) |
| 插件 | Cordis 插件提供服务或界面功能，并负责其生命周期。 | 浏览器准入插件将 Entra Local 身份绑定到权限受限的对端。工作台插件注册 HTTP 路由，以及原生主面板和侧栏入口。[准入](auth/README.zh.md) · [工作台插件](runtime/plugin.mjs) |
| 工具 | 模型可以在一次限定范围的会话中请求的具名操作。 | `compare_evidence` 读取选定版本中获准访问的摘录。模型无法通过提供另一个案件 ID 来切换目标。[助手](runtime/assistant.mjs) |
| 钩子 | 在既有循环的指定阶段执行检查。 | 步骤开始前的钩子重新检查会话、授权和修订版本，并限制运行规模。工具守卫限制调度。每次读取还会再次检查工作项。 |
| 自动化 | 理赔员离线时也能继续推进的持久化流程。 | Temporal 启动工资证明请求，等待 fixture 回调和人工审核，然后调用领域服务。确认消息丢失时，显式查询回执即可核实结果。[工作流](worker/workflows.mjs) |
| 集成 | 来源或目标系统的适配器，拥有独立的身份、约定和去重规则。 | 语音、日历、Jira、Azure Boards 和 A2A 式更新通过合成事件回放。获得经批准的系统约定后，可以替换来源适配器。 |

API 根据浏览器会话识别员工。数据库返回数量、证据或回答前，会检查工作项的分配、团队成员资格和租户。审批记录确切的提案版本和摘要。worker 轮询事务发件箱。实际执行操作前，领域服务再次检查审核人、当前分配、版本和载荷。即使模型不可用，这些规则也生效。

基础演示运行 Claims。集成演示还提供 Legal Matters 和 Finance Billing Review，各部门拥有自己的记录、工具和审批流程。每个助手在返回已保存的回答前都会检查员工的访问权和来源修订版本。法务与财务演示通过经过审核的 A2A 请求关联两条分别由各自部门负责的记录。[演示步骤](showcase/README.zh.md#present-legal-matters-and-finance-billing-review)

## 链路跟踪与学习

运行 span 包含静态操作名称、耗时、状态以及使用不透明标识符的链接。路由决策还会记录分类器版本、意图、置信度档位、动作和附件数量。本地 Collector 会核对这些字段，移除其他 span 属性、事件和自由文本状态后再转发给 [Jaeger](http://localhost:16686)。选择服务 `claims-workbench`。工资核验请求的准入跟踪记录关联 worker 活动和后续审核，审核跟踪记录关联调度和核对。PostgreSQL 在单独的操作台账中保存确切的审批和回执。原生 harness 会话日志包含模型可见的合成证据，保存在应用的私有卷中。Claims 组合禁用内置会话遥测和反馈上传。

主管调用 `GET /claims/api/dataset` 会得到 `POST /claims/api/evaluate` 使用的版本化合成决策记录。记录保留获准访问的候选项、排序、实际展示给用户的项目、后续操作和独立的 fixture 评估。并列时采用稳定次序。覆盖率统计会标明缺失或有争议的判断。演示评估两种可检查的排序。明确业务目标、获得有代表性的标签并确认训练权利后，可以评估 CatBoost 等开源监督排序模型。

## 部署路径

| 本地组件 | 企业集成点 | 部署前工作 |
| --- | --- | --- |
| Harness Web 宿主和 worker | ECS Fargate 和获准的 API 网关 | 配置员工和服务身份、密钥轮换、会话共享、租户隔离和恢复。 |
| PostgreSQL 和本地 fixture | RDS、受治理的理赔与数据 API，以及获准的证据存储 | 确立案件访问权、权威版本、保留、审计及备份策略。 |
| 本地 Temporal 开发服务器 | 受支持的 Temporal 部署，或重新设计的 Step Functions 工作流 | 在真实负载下测试重试上限、回调约定、故障转移和运维人员介入。 |
| 本地 Qwen/llama.cpp | 企业路由后的获准公司模型 | 用经过理赔员审核的案件评估引用准确性、拒答、费用和延迟。 |
| Fixture 入口和模拟器 | 经验证的合作方 A2A 交换、语音报案、日历、任务看板和权威记录系统命令 | 就合作方 schema 与身份、带签名的证据、幂等性、审批和目标系统回执达成约定。 |
| Collector、Jaeger 和 SQL 台账 | 企业遥测和独立治理的证明机制 | 分别管理 span、操作证据和学习数据集的访问、完整性和保留期限。 |

演示使用虚构案件。基础应用的本地启动不依赖计划中的 JURIS mock、相邻 A2A 仓库或企业账户。harness 的 [MIT 许可证](../LICENSE)和[第三方声明](../THIRD_PARTY_NOTICES.md)随代码提供。模型权重和容器镜像分别遵循各自的许可证。

## 开发上下文和隐私

[上下文清单](docs/developer-context.md)列出 Codex、Claude Code、Chat 和 Workbench 各自加载的内容。[出站数据审计](docs/security-audit.md)列出目的地、载荷和触发条件。[隔离运行时观测](docs/runtime-evidence.md)和[构建上下文检查](docs/artifact-check.md)记录已测试的配置。Enterprise Chat 和 Workbench 禁用上游分析和反馈上传，也禁用面向 DeepSeek 官方模型请求的原始会话日志扩展。若配置 DeepSeek 搜索，系统只发送搜索查询，原始问题选项处于关闭状态。

## 检查点与验证

[本地调度测试](tests/local-dispatch.test.mjs)覆盖中断的审批。[启动器测试](tests/launch-protection.test.mjs)检查启动时能否保留已有的自定义配置。[身份验证测试](auth/auth.test.mjs)覆盖会话撤销，[工作服务测试](domain/tests/work.test.mjs)检查重新填充初始数据时能否保留已有工作。

从仓库根目录运行命令。运行源码测试前须构建 harness，并按照两个 Claims npm 锁文件安装依赖。全栈验收需要 Compose 的 story、observe 和 model 配置。工资核验场景测试会为 WC-102 创建合成的审核和回执。

| 检查点 | 可执行验证 |
| --- | --- |
| [本地平台](deploy/README.zh.md) | `node claims/deploy/up.mjs` 启动原生 Web 界面并持久保存预置记录。 |
| [身份与访问](auth/tests/browser.acceptance.mjs) | `node claims/auth/tests/browser.acceptance.mjs` 以两名用户的身份登录，验证记录和会话隔离。 |
| [案件组合与记录审核](ui/tests/workbench.browser.mjs) | `node claims/ui/tests/workbench.browser.mjs` 使用 fixture 响应测试导航、选择、批量操作和渲染。 |
| [邮箱与集成](integrations/fixtures.test.mjs) | `node --test claims/integrations/fixtures.test.mjs` 验证入口身份和回放。数据库用例需要提供指向可丢弃数据库的 `CLAIMS_TEST_DATABASE_URL`。 |
| [助手工具与审核](auth/tests/browser.acceptance.mjs) | `CLAIMS_ACCEPTANCE_LIVE=1 node claims/auth/tests/browser.acceptance.mjs` 通过原生面板测试明确标注的回放模式和配置的模型。 |
| [持久化工作流](worker/tests/recovery.test.mjs) | `TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix claims/worker run test:integration` 测试信号回放和 worker 重启。另设 `CLAIMS_TEST_RESTART_SERVER=1` 可在测试中重启演示的 Temporal 服务。 |
| [链路跟踪与评估](tests/story.browser.mjs) | `node --env-file=claims/deploy/.env claims/tests/story.browser.mjs --observe` 从浏览器审批一路跟踪到回执，并在 Jaeger 中验证其准入链接。 |

要运行针对性测试，请使用 Node 24 执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
npm --prefix claims ci --workspaces=false --ignore-scripts
npm --prefix claims/worker ci --workspaces=false --ignore-scripts
npm --prefix claims test
npm --prefix claims/worker test
```

如果提供了 `CLAIMS_TEST_DATABASE_URL`，PostgreSQL 测试会创建隔离的 schema，并在结束后删除。未提供时，测试会报告跳过的集成用例。浏览器验收通过 Playwright 使用本地 Chrome，读取生成的演示凭据且不打印。

### Claims Chat 实现审查

| 审查项 | 发现和改进 | 验证 |
| --- | --- | --- |
| 身份和访问范围 | 托管 Chat 用拥有者凭据执行工作区操作。受限的理赔桥接服务转发员工会话，验证网关分配关系，并在交付受保护内容前重新检查登录状态。 | 网关和 BFF 测试，并让 Alex 和 Maya 分别在独立浏览器中登录。 |
| 检索和引用 | Chat 读取案件组合时不记录队列浏览事件。在恢复的 WC-103 对话中，模型有时只读取一段提及事故日期的原文。验证器通过同一条受范围限制的 MCP 连接读取缺失段落，并在 Activity 中注明该读取操作。 | 可丢弃的 PostgreSQL 数据库检查、WC-103 的 MCP 快照，以及在恢复的对话中询问日期后能否从两份文档的引用打开相应段落。 |
| 侧边面板和托管 Chat | 窄侧栏会遮挡面板，较早发出的刷新响应可能覆盖更新结果。在窄屏上，紧凑面板改用模态窗口，并丢弃已被更新请求取代的读取结果。 | 浏览器检查覆盖两种宽度、草稿恢复、段落高亮和人为颠倒到达顺序的两个响应。 |
| 对比与恢复 | 重试复用原始请求 ID。建议对比前，Chat 会逐项检查点名的案件。若恢复对话后询问案件组合中今天的所有截止时间，即使模型重复先前消息中的案件 ID，也会检查完整的请求范围。读取文档时如果省略案件 ID，则必须能够在已确认的选择中唯一确定文档。 | 并发提交、中断尝试、重新分配，以及点名对比和恢复对话后查询截止时间的 MCP 测试。 |
| 实际部署 | 同时运行两份模型超出了 Docker 虚拟机的可用内存。集成演示可以共用已有的本地模型进程。活动路由通过 Kong 传输流，流停滞时通过经过授权的刷新恢复。 | 在线浏览器演示覆盖两份 PDF、追问时间线、退出和恢复、依据班次时间查询案件组合，以及确认对比 WC-103 和 WC-104。 |
