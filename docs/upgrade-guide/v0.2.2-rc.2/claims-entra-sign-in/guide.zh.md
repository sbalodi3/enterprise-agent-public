---
kind: upgrade-guide
description: 本地理赔工作台将员工的 Keycloak 密码登录改为 Entra Local 账户选择器。
---

# 使用 Entra Local 登录理赔工作台

[English](guide.md) | 中文

## 变更

基础演示和联动演示各自使用独立的 Entra Local 租户签发者。每个虚构账户都关联到原有的 PostgreSQL 员工记录和工作区。

## 迁移

1. 使用常用配置运行 `node claims/deploy/up.mjs`。联动演示请先运行一次 `node claims/showcase/launch.mjs`，之后可使用 `--offline`。启动器会转换自动生成的签发者设置并停止该项目原有的 Keycloak 容器。保留现有数据卷。
2. 打开工作台，按姓名选择员工。已有会话需要重新登录。
3. 打开员工的案件组合。运行 `node claims/auth/tests/entra.browser.mjs` 或 `node claims/auth/tests/entra.browser.mjs --showcase` 检查每个账户。
