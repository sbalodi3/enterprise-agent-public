---
kind: upgrade-guide
description: 理赔工作台移除工作模式选择页，登录后直接进入 Agent Chat，并支持将员工的 Chat 端口迁移到工作台共用地址。
---

# 理赔 Chat 入口

[English](guide.md) | 中文

## 变更

通过 Entra Local 登录理赔演示后会直接进入 Agent Chat。工作模式选择页及其侧栏入口已移除。法务和财务员工登录后会进入本部门的助手。

过去，部分案件组合问题会触发范围选择器。现在，Chat 会在员工有权访问的案件中查询清单或数量。询问某个案件时，Chat 会设置当前案件，或请员工确认候选案件。以前手动选择的案件将保留为固定项。

共享模式下，理赔员在工作台同源的 `/chat` 打开聊天。标准 Chat 保留原生会话 ID。通过用户会话读取图片需要匹配该会话中已记录的附件。员工文件、可执行工具及终端由专用管理服务挂载该员工的数据卷；普通问答、理赔 Chat 和 Outlook 均使用共享应用。

## 迁移

1. 打开已有的应用书签或 `/open-app` 并登录，确认 Chat 输入框已打开。
2. 在侧栏选择 **Workbench** 查看案件，也可直接打开 `/open-workbench`。
3. 选择 **Ask agent** 打开 Workbench 助手，再选择 **Open in Chat** 即可在 Chat 中继续该对话。在侧栏选择 **Return to chat** 可恢复当前会话。
4. 先问 “List all open auto claims”，再问 “How many of those?”，确认清单和数量采用相同的筛选条件。使用 **Choose scope** 固定案件或选定文档。Chat 请你确认候选案件时，选择 **Yes**、**No** 或 **Other** 即可继续原请求。

5. 先升级基线，再升级展示环境。按照[本地部署步骤](../../../../claims/deploy/README.zh.md#shared-chat)执行。现有环境应先清点员工数据并演练回滚，再启用共享入口。
6. 以原所有者身份打开旧会话、下载迁移的附件并核对校验和。确认另一位员工不能打开这些链接。普通问答后检查该部署的工作区容器数；批准文件工具后，以所有者身份重新打开文件。
7. 在单一 Podman 项目中以财务或法务身份登录，从 Workbench 打开部门记录并选择 **Ask agent**。确认共享 Chat 输入框中已选中该记录。在 **Saved Workbench answers** 中可查看同一范围的旧回答。
