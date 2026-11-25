---
kind: upgrade-guide
description: 单个 Podman 应用不再自动启动 llama.cpp。
---

# 为单个 Podman 应用选择模型

[English](guide.md) | 中文

## 变更

此前，未配置外部模型 URL 时，`npm run app:up` 会启动 llama.cpp。现在默认启动应用时不配置推理服务。Workbench 和登录仍可使用。Chat 回复及模型辅助操作需要配置推理服务。

## 迁移

1. 如果之前的启动已运行 llama.cpp，先运行 `npm run app:up -- --stop` 停止应用并保留数据。
2. 如需继续通过 llama.cpp 使用现有 GGUF，运行 `npm run app:up -- --model`。如需使用 Azure OpenAI 或 Ollama，请参阅[单个 Podman 应用部署指南](../../../../claims/deploy/README.zh.md)。
3. 登录并发送 Chat 消息，确认所选模型服务正常响应。
