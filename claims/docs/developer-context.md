# What a coding agent reads in Enterprise Agent

Open the Git checkout `deepseek-harness/` when developing the product. Starting Codex or Claude Code in the surrounding folder did not load the child repository's instructions or skills in our tests. For claims changes, read the [claims contributor guide](../AGENTS.md) and its linked development guides. Both developer agents may read the repository material on demand. A hosted developer model can receive the text its tools read. The employee-facing Workbench has a different set of inputs.

This inventory uses Enterprise Agent commit `4005994659` as its baseline and identifies the new claims guides separately. It covers repository-controlled inputs. User settings, installed plugins, managed policies, saved conversations and additional tools can contribute context outside this inventory.

## Which files enter a request

| Surface | At the start of a session | What can enter later |
| --- | --- | --- |
| Codex | Reads one instruction file per applicable directory from the root to the launch directory. Its default lookup prefers `AGENTS.override.md`, then `AGENTS.md`. Repository skills under applicable `.agents/skills` directories contribute catalog entries. | An explicit file read supplies its text. Running Codex in `claims/` puts the claims guide in its initial instruction chain. A Markdown link to an ADR is a pointer that the agent can follow when relevant. [OpenAI instruction discovery](https://developers.openai.com/codex/guides/agents-md/) · [OpenAI skill discovery](https://developers.openai.com/codex/skills/) |
| Claude Code | In this checkout, follows the applicable `CLAUDE.md` aliases and discovers the skills through `.claude/skills`. Its default project-instructions setting uses Claude files when an ancestor provides one. A deeper directory containing only `AGENTS.md` may require an explicit read. | Reading a file in a directory with its own `CLAUDE.md` brings in those instructions. A skill invocation loads the body. Markdown links differ from Claude's explicit file-import syntax. [Anthropic project instructions](https://code.claude.com/docs/en/memory) · [Anthropic skill loading](https://code.claude.com/docs/en/skills) |
| Enterprise Agent Chat, Standard preset | The filesystem provider reads global and project instructions from the selected session workspace. The harness looks for `AGENTS.md`, `CLAUDE.md` and their `.local.md` variants. It renders duplicate content once per candidate group and advertises model-invocable skills. | Successful structured read/write/edit operations can add nested guidance on the next request. Changing the session directory refreshes its chain. A model skill-tool call or a user-invocable slash command loads a body. References and scripts require a separate operation. Selecting this Git checkout in desktop Chat gives Chat access to its files. [Standard preset](../../packages/bundle/web-app/presets/standard.patch.yml) · [Instruction loader](../../packages/context/agent-instructions/README.md) · [Skill catalog](../../packages/skill/tool-skill/README.md) |
| Claims Workbench assistant | The launcher mounts a separate preset with the department's persona. The domain service supplies the task, authorized record and revision. The assistant registers scoped claim tools and suppresses the working-directory context. | Selected tools return evidence for that record. The native session log can retain model-visible evidence. The department manifest, runtime composition and tools govern the assistant. The repo's contributor guides and ADR index are engineering references. [Profile](../profiles/claims-v1.json) · [Launcher](../runtime/launch.mjs) · [Assistant](../runtime/assistant.mjs) |

For the harness, the global instruction sources are `$DSH_HOME/AGENTS.md` and `$DSH_AGENTS_HOME/AGENTS.md` (by default `~/.dsh` and `~/.agents`). For skills, the filesystem provider scans the nearest Git root's `.dsh/skills` and `.agents/skills`, configured custom roots, user roots, and any configured bundled directory. Discovery scans immediate skill bundles or flat Markdown files in those roots. The standard preset mounts the loaders in the agent's scope. Their configuration and access to a filesystem provider matter when interpreting other profiles. [Filesystem skill discovery](../../packages/skill/skill-filesystem/README.md) · [Web composition](../../packages/bundle/web-app/cordis.patch.yml)

## Standing contributor instructions

The baseline contains the following 18 maintainer files. Each entry links to the source that applies when working in that directory.

| Instruction file | Development work it governs |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | Harness architecture, profile launch, test selection, session compatibility, reviewer and publishing workflows. |
| [.agents/notes/AGENTS.md](../../.agents/notes/AGENTS.md) | Record enduring decisions and check whether newer decisions supersede older notes. |
| [.agents/notes/implemented/AGENTS.md](../../.agents/notes/implemented/AGENTS.md) | Maintain factual descriptions of shipped decisions. |
| [.agents/notes/archived/AGENTS.md](../../.agents/notes/archived/AGENTS.md) | Preserve sealed historical notes and their archival manifest. |
| [.github/AGENTS.md](../../.github/AGENTS.md) | Maintain CI triggers, jobs, platform runners and their checks. |
| [apps/cli/tests/profiles/AGENTS.md](../../apps/cli/tests/profiles/AGENTS.md) | Exercise shipped profile composition through the CLI. |
| [benchmarks/AGENTS.md](../../benchmarks/AGENTS.md) | Benchmark end-user paths across package boundaries using isolated fixtures and workers. |
| [docs/AGENTS.md](../../docs/AGENTS.md) | Choose the documentation owner, structure, publishing route and budget. |
| [native/system/AGENTS.md](../../native/system/AGENTS.md) | Preserve confinement and Node-API contracts across native builds. |
| [packages/AGENTS.md](../../packages/AGENTS.md) | Implement Cordis plugins, services, lifecycle and composition tests. |
| [packages/client/AGENTS.md](../../packages/client/AGENTS.md) | Work on browser UI, slots, rendering, localization and the Web build entry. |
| [packages/experimental/AGENTS.md](../../packages/experimental/AGENTS.md) | Isolate optional or experimental behavior and its dependencies. |
| [packages/schedule/AGENTS.md](../../packages/schedule/AGENTS.md) | Maintain scheduled tasks, persisted timing records and explicit delivery targets. |
| [packages/web/AGENTS.md](../../packages/web/AGENTS.md) | Reject redirects on credential-bearing provider requests. |
| [scripts/AGENTS.md](../../scripts/AGENTS.md) | Maintain repository gates and isolate their processes, ports and temporary paths. |
| [snapshots/AGENTS.md](../../snapshots/AGENTS.md) | Maintain recorded sessions, replay generations and their ownership. |
| [vendor/AGENTS.md](../../vendor/AGENTS.md) | Track pinned Cordis sources and document local changes during vendor sync. |
| [website/AGENTS.md](../../website/AGENTS.md) | Select public documentation for the website and maintain the projection. |

This project adds a nineteenth entry, [claims/AGENTS.md](../AGENTS.md), for claims authorization, agent capabilities, integrations, synthetic testing and private publication. The baseline's four `CLAUDE.md` aliases reside at the root, `packages/`, `vendor/`, and `.agents/notes/implemented/`. Claims adds [a fifth](../CLAUDE.md). Edit the adjacent `AGENTS.md` target. The root [.claude/skills](../../.claude/skills) points to [.agents/skills](../../.agents/skills). On platforms with symlink checkout disabled, verify those links after cloning.

## The 22 inherited development skills

Each link opens the actual skill body. Eligibility depends on the agent, its settings, the launch directory and the skill's metadata. Reading the catalog does not execute its commands. Tool permissions, credential availability and the recipient of a publication are distinct decisions.

| Skill | When its body or supporting material matters |
| --- | --- |
| [agent-experience](../../.agents/skills/agent-experience/SKILL.md) | Design model-visible schemas, tool descriptions and discoverable context. |
| [cordis-styling-nitpicking](../../.agents/skills/cordis-styling-nitpicking/SKILL.md) | Review plugin lifecycle, singleton state, cleanup order and resource ownership. |
| [dsh-archive-agent-notes](../../.agents/skills/dsh-archive-agent-notes/SKILL.md) | Classify, move or delete note triplets under the archive rules. |
| [dsh-ci-test-reliability](../../.agents/skills/dsh-ci-test-reliability/SKILL.md) | Diagnose nondeterministic tests. Includes a CI flake reference. |
| [dsh-client-ui-ux](../../.agents/skills/dsh-client-ui-ux/SKILL.md) | Design and verify rendered UI. Includes alignment, spacing and icon references. |
| [dsh-code-review](../../.agents/skills/dsh-code-review/SKILL.md) | Review a change against the architecture, conventions and tests. |
| [dsh-create-upgrade-guide](../../.agents/skills/dsh-create-upgrade-guide/SKILL.md) | Document breaking settings, interfaces or stored-data changes. |
| [dsh-cua-macos-signing](../../.agents/skills/dsh-cua-macos-signing/SKILL.md) | Set up local signing for computer use. Its Python helpers can create, configure or remove signing identities when invoked. |
| [dsh-doc-writing](../../.agents/skills/dsh-doc-writing/SKILL.md) | Place and validate upstream documentation. Its five references and eight templates are supporting files. |
| [dsh-error-handling](../../.agents/skills/dsh-error-handling/SKILL.md) | Define failures, retry ownership and visible recovery. Includes an error-code reference. |
| [dsh-find-simplifications](../../.agents/skills/dsh-find-simplifications/SKILL.md) | Evaluate removable code and behavior using historical examples. |
| [dsh-merging-stacked-prs](../../.agents/skills/dsh-merging-stacked-prs/SKILL.md) | Update dependent GitHub PRs, land a stack and handle merged branches. These are remote mutations. |
| [dsh-official-plugin-artwork](../../.agents/skills/dsh-official-plugin-artwork/SKILL.md) | Produce upstream plugin icons and optional feature previews using its artwork references. |
| [dsh-pr-description](../../.agents/skills/dsh-pr-description/SKILL.md) | Draft a PR and its AI-use declaration. `user-invocable: false` hides direct slash invocation in the harness. Rendering its badge can contact an external image service. |
| [dsh-pre-push-checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md) | Select local checks, inspect GitHub checks and validate the target of a requested push. |
| [dsh-prose-standard](../../.agents/skills/dsh-prose-standard/SKILL.md) | Edit product, code and documentation prose. Includes examples. |
| [dsh-responsive-ui](../../.agents/skills/dsh-responsive-ui/SKILL.md) | Check viewport, truncation, touch, hover and keyboard behavior. |
| [dsh-session-projection](../../.agents/skills/dsh-session-projection/SKILL.md) | Derive durable session views from event history. |
| [dsh-speed-up-perf](../../.agents/skills/dsh-speed-up-perf/SKILL.md) | Establish benchmarks and compare changes on realistic synthetic paths. |
| [dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) | Translate paired documents. `disable-model-invocation: true` makes it an explicit user invocation in the harness. |
| [dsh-trim-cot-leakage](../../.agents/skills/dsh-trim-cot-leakage/SKILL.md) | Remove reasoning transcripts and review narration from maintained prose. Includes examples and review prompts. |
| [record-browser-gif](../../.agents/skills/record-browser-gif/SKILL.md) | Capture and encode GUI evidence using its Python helper. A requested PR attachment uploads the recording to GitHub. |

At the audited baseline, the 50 tracked paths under `.agents/skills/` included the 22 bodies, 14 reference pages, eight templates, five Python files and a Git ignore file. The Python files are the signing helper and its two tests/probes, and the GIF encoder and its test. No helper is invoked by the harness's skill catalog. A loaded skill can instruct an agent to run a helper separately. The repository contains no tracked project-level Codex config, Claude hooks/settings, Cursor rules, Copilot instructions or Gemini project instructions at the audited baseline.

## Five Enterprise Agent development skills

The checkout has 27 development skills. The five additions cover portfolio triage, partner A2A exchanges, reviewed claim changes, source-based evidence review and employee mailbox delivery. The [claims contributor guide](../AGENTS.md#choose-a-developer-skill) links each task to its skill. Each addition consists of one Markdown file with a discoverable description and an on-demand procedure.

Codex and Claude Code use these files when developing in the checkout. Standard Chat can also discover the repository skills when the employee explicitly opens this checkout as a workspace. The [Claims profile](../profiles/claims-v1.json) defines the separate Workbench assistant capabilities. A partner advertises an A2A capability such as `query.wage_evidence` in its Agent Card.

## Other context-bearing files

| Files | How they are used |
| --- | --- |
| [.agents/notes](../../.agents/notes/README.md), [docs/architecture.md](../../docs/architecture.md), [defensive patterns](../../docs/defensive-patterns/README.md) | Root and scoped instructions link to individual engineering references. The 4,091 paths in the baseline notes tree include translations and metadata. Opening the repo does not bulk-load that tree. |
| [Preset documentation skill](../../packages/preset/agent-preset/skills/dsh-doc/SKILL.md), [Office assets](../../packages/skill/skill-office/assets/), [Windows ACL diagnosis](../../packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/SKILL.md) | Packaged product skills become available through installation, bundling or a configured provider. The Office bundles are `office`, `office-docx`, `office-pptx` and `office-xlsx`. The repository development catalog is discovered separately under `.agents/skills/`. |
| [Experimental Claude Code mods](../../packages/experimental/claude-code-mods/README.md) | Three opt-in examples can affect prompt or tool hooks through an explicitly enabled bridge or plugin directory. They are outside root instruction discovery. |
| [Session fixtures](../../snapshots/session/), [Web worker fixture skill](../../packages/experimental/webworker-runtime/tests/fixtures/vfs-example/workspace/.agents/skills/preview-tour/SKILL.md) | Twelve `AGENTS.md` fixtures span the `agent-instructions`, `agent-instructions-budget`, `agent-instructions-budget-chains`, `agent-instructions-group-failure` and `ptc-workspace-context` scenarios. Four `skill-load` bodies and one preview-tour skill exercise simulated workspaces. Expected prompts and session JSONL are test artifacts. A developer who deliberately opens a fixture workspace may activate its local files. |
| [PR template](../../.github/pull_request_template.md), [issue templates](../../.github/ISSUE_TEMPLATE/), [Git hooks](../../lefthook.yml), [CI workflows](../../.github/workflows/) | Templates affect the associated publication operation. Installed Git hooks, dependency lifecycle scripts and CI can execute without ever appearing in a model prompt. Review them as executable paths. |

## Verification

| Exercise | Evidence |
| --- | --- |
| Codex CLI `0.169.0-alpha.11.1` | Ran `codex debug prompt-input` with all networking blocked in a temporary outer directory, a nested Git repo, and its `claims/` directory. Distinctive synthetic markers established root and claims scope. The skill description appeared at the Git root and under claims. The body and the ordinary architecture file stayed absent. No model was called. |
| Claude Code `2.1.325` | Ran the installed CLI against a loopback-only Anthropic Messages recorder with a dummy key, isolated settings, and the repository's symlink layout reproduced using synthetic files. Starting from the same three locations gave the same marker results. A real `Read` of a child file brought the child instructions into the next request. An explicit `/audit-example` inserted its body. The supporting resource and standalone architecture text stayed absent. The recorder returned scripted model messages and retained marker matches only. |
| New guides in the actual checkout | Repeated startup checks for both developer CLIs after applying the project guidance, with only loopback traffic permitted. The Git root included the Enterprise Agent root rule, skill description and ADR index path. Starting in `claims/` also included the claims rule. Starting in the outer workspace included none of those markers. A sampled skill body heading and the architecture overview's opening paragraph stayed absent in all six runs. |
| Five Enterprise Agent additions | With the default catalog budgets, both CLIs included all five names and full descriptions at the Git root and in `claims/`. The outer directory exposed none. No sampled skill body appeared at startup. An explicit `reviewed-claim-action` invocation in each CLI supplied just that body among the five sampled, verified using loopback-only model recorders. Keep descriptions short enough to fit alongside the inherited catalog. |
| Harness instruction and skill loading | Five keyless [headless replay](../../snapshots/session/headless.snapshot.ts) cases matching `agent-instructions\|skill-load` passed with external IP networking denied. The [instruction suite](../../packages/context/agent-instructions/tests/agent-instructions.spec.ts) and [skill suite](../../packages/skill/tool-skill/tests/tool-skill.spec.ts) passed all 240 tests, including resumed instruction history and staged skill visibility. In the default outer sandbox one replay emitted an incomplete-catalog warning. Re-running with filesystem observation available and IP networking denied matched the committed expectations. |
| Claims assistant | All three [assistant tests](../tests/assistant.test.mjs) passed. The replay uses the real executor and checks visible tools, tool calls, output and citations. It supplies a synthetic preset, so it provides tool-scope evidence. Inspect the [actual launcher](../runtime/launch.mjs) for the shipped persona and the [claims domain](../domain/) for authorization. |

Repeat the harness checks from the Git root with the checkout's Node runtime and installed dependencies. Replay uses recorded responses and compares assembled requests and session output. The two unit suites also exercise recovery and incomplete skill discovery.

```sh
DSH_SNAPSHOT=replay DSH_TELEMETRY_DISABLED=1 DSH_SNAPSHOT_MAX_CONCURRENCY=1 \
  node node_modules/vitest/vitest.mjs run --config vitest.snapshot.config.ts \
  snapshots/session/headless.snapshot.ts -t 'agent-instructions|skill-load'
node node_modules/vitest/vitest.mjs run \
  packages/context/agent-instructions/tests/agent-instructions.spec.ts \
  packages/skill/tool-skill/tests/tool-skill.spec.ts --maxWorkers=2
node --test claims/tests/assistant.test.mjs
```

These tests use a macOS host, controlled skills and synthetic records. Coverage excludes other installations' global settings, hosted coding-agent retention, unselected plugins and Windows symlink behavior. Separate reports cover the [security audit](security-audit.md), [desktop startup traffic](desktop-evidence.md), and [artifact checks](artifact-check.md).
