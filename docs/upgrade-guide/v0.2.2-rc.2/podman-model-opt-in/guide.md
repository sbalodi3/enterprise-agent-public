---
kind: upgrade-guide
description: The single Podman app no longer starts llama.cpp implicitly.
---

# Select a model for the single Podman app

English | [中文](guide.zh.md)

## Change

With no external model URL configured, `npm run app:up` previously started llama.cpp. The default now starts the app with no inference provider. Workbench and sign-in remain available. Chat replies and model-assisted actions require a configured provider.

## Migration

1. If an earlier launch started llama.cpp, run `npm run app:up -- --stop` to stop the stack and retain its data.
2. Run `npm run app:up -- --model` to continue using your existing GGUF through llama.cpp. For Azure OpenAI or Ollama, follow the [single Podman deployment guide](../../../../claims/deploy/README.md).
3. Sign in and send a Chat message to verify that the selected provider responds.
