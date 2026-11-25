# 理赔服务集成演示

[English](README.md) | 中文

以 Maya 的身份走完一个班次。从分配给她的案件组合开始，向模拟合作方请求工资证明、回听未接来电，再展示理赔员具体批准了什么，以及 mock JURIS 中实际写入的内容。案件组合包含 14 起虚构的俄亥俄州案件，每名理赔员各负责 6 起未结案和 1 起已结案，另有两个报案受理场景。模拟班次时间为 UTC 2026 年 11 月 17 日 14:00。[场景数据](data/scenario.mjs)

可选的[工资证明研究](wage-study/README.zh.md)使用八起配对的合成案件，对比 Workbench 源材料审核和 A2UI 试点。

## 在本地启动

从 harness 仓库根目录启动。需要 Node 24、Python 3、`patch`、[部署指南](../deploy/README.zh.md)中列出的容器引擎和 Compose CLI，以及版本匹配的本地 A2A 仓库。相邻仓库的默认位置为 `$HOME/Documents/A2A/dev_a2a_aws`。如需使用其他副本，设置 `SHOWCASE_A2A_SOURCE`。启动器检查文件指纹，在 `.artifacts/claims-showcase` 下生成临时合作方构建上下文，然后启动独立的 `enterprise-agent-showcase` Compose 项目。首次构建可能需要从镜像仓库和包仓库下载依赖。[合作方构建和输入约定](partner/README.zh.md)

```sh
node claims/deploy/up.mjs --showcase
```

打开[演示入口](http://127.0.0.1:3180/open-app)。在 Entra Local 的账户列表中选择 Maya Chen。登录后进入 Maya 的工作区 agent（智能体）。在侧栏点击 **Workbench** 打开她负责的案件组合。在另一份浏览器配置中以 `alex` 登录，可以展示不同理赔员各自可见的案件。

构建镜像后，以下命令使用缓存的组件离线演示。两个理赔工作流都可以在不调用模型的情况下运行。若还要展示 Chat 现场回答，请根据[模型说明](../README.zh.md#start-the-demonstration)准备本地权重并加上 `--model`。

```sh
node claims/deploy/up.mjs --showcase --offline
```

<a id="explore-cms-mcp-claims"></a>

## 浏览 CMS-MCP 理赔案件

启用此数据集可将六个业务险种的 200 起合成案件加入当前演示。首次导入使用所选引擎本地缓存的 `docker.io/library/postgres:17` 镜像，读取[固定版本的 CMS-MCP 仓库](https://github.com/sebastianhema/CMS-MCP/tree/bfa4bfceeb0a9b73a88b7a4f7ab82704a043341e)。在 harness 仓库根目录执行以下命令，将路径替换为本地 CMS-MCP 副本的位置。

```sh
CMS_MCP_SOURCE=/path/to/CMS-MCP node claims/deploy/up.mjs --showcase --cms-mcp
```

启动器将验证过的快照保存至 `.artifacts/claims-showcase/cms-mcp/`。后续可用 `node claims/deploy/up.mjs --showcase --offline` 离线启动。重复导入相同快照会保留分派结果和文档版本。要查看 Claims Chat 的实时回答，请配置本地模型。

1. 用 **Aisha Khan** 打开[演示](http://127.0.0.1:3180/open-app)。首次导入后，她有十起未结案件。在 Workbench 搜索 **CLM-000020**，打开摘录，比较出险日期（2024 年 12 月 6 日）和报案日期（12 月 24 日）。在 Claims Chat 询问这两个日期，再打开回答引用的段落或 PDF。
2. 在另一份浏览器配置中选择 **Brandon Lee**。他最初有十起拒赔案件。在 Workbench 选择 **All claims** 或 **Closed**，查找 **CLM-000017**。源记录状态为 Denied，免赔额为 947.00。搜索 Aisha 的案件即可检查分派隔离。
3. 选择 **Claims Administrator** 可浏览所有理赔员的六个险种。二十名来源理赔员最初各有十起案件。源数据给每名理赔员分配的案件都属于同一状态，因此有十二个账户只有已关闭、已赔付或已拒赔的案件。打开时间线条目可查看来源段落。出险日期和报案日期均按日记录，摘录另行显示生成时间。

在 Aisha 的 Chat 中提问 *What are my open cases?*，选择 Cases 应用中的一行即可在 Workbench 查看案件。以管理员身份提问 *Show the organization portfolio summary by line of business.*。导入数据共有 200 起案件，账单金额合计 3,173,820.00，其中 29 起涉及诉讼。展开分组并选择案件，点击 **Ask agent → Open in Chat**，询问账单金额与免赔额，打开财务引用逐项核对。

导入器读取一次固定版本的 CMS-MCP SQL，随后 Chat 和 MCP Apps 均通过 Workbench 的鉴权接口读取案件列表、时间线、汇总和来源。转派后，当前负责人随之改变，来源摘录保留原理赔员。管理员可以监督案件。启用本地 CMS Outlook 数据后，20 名理赔员均可从 **App connections** 连接自己的合成邮箱。每个邮箱有 20 封案件邮件，覆盖该理赔员的十起来源案件。输入 *Find my Outlook emails about* 并加上 Workbench 中的案件编号即可查找邮件。[Outlook 模拟器配置](../README.zh.md#connect-outlook-mail)

启动 CMS 演示、本地模型和 Chrome 后，前两条命令检查两类角色、来源链接及管理员的交互式案件搜索。第三条验证账户目录与独立托管工作区。Outlook 检查需要启用 CMS 模拟器。`--cms-all` 验证 20 名员工的案件范围及邮箱授权。`--cms` 在 Chat 中实时运行 Aisha 和 Brandon 的 Outlook 查询。

```sh
node claims/showcase/tests/cms-portfolio.browser.mjs
node claims/showcase/tests/cms-cases.browser.mjs
node claims/auth/tests/entra.browser.mjs --showcase --cms-mcp --hosted --shared
node claims/tests/app-connections.browser.mjs --cms-all --shared
node claims/tests/app-connections.browser.mjs --cms --shared
```

执行 `node claims/deploy/up.mjs --showcase --no-cms-mcp --offline` 可隐藏导入的案件及其目录账户。原有演示和已保存的工作仍保留在现有卷上。添加 `--cms-mcp` 可重新启用数据集。

<a id="present-legal-matters-and-finance-billing-review"></a>

## 在 CMS 案件上执行操作

以 Aisha Khan 身份打开 **CLM-000020**。在 **Ask agent** 输入 *Create a note: Employer called to confirm the payroll contact.*。可以编辑、放弃草稿或点击 **Approve and add note** 批准写入。在 **JURIS record** 核对备注和回执。Chat 与 **Reviews** 共享提案。未结案件可修改处理优先级和指示，以及创建、改期或完成日程。已结、已赔付或已拒赔的案件可添加补充备注。

在 Aisha 的案件中输入 *Request wage evidence*，核对身份、日期和接收方后批准发送。点击 **Release partner evidence** 后返回一个工资期。查阅收入、缺失日期和来源，再批准归档。**CLM-000002** 演示完整覆盖。从已打开的 Outlook 邮件创建的联系备注起初是可编辑的私有摘要。

在已启动的演示环境运行 `node claims/showcase/tests/reviewed-actions.browser.mjs`，可验证跨 Chat 和 Workbench 起草、编辑和放弃提案。

## 演示法务事项和财务账单审核

用两份独立的浏览器配置打开[演示入口](http://127.0.0.1:3180/open-app)。分别选择 `finance`（Sam Patel）和 `legal`（Morgan Ellis）登录。每位员工进入本部门的助手，可同时看到本部门的 6 条合成记录。助手用配置的本地模型回答，附上有权查看的文档链接。只要来源修订版本仍有效，同一员工即可在原访问范围内重新查看已保存的回答。

1. 在 Finance 中打开 **FIN-207**，查看外聘律师发票异常。点击 **+$600 variance**，高亮重复引用的费用编号 **EXP-044**。打开来源明细或对应的 PDF。供应商发票总额为 9,000 美元，待入账账单总额为 9,600 美元。通过 **Ask agent** 询问差额产生的原因。
2. 选择 **Ask Legal to verify expense**，核对拟发送的问题和收件人后确认。在 Legal 的 **Inbox** 中打开 **MAT-017** 上的请求。打开费用授权登记簿，其中记录了一次 600 美元的批准，并标明审核人查阅了哪份登记簿。
3. 在 Legal 中选择 **Approve reply to Finance**，确认可以共享的核验结果。返回 Finance，回复会同时出现在收件箱和 FIN-207 上，引用编号为 **AUTH-600-01**。询问 **“Was a second $600 expense authorized?”**，打开回答所引用的已批准回复副本。点击 **Open billing review** 在 mock 财务登记簿中记录一次审核。检查回执，对比发票和待入账明细。出账前仍需审核人员解决这项异常。
4. 在 **MAT-017** 中通过 **Ask agent** 整理事故时间线。主管报告记载的事故日期为 11 月 9 日，交接记录称是 11 月 10 日，录入时间是 11 月 17 日。查看两个被引用的段落，再选择 **Request date confirmation** 或 **Approve factual packet**。资料包会保留两份来源之间的分歧。在 Claims 中，负责 WC-103 的理赔员会收到状态和获准共享的引用。法务内部准备笔记仍留在法务事项内。
5. 首次交换完成后，Finance 可以通过 **Request another authorization check** 进行第二次演示。凭回执可以重新打开已归档的资料包和账单审核记录。打开 **MAT-021** 或 **FIN-212** 即可展示没有关联理赔案件 ID 的工作。

本地 Legal 对端和 Workbench 经 Compose 专用网络交换 A2A 消息。跨部门传送的是获准的问题和返回的账单核验参考信息。mock 法务案卷和账单审核登记簿是本地演示的写入目标。此实现不会联系外聘律师或账单服务提供方。[A2A 交换](../portfolios/a2a.md) · [部门配置](../portfolios/profiles.mjs)

使用本地 Ollama 时，在 `.artifacts/claims-showcase/.env` 中设置 `CLAIMS_MODEL_ID=nemotron-3.5-lightning:30b-mlx`，并将 `CLAIMS_MODEL_URL` 指向容器可以访问的端点。在 macOS 上，Podman 使用 `http://host.containers.internal:11434/v1`，Docker Desktop 使用 `http://host.docker.internal:11434/v1`。模型和容器镜像准备好后，用 `--offline` 启动演示。`node claims/showcase/tests/department-chat.browser.mjs` 使用配置的模型，验证真实登录、模型现场回答、来源 PDF、已保存的历史记录和访问控制。

## 演示两个理赔工作流

### 1. 请求缺失的工资证明

1. 打开 **Workbench**，选择 **WC-102** 并阅读雇主事故报告。Jamie Rowan 的报告没有工资单附件。在 **JURIS record** 中展示初始修订版本和空的工资证明字段。
2. 依次选择 **Request wage evidence** 和 **Reviews**。核对披露内容并点击 **Approve and send wage request**。请求进入等待状态后，选择 **Release partner evidence**。这个演示控件指示合作方 mock 完成任务。点击 **Refresh** 查看随之生成的审核项。
3. 打开 **Overview → Open interactive timeline → Partner wage statement**。选择 **Open PDF** 查看与来源阅读器中相同的版本。合作方返回的是 2026 年 6 月 1 日至 14 日的工资证明，总收入为 1,830 美元，正常工时为 80 小时，加班 4 小时。这 14 天只覆盖所请求的 364 天中的一部分。向观众指出数据来源以及尚缺的期间。
4. 在 **Reviews** 中检查目标、拟写入的引文、引用来源和修订版本。选择 **Approve and file wage evidence**，然后刷新直到回执出现。在 **JURIS record** 中展示工资条目、新修订版本及匹配的回执 ID。该批准将书面证据记入案件。待遇和付款决定仍走既有流程。

### 2. 将未接来电归入正确的案件

1. 选择 **Deliver missed call**，在 **Inbox** 中打开 **IN-201 → Intake Review**。应用内附合成录音和按发言人区分的 transcript（文本记录）。点击约 0:06 处的时间戳，听来电人提及 Cedar Dock、3 号装卸区和末尾为 42 的报告编号。
2. 对比 **WC-105** 和 **WC-107**。两案都提到 River Ellis 和 Willow Harbor Supply。WC-105 的雇主报告记录的是 Cedar Dock 和 WHS-42，WC-107 记录的是 Alder Yard 和 WHS-71。来电人无法确定事故日期，匹配时应保留这个不确定点。
3. 选择 **WC-105**、选取所引用的来电人原话，然后点击 **Prepare filing**。在 **Reviews** 中核对拟归档的内容，选择 **Approve exact proposal**。刷新后打开归档目标案件，检查 **JURIS record**。通话文本引用、引文和回执应与批准内容一致。团队受理件 **IN-202** 因资料不足无法匹配，会继续排队等待跟进。

已登录的演示者也可直接打开需要授权的 [WC-102 JURIS 快照](http://127.0.0.1:3180/claims/api/items/WC-102/juris)、[雇主报告 PDF](http://127.0.0.1:3180/claims/api/media/WC-102/WC-102-report?format=pdf) 或[已投递的受理录音](http://127.0.0.1:3180/claims/api/media/IN-201/IN-201-call?format=audio)。这些地址在每次请求时都会重新检查当前员工的访问权。

<a id="use-the-claims-agent-from-either-page"></a>

## 从任一页面使用理赔 agent

使用本地 Nemotron Lightning 时，请按前文配置 Ollama 端点和模型标识。如果问题点明了有权访问的案件，Chat 可以直接打开并标为 **Current**。描述可能对应多个案件时，agent 会询问你指的是哪一个。选择 **Yes** 会继续处理原问题。选择 **No** 会在本次请求中排除该候选项。选择 **Other** 可以输入新的线索。

1. 以 **Maya** 登录，打开 **WC-101**，再打开 **Callback diary** PDF。查看器显示已获授权的文件，并提供 **Download** 和 **Open in new tab**。如果需要重新登录，登录后会返回请求的文档。
2. 在另一份浏览器配置中以 **Alex** 登录。打开 **WC-103**，选择 **Ask agent → Open in Chat**，即可在原生 Chat 中继续该案的 Workbench 对话。Chat 内的 **New session** 开始空白会话。
3. 在原生输入框中点击 **Choose scope**。搜索分配或共享给 Alex 的案件，可按未结案和已结案筛选。展开 WC-103，选中主管报告和班次交接记录，应用范围后询问 *Why are there two incident dates?*。前一份报告记载 11 月 9 日，后一份记载 11 月 10 日。逐一打开引用即可看到高亮原文。
4. 询问 *Show me the timeline.*。11 月 17 日是交接记录的录入日期。把范围缩小到主管报告，再问一次。每条回答保留当时的来源引用，后续读取使用新选定的范围。保留已固定的主管报告，询问 *Which of my assigned claims have a deadline later today?* 即可搜索案件组合。随后仍可继续询问这份已固定的报告。

工作服务会在每次受保护的读取操作中核对权限。可选的 CPU 分类器使用 90 条合成训练样本，协助判断请求应交给工作区还是受保护的 Chat。手动附加案件和直接搜索案件组合都可独立于该分类器使用。准备模型时请创建 Python 3.12 虚拟环境，安装训练依赖，并将 `MINILM_DIR` 指向 `sentence-transformers/all-MiniLM-L6-v2` 的本地副本，版本为 `c9745ed1d9f207416be6d2e6f8de32d1f16199bf`。训练命令会核对基础权重并生成带版本标识的模型文件。启动器检测到这些文件后会启用私有推理容器。加上 `--observe` 即可在[本地演示跟踪记录](http://127.0.0.1:17686)中查看受保护的聊天执行记录。

```sh
python -m pip install -r claims/router/requirements-train.txt
python claims/router/train.py --base "$MINILM_DIR" --output .artifacts/claims-router/model
node claims/deploy/up.mjs --showcase
"${CONTAINER_ENGINE:-docker}" exec enterprise-agent-showcase-workbench-1 node claims/router/evaluate.mjs
```

如需在 Maya 的 Chat 中处理 Mac 文件夹，请先按[工作站设置](../README.zh.md)构建本地 harness，再于仓库根目录的另一个终端启动配套进程。该进程在端口 3181 接受已登录 Maya 发起的会话。选择 **Add workspace** 打开文件夹。停止进程后，Chat 入口会再次使用 Maya 的托管工作区。 在展示环境打开 `/open-companion` 进入 Mac 工作区。共享工作台的聊天地址为 `/chat`。

```sh
DSH_HOME=.artifacts/claims-showcase/workstation-home CLAIMS_APP_ORIGIN=http://127.0.0.1:3180 CLAIMS_CHAT_PORT_BASE=3183 CLAIMS_DESKTOP_USER=maya CLAIMS_MODEL_URL=http://127.0.0.1:11434/v1 CLAIMS_MODEL_ID=nemotron-3.5-lightning:30b-mlx node claims/runtime/launch.mjs --desktop-chat
```

演示运行期间，`node claims/showcase/tests/claim-chat.browser.mjs` 使用虚构员工测试在线流程。加上 `--comparison` 可测试案件组合建议和已确认的双案对比。无需密钥的 MCP 回归测试为 `node --test claims/tests/claim-chat-runtime.test.mjs`，共享界面的回归测试为 `node claims/ui/tests/claim-chat.browser.mjs`。

## 运行组件

| 组件 | 在演示中的职责 |
| --- | --- |
| Kong 和 Entra Local | Kong 的无数据库代理在回环端口 3180 上提供员工应用。Entra Local 负责本地登录。应用根据会话确定员工身份和案件访问权。 |
| Workbench 及其数据库 | 保存分配给理赔员的工作、来源版本、收件箱待办、决策和已批准命令。读取证据、请求媒体或读取来源系统时都会检查当前的记录访问权。 |
| 合作方适配器、Amazon mock 和 Temporal | 用户退出后，工作流仍可继续等待。适配器采用相邻 A2A 客户端的工资核验约定草案，验证带签名的合作方结果并返回证据。回调只指向任务，worker 获取权威结果后才将其展示出来。[适配器](partner/README.zh.md) |
| 语音 mock 和原始素材 | 固定的服务事件投递一个受理件。带时间戳的通话文本和理赔员引用的陈述均来自本地合成的同一段录音。[录音生成器](assets/generate_call.py) |
| 时间线 MCP App | 只读工具绑定到所选案件及其修订版本。沙箱视图展示事件，并允许理赔员在宿主中打开来源。框架外的来源阅读器也提供相同文本。[工具和资源](timeline.mjs) |
| Mock JURIS | 独立服务、数据库和角色负责 14 条脚本案件记录，以及启用 CMS 数据集后导入的 200 条案件记录。每条命令在一次事务中更新一个案件并记录一份回执。重试相同操作会返回原始回执。JURIS 标签页通过 Workbench 的授权端点读取目标系统。[服务](juris/store.mjs) |

Workbench 检查每条记录的访问权限，并在写入目标系统前要求人工批准确切载荷。此演示使用模拟服务和虚构数据。

## 重复演示或验证

`--stop` 关闭演示并保留命名卷。重新启动即可继续。**`--reset` 会删除本演示项目的命名卷，包括已记录的审核、合作方任务和目标系统回执。** 如需从一个全新班次重新演示，请依次运行重置和启动命令。[启动器](launch.mjs)

```sh
node claims/deploy/up.mjs --showcase --reset
node claims/deploy/up.mjs --showcase --offline
```

浏览器检查会批准工资请求、证据归档和来电归档，并推进演示记录，因此测试应使用全新演示环境。在仓库根目录运行，并确保 Web 工作区依赖和 Google Chrome 已就绪。检查覆盖从 Workbench 转到 Chat、私有案件访问、带签名的工资核验响应、MCP 时间线引用和可下载的 PDF、音频定位、报案匹配、目标系统回读，以及 Alex 的证据对比。设置 `SHOWCASE_TEST_LOST_ACK=1` 可在工资证明审核中测试回执核对。

```sh
node claims/showcase/tests/browser.mjs
```

要验证带签名的合作方交互和浏览器内审批，请将 `CLAIMS_CMS_TEST_DATABASE_URL` 指向可丢弃的 PostgreSQL，`TEMPORAL_ADDRESS` 指向测试 Temporal 实例，`CLAIMS_TEST_A2A_CONTEXT` 指向新准备的合作方目录，并用 `CLAIMS_TEST_PYTHON` 指定 Python 解释器。运行 `node --test claims/showcase/tests/reviewed-wages.integration.mjs`。测试启动独立的合作方进程，使用独立案件数据库，并检查完整和部分工资记录。

运行以下命令，检查底层数据和 JURIS 命令行为。`JURIS_TEST_ADMIN_URL` 可启用事务测试，使用有权限新建临时数据库的可丢弃 PostgreSQL 实例。`CLAIMS_SHOWCASE_TEST_DATABASE_URL` 以同样的方式启用 Workbench 集成测试。两项测试都会清理各自生成的测试数据库。

```sh
node --test claims/showcase/data/*.test.mjs claims/showcase/juris/*.test.mjs claims/domain/tests/showcase.test.mjs
```
