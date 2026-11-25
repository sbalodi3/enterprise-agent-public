# 本地理赔演示部署

[English](README.md) | 中文

## 单一 Podman 应用

在仓库根目录使用 Node 24、已启动的无根 Podman 和 Docker Compose 提供程序运行 `npm run app:up`。三个部门都通过同一个 [Enterprise Agent 入口](http://127.0.0.1:3280/open-app) 登录 `enterprise-agent` 项目。Entra Local 使用 8280 端口，本地 Microsoft 授权页使用回环端口 8381。PostgreSQL、工作区管理器和部门数据服务仅在项目内部提供服务。

| 登录员工 | Chat 加载的功能 | 示例 |
| --- | --- | --- |
| Maya Chen | 已分派的理赔案件、理赔工具和私人工作区 | 在 Workbench 中打开 WC-101 |
| Sam Patel | 财务账单异常、发票来源和须审核的操作 | 选择 FIN-207，询问差额原因 |
| Morgan Ellis | 法务事项、来源时间线和须审核的操作 | 选择 MAT-017，询问哪些日期冲突 |

1. 全新安装包含本地模拟工资证明服务。测试签名 A2A 交互时，通过 `SHOWCASE_A2A_SOURCE` 指定[匹配的源码检出](../showcase/partner/README.zh.md)。可用 `SHOWCASE_PARTNER_MODE=fixture` 显式选择内置模拟服务。提供下文所述 GGUF 或设置 `CLAIMS_MODEL_URL` 和 `CLAIMS_MODEL_ID`，指向 Podman 可访问的本地模型。首次启动将模型设置保存到 `.artifacts/enterprise-agent/.env`。
2. 启动项目并登录。在财务或法务记录中选择 **Ask agent** 即可在共享输入框中继续。会话仅列出该员工的记录，引文链接指向有版本的来源。可在相同员工和范围的 **Saved Workbench answers** 中查看原抽屉中保存的回答。
3. 在 **App connections** 中关联当前员工的模拟 Outlook 邮箱。下次登录或重启 Workbench 会沿用授权。重启模拟 Microsoft 服务会生成新的邮箱身份，需要重新授权。租户部署可在项目环境中配置现有 Microsoft 委托设置，包括员工账号映射和令牌加密密钥。配置 Microsoft 客户端后，启动器即使用这些设置。
4. `npm run app:up -- --stop` 停止项目并保留应用数据。再次运行 `npm run app:up` 会复用已有镜像；使用 `--build` 重新构建，或用 `--cms-mcp` 加载可选数据集。

运行 `node claims/shared-chat/departments.browser.mjs` 检查三个登录身份的共享输入框和访问隔离。添加 `--outlook` 可测试本地模拟服务的授权和搜索。该检查会保存回答，请使用测试身份和本地模型。

有关独立组件域、生产入口和可选工资证明试点的配置，请参阅[组件部署指南](widget-host.md)。

在仓库根目录使用 Node 24 运行命令。首次构建需要至少 16 GiB 的可用容器存储空间。[Compose 配置](../../compose.claims.yml) 固定上游镜像摘要。应用镜像构建 pnpm 工作区，并根据冻结的 npm 锁文件安装理赔模块和 Temporal worker 的依赖。

```sh
node claims/deploy/up.mjs
```

默认引擎是 Docker。使用 Podman 时，安装 Docker Compose CLI 提供程序（演示配置叠加需要 2.24.4 或更高版本），并运行 `podman compose version` 检查。在 macOS 上启动支持 amd64 模拟的 Podman 虚拟机，以运行 Entra Local 镜像。在使用 systemd 的 Linux 上，通过 `systemctl --user start podman.socket` 启动无根 API。启动器调用 Podman 构建，并通过 Compose 提供程序管理服务。如安装了多个提供程序，通过 `PODMAN_COMPOSE_PROVIDER` 指定所用的 Compose CLI 程序。

```sh
export CONTAINER_ENGINE=podman
node claims/deploy/up.mjs
```

启动器将私有凭据保存在 `claims/deploy/.env`，在 http://localhost:3080 提供工作台，在回环端口 8080 提供 Entra Local 账户选择器。请选择 Maya Chen、Alex Rivera 或 Jordan Lee。PostgreSQL 仅在 Compose 专用网络内可达。两个引擎各自存储镜像和持久卷。在同一主机切换引擎时，请先让当前服务释放回环端口。

按需明确指定可选配置：

```sh
node claims/deploy/up.mjs --story --observe
node claims/deploy/up.mjs --story --observe --model
```

| 配置 | 新增组件 | 本地接口 | 持久化状态 |
| --- | --- | --- | --- |
| 默认 | 共享 Chat 工作台、工作区管理器、旧书签重定向、PostgreSQL、Entra Local | 应用 3080、旧书签 3083–3085、Entra Local 8080 | 目录、Postgres、原生历史记录及独立工作区卷 |
| `story` | Temporal 开发服务器和 `dsh claims-worker` | Temporal UI 8233、gRPC 7233 | Temporal 命名卷中的 SQLite 历史记录，另设 worker 主目录 |
| `observe` | OpenTelemetry Collector 0.165.0 和 Jaeger | Jaeger 16686、Collector OTLP HTTP 4318 | 临时的本地链路跟踪记录 |
| `model` | 使用 llama.cpp 提供本地 GGUF 模型 | Compose 端口 8080，工作站回环端口 3082 | 只读模型目录 |

发布的端口绑定到 `127.0.0.1`。harness 拒绝通配监听地址，因此 Workbench 绑定到明确的容器网络接口。Workbench 为所有托管聊天账户提供服务。worker 使用独立的 dsh 配置。worker 配置没有 Web 界面。harness 已禁用外部遥测，仅在设置 `--observe` 时启用本地 OTLP。Collector 导出 `claims-workbench` 服务中明确列出的操作。`claims.routing.decision` span 可记录意图、范围模型版本、置信度区间、路由操作和新增项数。Collector 校验每个属性名和取值，新增项数限于 0 至 1536 的整数。撤销操作的 span 通过不透明 ID 链接到对应决策。其他 span 不携带应用属性。Collector 会移除事件、状态文本、trace state、scope 属性和除服务名称之外的资源属性。Jaeger 通过内部网络接收 Collector 的数据，其接收端口不对外发布。运行 `node claims/deploy/check-observe.mjs` 可验证这套数据最小化配置。该命令发送合成探针，并读取生成的 Jaeger 跟踪记录。

启动器在构建时记录当前 Git 修订版本。实际构建的源代码可包含本地未提交的更改。使用 `--build-only` 构建基础镜像且不启动服务。现有镜像已包含目标代码时，可使用 `--no-build`。切换配置时，请显式停止先前已启动的可选服务。

容器存储空间有限时，可用 `Dockerfile.refresh` 更新经过验证的 harness 镜像。为已验证的镜像添加 `claims-workbench:verified-harness` 标签，并确认其中的 harness 源代码与检出版本一致。该构建复制当前理赔源码和部分客户端源码。其他 harness 更改使用完整构建。

```sh
docker build -f claims/deploy/Dockerfile.refresh -t claims-workbench:local .
podman build --pull=never --layers=false --disable-compression=false --ignorefile claims/deploy/Dockerfile.refresh.dockerignore -f claims/deploy/Dockerfile.refresh -t claims-workbench:local .
```

使用 `--model` 时，将参考 GGUF 文件放在 `claims/deploy/models/Qwen3-4B-Q4_K_M.gguf`，或在私有环境文件中设置 `CLAIMS_MODELS_DIR` / `CLAIMS_MODEL_FILE`，指定其他兼容且具有适当许可证的模型。显式下载参考模型可运行 `node claims/deploy/download-model.mjs`。启动时不下载权重，镜像中也不预装权重。默认 API 地址为 `http://llama:8080/v1`，模型别名为 `claims-local`。llama.cpp 使用其 Jinja 工具模板，默认关闭隐藏思考，以便在受限轮次内返回工具调用和可见回答。待服务加载完成后运行：

```sh
"${CONTAINER_ENGINE:-docker}" compose --env-file claims/deploy/.env -f compose.claims.yml exec -T workbench node claims/deploy/check-model.mjs
```

此冒烟测试使用 `WC-102` 检查结构化的 `lookup_claim` 调用，提供合成结果并检查模型是否回答。测试范围不涵盖理赔推理质量、回答是否有证据支持、重复工具调用的可靠性或 harness 的授权边界。

参考模型为官方 [Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b) 的 `Qwen3-4B-Q4_K_M.gguf`。这是大小为 2,497,280,256 字节的单个文件，采用 Apache-2.0 许可证，修订版本为 `bc640142c66e1fdd12af0bd68f40445458f3869b`，SHA256 为 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`。下载器验证该摘要，若已有不同的产物则拒绝覆盖。此模型用于本地演示，尚未经过理赔场景验证。

<a id="optional-web-search-for-standard-chat"></a>

## 为标准 Chat 启用网页搜索

使用与 Chat 相同的引擎启动 [SearXNG 搜索服务](searxng/compose.yml)。DuckDuckGo 无需搜索 API 密钥。只有搜索服务接入外部网络。Chat 通过私有工具网络访问 MCP 桥接服务，地址为 `http://searxng-mcp:8000/mcp`。

```sh
export SEARXNG_SECRET="$(openssl rand -hex 32)"
"${CONTAINER_ENGINE:-docker}" compose -f claims/deploy/searxng/compose.yml up -d
export CLAIMS_SEARCH_NETWORK=enterprise-agent-search-tools
```

启动共享工作台时传入工具网络。迁移按员工导入 MCP 配置，仅所有者可以发现及调用自己的工具。网络名称及桥接地址应与原部署一致。请选择支持工具调用的模型。恢复对话时会保留原始模型历史。新的轮次使用当前本地模型，并沿用该员工原配置中与模型匹配的令牌上限。

## 工作流职责与恢复

经过身份验证的工作 API 负责请求准入、案件访问权、当前分配、证据验证、人工审批、操作状态和模拟目标系统的唯一回执。Temporal 负责持久化等待、限时计时器和活动重试。工作流参数仅包含不透明标识符，证据保存在领域存储中。worker 不能审批工作。演示不联系真实合作方系统。

网关在一次事务中提交工资核验的准入、证据或审核记录，并写入领域发件箱。worker 轮询 `GET /api/internal/work/wage/pending`，以幂等方式启动 `claims-wage-<requestId>`，投递相应信号，然后通过 `POST /api/internal/work/wage/delivered` 确认。如果在投递和确认之间发生故障，消息会重新投递。稳定的工作流 ID 和重复事件处理保证此时可以安全重试。对于已关闭的工作流，只确认投递，不重新启动。已审核的通用操作来自 `GET /api/internal/work/dispatchable`，其中不含与工资核验相关的操作。

`wageEvidenceRequest` 等待模拟合作方产物提交（默认三天），通过工作 API 验证，再等待人工决定（默认七天）。移交案件可能使准入失效并唤醒等待中的工作。审核后的执行以操作 ID 作为稳定标识。确认状态未知时，会等待显式的核对信号（默认一天），不会为了探明第一次写入结果而再次向目标系统写入。核对超时后，领域操作仍标记为未知，需继续跟进。即使工作流已关闭，后续获授权的核对请求仍能读取已有回执。

服务 API 令牌仅通过 worker 到 Workbench 的专用路径发送。运行时支持 `WORKER_API_TOKEN_FILE` 或 `WORKER_API_TOKEN`。本地 Compose 从生成的私有文件中获取环境变量值。回放 fixture（测试前置数据）的入口使用单独生成的 `CLAIMS_FIXTURE_TOKEN`。重新运行 `init-env.mjs` 时，如果缺少该键就补充写入，并保留已有设置。生产环境应使用托管密钥、经身份验证并使用 TLS 的服务身份，以及有明确运维负责人的 Temporal 集群。持久化到 SQLite 的开发服务器只演示本地恢复，不提供高可用。此包不包含 Kubernetes 或云基础设施。

```sh
npm --prefix claims/worker ci --workspaces=false --ignore-scripts
npm --prefix claims/worker test
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix claims/worker run test:integration
TEMPORAL_ADDRESS=127.0.0.1:7233 CLAIMS_TEST_RESTART_SERVER=1 npm --prefix claims/worker run test:integration
```

集成测试使用真实的 Temporal 服务和需要身份验证的合成 API fixture，验证 worker 和服务器重启恢复、重复信号处理、人工审核前无业务操作生效、未知结果核对后操作仅生效一次，以及限时等待超时。领域、API 和 OIDC 的正确性由 `claims/` 下的独立测试覆盖，上述 fixture 本身不足以验证这些行为。

要检查一个正在等待合作方、审核或核对结果的真实运行中的演示工作流，请运行：

```sh
node claims/deploy/check-restart.mjs claims-wage-REQUEST_ID
```

检查会重启演示的 Temporal 和 worker 服务，重新连接并验证它们仍处于同一等待阶段，不发送信号或执行业务写入。正常重启和 `down` 会保留数据库、历史记录和 harness 卷。仅在明确需要重置所有演示状态时使用 `down -v`。保留已初始化数据库时，重新生成凭据不会轮换数据库内存储的凭据。

<a id="shared-chat"></a>

## 共享 Chat

基线与展示环境各自运行 Workbench、PostgreSQL、Entra 目录和私有工作区管理器。员工在相同的工作台地址打开 `/chat`。工作台处理登录回调、原生历史、理赔聊天、组件和 Outlook。PostgreSQL 保存理赔权限、受保护的对话、邮箱连接和原生资源的员工归属。

| 容器 | 用途 |
| --- | --- |
| `workbench` | 响应登录回调并提供共享 Chat、工作台、理赔组件和 Outlook。 |
| `entra` | 提供本地 Entra 目录、账户选择和身份令牌。 |
| `postgres` | 保存理赔权限、受保护的对话、邮箱连接和员工对原生资源的所有权。 |
| `workspace-manager` | 通过私有 Unix 套接字接收工作台请求，管理每位员工的沙箱。 |
| 员工工作区 | 使用文件、终端或可执行工具时启动，挂载个人持久卷；空闲 15 分钟后停止。 |
| `chat-bookmarks` | 一个临时监听器将旧员工端口重定向至共享应用。 |
| `llama` | 可选的本地推理服务，也可配置现有兼容端点。 |
| `temporal` | 保存故事演示中的工作流历史、计时器和重试状态。 |
| `worker` | 执行 Temporal 调度的活动及已批准的理赔工作流。 |
| `collector` | 启用观测时接收、筛选并导出本地遥测。 |
| `jaeger` | 存储并显示筛选后的跟踪记录。 |
| `kong` | 提供集成展示环境的公共应用入口。 |
| `juris` | 提供展示环境模拟的理赔业务记录。 |
| `legal-agent` | 处理向法务部门移交的请求。 |
| `voice` | 向受理工作流投递模拟来电。 |
| `partner-adapter` | 将工资证据工作流连接到模拟合作伙伴。 |
| `amazon-mock` | 模拟本地合作伙伴请求及回调。 |
| `scope-router` | 可选分类器，协助为理赔问题选择已授权的范围。 |
| `searxng` | 可选的本地网页搜索引擎。 |
| `searxng-mcp` | 仅向已配置该 MCP 连接的员工提供搜索功能。已有部署可使用其他服务名。 |
| 本地 Microsoft 模拟器 | 提供合成 Outlook 邮箱和授权页面。邮箱授权归员工所有。 |

全新安装默认使用共享 Chat。运行 `node claims/deploy/up.mjs`，展示环境再加 `--showcase --cms-mcp`。无根 Podman 设置 `CONTAINER_ENGINE=podman`。可选的 Mac 工作区入口为 `/open-companion`。

现有安装先迁移 `claims-demo`，验证后再迁移 `enterprise-agent-showcase`。保留原数据卷、环境、镜像引用和启动配置。

1. 执行 `node claims/deploy/inventory-chat.mjs --project PROJECT --output .artifacts/shared-chat-inventory`，解决所有归属及路径问题，记下输出目录 `INVENTORY`。
2. 执行 `node claims/deploy/snapshot-chat.mjs INVENTORY`。将 `CLAIMS_TEST_DATABASE_URL` 指向临时 PostgreSQL 数据库，然后运行 `node claims/deploy/rehearse-chat.mjs INVENTORY`。私下保存报告和数据库备份。
3. 在暂停期间等原生、理赔和邮箱对话完成，停止工作台、原 Chat 写入服务及代理。将 `CLAIMS_SHARED_CHAT_IMAGE` 设为已构建镜像，运行 `node claims/deploy/stage-chat.mjs import INVENTORY` 导入独立暂存卷。
4. 将 `CLAIMS_SHARED_CHAT_VOLUME` 设为 `staged.json` 中的 `shared` 值。私有搜索沿用 `CLAIMS_SEARCH_NETWORK` 网络。使用原模型、连接配置和配置组启动共享拓扑。验证两位员工、旧对话和附件后运行 `node claims/deploy/activate-chat.mjs INVENTORY`。
5. 回滚时等活动完成，停止工作台、管理器、重定向服务和沙箱。运行 `node claims/deploy/stage-chat.mjs rollback INVENTORY`，将生成的 `rollback.compose.json` 作为原配置的最后一个覆盖文件。使用当前仓库中的 Compose 定义回滚时，启用 `--profile legacy-employee-chat`；CMS 部署还需原有 CMS Chat 覆盖文件及 `--profile cms-chat`。还原卷包含迁移前后数据。归档 Docker 的 `shared-chat.active.json` 或 Podman 的 `shared-chat.podman.active.json` 标记后启动原服务，保留共享卷和当前数据库。
