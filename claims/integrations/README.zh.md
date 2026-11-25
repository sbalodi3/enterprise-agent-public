# 模拟服务事件入口

[English](README.md) | 中文

`createFixtureIngress({domain, token, workerToken})` 返回一个原生 WebServer 请求处理器。将其注册在 `/claims/integrations/fixtures`。`token` 取自 `CLAIMS_FIXTURE_TOKEN`，必须与 Temporal worker 的凭据不同。如果配置缺失或强度不足，注册会失败。此端点不接受浏览器 cookie、CSRF 令牌或 worker 令牌进行身份验证。

发送 `POST /claims/integrations/fixtures`，携带 `Authorization: Bearer <fixture credential>` 和 `Content-Type: application/json`，请求体严格采用 `{"source":"voice-intake","eventId":"source-stable-event-id"}` 的形式。服务只接受预定义的模拟来源。每个来源绑定到固定的 fixture（测试前置数据）、租户 `demo`、配置 `claims-v1` 和工作项。调用方自行提供的主体、案件 ID、证据或访问范围均会被拒绝。事件记录的执行者为 `fixture-ingress`，服务主体为产生该 fixture 的服务。该主体无法通过浏览器登录。

| 来源 | 固定工作项 |
| --- | --- |
| `voice-intake` | `IN-201` |
| `voice-team-intake` | 共享受理团队的 `IN-202` |
| `a2a-update` | `WC-102` |
| `calendar-change` | `WC-101` |
| `jira-update` | `WC-103` |
| `ado-update` | `WC-102` |

服务凭据可以重复使用。生产方重试投递时必须使用相同的 `eventId`。领域事务持久记录该 ID 以便去重，追加证据和时间线记录，并向当前负责人的邮箱投递，无需浏览器或 agent（智能体）在线。重复投递会返回 `duplicate: true`，将同一 ID 用于另一来源则返回 409。此路由回放合成集成事件，不建立真实的合作方连接，也不投递 Temporal 工资核验响应。

运行 `node --test claims/integrations/fixtures.test.mjs`。将 `CLAIMS_TEST_DATABASE_URL` 设为可丢弃的 PostgreSQL 数据库后，测试还会在隔离的 schema 中检查并发投递、处理器重启、持久去重、邮箱投递，以及记录的执行者和服务主体。测试结束后会移除该 schema。
