---
kind: upgrade-guide
description: 连接演示中的工资请求须由员工批准后才发送给合作方。
---

# 批准后发送工资请求

[English](guide.md) | 中文

## 变更

在连接演示中，`POST /claims/api/wages` 现在返回待审批提案。获授权的员工确认具体披露内容后，工作进程才联系模拟的 Amazon 合作方。将返回证据归入案件须另行审核。Workbench 和 Chat 共享两次审核。

## 迁移

1. 使用原有数据集参数重新构建演示并保留命名卷。Workbench 应用迁移 019，模拟 Juris 导入缺失的 CMS 记录。
2. 调用方显示接口返回的提案，并将员工决定、提案版本和摘要提交至 `POST /claims/api/proposals/{id}/review`。从操作记录核对目标系统回执。
3. 在 **Reviews** 核对接收方和日期，放行本地合作方结果，再检查单独的归档提案。已有合作方任务继续使用原 ID。恢复时查询原登记记录。
