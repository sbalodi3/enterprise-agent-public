# 本地工资核验合作方

[English](README.md) | 中文

全新安装的单一 Podman 应用包含内置的模拟工资证明服务。该服务接收已审核的预置案件披露、保存任务和回执标识，并在演示人员发布结果后提供生成的证据。它使用同一私有 Workbench 接口和 Temporal 工作流，来源标记为 synthetic-payroll。签名 A2A 后端用于测试 Agent Card 发现与外部签名边界。

演示通过相邻仓库的 Amazon 工资 mock 运行同一仓库的 A2A 客户端，执行 agent（智能体）卡片发现、OAuth 交换、JSON-RPC、分离式 ES256 签名验证、schema 检查，并验证返回工资记录的来源字段。客户端和 mock 都在演示专用网络上运行。该 fixture（测试前置数据）使用 HTTP 和本地服务凭据。拟议的合作方 mTLS、生产身份、签名密钥托管和双边约定仍需企业验证。

构建器计算明确列出的文件的指纹，将文件复制到新目录，然后应用[演示补丁](presenter.patch)。摘要 manifest（元数据清单）涵盖当前的 `query.wage_evidence/1.0.0` schema、客户端、mock 和依赖锁文件。指纹不符时，构建器停止准备工作，以便开发者检查变更。安装依赖时使用锁文件中相应的 wheel 包哈希。相邻仓库的检出目录只读。

Workbench 使用已验证的操作人身份发送经批准的披露内容。操作 ID 和载荷摘要将合作方回执绑定至已审核的请求。若确认消息丢失，Workbench 使用原请求 ID 查询回执。发送前，SQLite 先登记原始消息、任务、链路跟踪记录和回调令牌。演示者放行持久化的 mock 任务并发送带签名的通知。适配器检查回调服务凭据、原始签名、任务令牌和上下文，仅将关联信息转发给 Workbench。收到通知或轮询到更新后，worker 读取带签名的权威任务。适配器重新计算载荷摘要，再将合成工资期间、来源系统、数据截至时间、记录 ID 和策略决策 ID 返回给 worker。重复放行的事件 ID 保持相同。案件访问权、人工审批和向 JURIS 发送命令均由 Workbench 负责。

从仓库根目录运行演示启动器。要单独测试适配器和 mock，使用相邻仓库已有的 Python 3.12 测试环境和一个新准备的目录。

```sh
repo_dir="$PWD"
a2a_dir="${SHOWCASE_A2A_SOURCE:-$HOME/Documents/A2A/dev_a2a_aws}"
context_dir="$(mktemp -d)"
python3 claims/showcase/partner/prepare.py --source "$a2a_dir" --output "$context_dir"
(cd "$context_dir" && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src "$a2a_dir/.venv/bin/python" -m pytest --import-mode=importlib -p no:cacheprovider -q "$repo_dir/claims/showcase/partner/test_partner.py")
```
