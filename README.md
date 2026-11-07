# Claude Worker MCP

A local [MCP](https://modelcontextprotocol.io/) server for Claude Code to assign work to **Codex CLI**, observe it, resume a session, verify the result, and fall back to **OpenCode** when a Codex attempt fails. A bundled Claude skill describes the supervisor workflow. The MCP works across projects; jobs and logs live in a user state directory, not in the target repository.

Codex uses its app-server protocol; OpenCode uses ACP. Both protocols keep a live session so permission requests can pause the worker and reach Claude through MCP. This is an independent project, informed by [Excel Partner](https://github.com/maingocdoan1809/excel-partner) and [OpenAI's Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc). It does not copy or depend on either project.

## Requirements

- Node.js 20 or newer.
- Claude Code with local MCP support.
- Codex CLI installed and signed in (`codex login status`).
- OpenCode 2.x installed and configured for a usable model if you want fallback (`opencode auth list`, `opencode models`).

## Install for every Claude project

Clone this repository and run `npm install` in it. Then register its absolute server path at Claude's **user** scope:

```bash
claude mcp add --scope user claude-worker -- node /absolute/path/claude-worker-mcp/src/server.mjs
mkdir -p ~/.claude/skills
ln -s /absolute/path/claude-worker-mcp/skills/delegate-work ~/.claude/skills/delegate-work
claude mcp get claude-worker
```

Restart Claude Code after adding the skill. Ask Claude to use `delegate-work`, or ask it to coordinate Codex on a coding task. No API key is stored by this MCP; each provider uses its own CLI login.

To let Claude handle the worker conversation without prompting you for each MCP call, add `"mcp__claude-worker__*"` to `permissions.allow` in your **user** `~/.claude/settings.json`. Claude still sees every worker permission request and answers it through `respond_request`; this setting only authorizes Claude to call the MCP tools. Keep the skill's scope rules in your Claude instructions.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `worker_capabilities` | Check CLI availability without a model call |
| `delegate_task` | Start a background work or read-only review job |
| `task_status` | Get state, provider attempts, session ID, final answer, and check results |
| `respond_request` | Let Claude answer a worker question or approve/deny a permission request |
| `task_events` | Read progress and output with an offset cursor |
| `list_tasks` | Find recent jobs across projects |
| `continue_task` | Continue a finished CLI session with new instructions |
| `run_checks` | Run explicit test/build/lint commands as a background job |
| `inspect_changes` | Read Git status and a bounded diff |
| `cancel_task` | Ask an active worker to stop |

All jobs return a `jobId` immediately. When the provider asks a question or requests permission, status becomes `waiting_for_claude` and `task_status.pendingRequests` exposes the exact request. Claude calls `respond_request` with `approve` or `deny`, plus `answers` keyed by question ID when needed. No user approval is part of this worker loop. If Claude cannot justify a request from the assigned task, it denies it and reports the blocker. Unanswered requests are denied after 15 minutes. Only one job may run in a Git worktree at a time. The worker runs detached from the MCP server, so jobs can continue if Claude disconnects. Job records and logs are stored under `${XDG_STATE_HOME:-~/.local/state}/claude-worker-mcp` by default, with user-only permissions. Set `CLAUDE_WORKER_STATE_DIR` to choose another location.

## Fallback behavior

`delegate_task` defaults to `provider: "auto"`: Codex runs first. If its process or turn fails, the MCP starts OpenCode with the original request, the failure, and recent output. A Claude denial or unanswered permission request stops fallback. OpenCode is explicitly told to inspect existing edits and avoid repeating side effects. The `attempts` array and `fallback` event show the handoff. If both providers fail, the job is `failed` and both errors are retained.

Provider sessions are separate. OpenCode cannot resume Codex's native thread; it resumes work from files and a bounded handoff summary. `continue_task` resumes the provider that completed the prior job. Codex continuations may still fall back to OpenCode.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_WORKER_ROOTS` | User home directory | Allowed working-directory roots, separated by the platform path delimiter |
| `CLAUDE_WORKER_STATE_DIR` | `~/.local/state/claude-worker-mcp` | Local job and log storage |
| `CLAUDE_WORKER_CODEX_BIN` | `codex` | Codex executable path, useful for testing |
| `CLAUDE_WORKER_OPENCODE_BIN` | `opencode` | OpenCode executable path, useful for testing |

Pass configuration with `claude mcp add -e NAME=value ...` or the equivalent Claude MCP settings. Working directories must be absolute paths within an allowed root. Symlinks are resolved before checking the root.

## Safety and limits

- Codex work runs with `workspace-write` and `on-request` approvals; reviews use `read-only`. OpenCode ACP is configured to ask for tool permissions. Claude decides those requests from the task scope. **OpenCode runs with the host user's authority**; `CLAUDE_WORKER_ROOTS` only limits where the job starts. Use trusted repositories and provider configuration.
- `run_checks` executes the given argv directly without a shell, but the executable itself can have side effects. Use it for known verification commands.
- No automatic commit, push, merge, deploy, or publication tools are provided. Claude must deny worker requests outside the user's assigned scope and report why it could not complete that part.
- The MCP does not claim a job succeeded merely because a provider wrote a reassuring message. It records CLI exit and turn status. Independent `run_checks` can verify known commands. `inspect_changes` does not show untracked file contents.
- Job files contain prompts and output. They stay local and use mode `0600`; inspect and delete the state directory if retention is unwanted.

## Develop

```bash
npm install
npm run check
npm test
npm audit --omit=dev
```

The integration test uses fake Codex and OpenCode binaries to exercise MCP transport, question and approval round trips, background jobs, native resume, partial-edit fallback, event logs, and check exit codes without consuming provider quota.

## License

MIT; see [LICENSE](LICENSE).
