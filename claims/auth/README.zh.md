# 理赔演示应用的浏览器身份验证

[English](README.md) | 中文

理赔配置通过 Entra Local 验证虚构员工。免密码账户选择器启动机密客户端的 OIDC 登录流程。工作台验证身份并找到对应员工后，授予受限的对端权限。

浏览器收到一个不透明的 HttpOnly、SameSite=Lax cookie。HTTPS 使用带 Secure 属性的 `__Host-` cookie，仅当公开访问地址为回环地址时才接受 HTTP。JWT、提供方凭据和 PKCE 校验码均保存在服务端。服务端通过提供方发现，并校验 ID 令牌的签发者、受众、签名、到期时间和 nonce，将登录绑定到配置的签发者和客户端。登录的 state 只能使用一次，并与浏览器中单独的 HttpOnly cookie 绑定。机密客户端还使用 PKCE S256。已签名令牌中的租户 ID 和对象 ID 必须与 PostgreSQL 中显式配置的员工关联匹配。关联的主体提供当前角色，原有的工作台主体标识仍用于已保存的聊天和 Outlook 授权。新增员工时，请先创建理赔主体，再更新[员工名册](roster.mjs)。

| 端点 | 行为 |
| --- | --- |
| `GET /auth/login` | 发起新的 Entra Local 交互式登录，登录流程可以保存允许列表中的理赔助手或 PDF 目标。 |
| `GET /auth/callback` | 验证授权响应，轮换浏览器会话，从与应用同源的完成页返回已验证的目标。常规登录会打开 Agent Chat 或员工所属部门的助手。 |
| `GET /auth/me` | 返回 `{user, csrfToken}` 或 401。`user` 包含 `subject`、`principalId`、`tenantId`、`displayName` 和 `roles`。 |
| `POST /auth/logout` | 要求同源 Origin 和 `X-CSRF-Token`，撤销本地会话及 Peer 并清除 cookie。 |
| `GET /auth/signed-out` | 显示可匿名访问的退出确认页，提供明确的 Sign in 链接。 |
| `POST /auth/backchannel-logout` | 验证带签名的 OIDC 登出令牌，撤销匹配的本地会话。 |

领域 API 在写入前调用 `ctx.claimsAuth.require(request, {write: true})`，读取时调用 `require(request)`。验证成功后，调用方获得已验证的 `claims-user` 主体。领域服务还会检查理赔案件的访问权、角色和工作流状态。插件不授予内置 Remote 操作权限，理赔用户无法借此管理会话、工作区、附件、文件系统和插件。助手通过限定到领域的服务路径在内部执行，不使用浏览器拥有者会话。

启动器设置应用地址、租户专用的公开签发者、机密客户端密钥和内部 OIDC 地址。发现、授权、令牌和签名公钥端点的路径必须匹配指定租户。基础演示和联动演示分别在独立卷中保存目录。

单一 Podman 应用的浏览器会话默认持续 12 小时。可用 `CLAIMS_AUTH_SESSION_SECONDS` 调整会话时长。启动器也会设置 Entra Local ID 令牌的有效期，以覆盖该会话。待处理的登录在五分钟后过期。登录尝试过期或无法验证时，回调页提供重新登录的链接。

宿主重启时，浏览器会话和待处理的登录均失效。退出工作台会撤销本地对端并关闭会话监视连接。Entra Local 支持前端通道登出。禁用目录账户后不能再次登录。已有的应用会话持续到本地退出、ID 令牌到期或配置的会话时限为止。

身份验证 API 返回可安全公开的 HTTP 状态和 `AUTH_*` 错误码。浏览器回调在登录无效时显示恢复页面。授权流程只能使用一次。提供方故障时拒绝新登录，不回退到拥有者权限。令牌交换没有自动重试。移除 Connection 提供方会立即停止接受新的连接。卸载插件时会撤销已经获准的 Peer 和流。

测试使用签名 JWT 和本地身份提供方 fixture。浏览器验收使用固定的 [Entra Local 版本](https://github.com/cmaneu/entra-local/tree/v0.1.1)。

运行 `node claims/auth/tests/entra.browser.mjs` 检查基础演示，添加 `--showcase` 检查联动演示的五名员工。测试使用已安装的 Chrome 验证案件访问权限和独立退出。添加 `--hosted` 可打开每位员工默认的 Chat 或部门助手，并验证托管 Chat 会话的撤销。在全新的基础演示中运行 `node claims/auth/tests/browser.acceptance.mjs` 可验证完整的案件及证据流程。

本地模型服务运行时，设置 `CLAIMS_ACCEPTANCE_LIVE=1`，测试还会在真实面板中选择 Compare evidence 和 Local model，对照选定来源检查回答，并打印生成的合成会话 ID 以便查阅日志。可将 `CLAIMS_ACCEPTANCE_SCREENSHOT` 设为本地 PNG 路径来保存回答的渲染结果。这个可选流程仅将预置的虚构案件发送给配置的本地模型。

访问应用根路径需要通过 Entra Local 登录，随后会打开 Agent Chat 或员工所属部门的助手。工作站和按员工分配的托管聊天网关在转发任何原生聊天流量（包括 WebSocket）前，都会验证当前应用会话和员工分配关系。网关将上游 harness 凭据保存在内存中。理赔接口只转发当前员工的会话 cookie 和受支持的理赔操作。打开引用时会重新核查案件、文档版本和已保存的对话。使用已过期会话打开文档或对话链接时，浏览器会在重新登录后返回原目标。经过身份验证的会话监视器会在主会话结束时关闭活动浏览器连接。托管聊天卷和工作站上的本地配置彼此独立。

运行双模式浏览器验收时，启动 Maya 的工作站配套程序和 Compose 服务，并在执行上述浏览器测试时设置 `CLAIMS_DESKTOP_ACCEPTANCE=1`。如需测试本地文件夹选择器，可将 `CLAIMS_DESKTOP_TEST_WORKSPACE` 设为演示文件夹的绝对路径。测试会将该文件夹注册到 Maya 的工作站配置中。
