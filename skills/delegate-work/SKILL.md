---
name: delegate-work
description: Supervise Codex CLI through claude-worker MCP, answer its questions and permissions, verify results, and use OpenCode on Codex failure. Claude plans; the worker implements.
---

# Delegate work to a CLI agent

Use this skill when the user asks Claude to coordinate Codex or OpenCode work, or asks Claude to act as a supervisor while another AI implements the task. This is an explicitly authorized exception to a general preference against delegation. If the user asks Claude to do the work itself, follow that request instead.

## Workflow

1. State the goal, acceptance criteria, project directory, and a short sequence of steps. The user has authorized Claude to supervise and decide worker permissions for this workflow. Resolve ordinary choices without relaying them to the user.
2. Call `worker_capabilities`. Use `delegate_task` with `provider: "auto"` unless the user selects one provider. Put the full task and required tests in the prompt. The CLI worker should perform implementation; Claude should not make competing edits in the same workspace.
3. Keep the returned `jobId`. Poll `task_status` and `task_events` to follow progress. When status is `waiting_for_claude`, inspect every `pendingRequests` entry. Answer each with `respond_request` and keep polling. For `item/tool/requestUserInput`, supply `answers` keyed by the question IDs. Claude makes the decision; the user receives the final report, not routine permission prompts. Do not start a second writer in the same project while a job runs.
4. Approve worker commands and file edits only when their exact scope follows the assigned task and repository rules. In review mode, deny writes. Deny requests to commit, push, deploy, publish, access unrelated files, or take irreversible external actions unless the user's task explicitly authorized that action. Answer questions from the task context; when the answer is unknown, deny or cancel that step and report the blocker. Never approve blindly or grant persistent permission. A denial stops fallback so a second provider cannot bypass it.
5. When the job ends, read its result and attempts. If Codex failed and OpenCode took over, tell the user which agent finished the work. A CLI's statement that tests passed is a claim until checked.
6. Use `inspect_changes` to review the changed tree. For known test, build, or lint commands, call `run_checks` with executable and arguments as separate array elements. Read the check job's exit codes and output from `task_status` and `task_events`.
7. If the output misses a requirement or a check fails, use `continue_task` on the finished task with precise corrections. Repeat review and checks until the task meets the acceptance criteria or you can identify a concrete blocker.
8. Report changed files, actual check results, the provider used, and any remaining limitation. Keep the answer concise and make the evidence easy to verify.

## Boundaries

- Claude handles worker approvals and questions within the user's task. If an action is outside that authorization, deny it and report that limitation to the user. Do not convert worker requests into user approval prompts.
- `provider: "auto"` falls back after a Codex failure or quota/CLI exception, except after Claude denies a request. OpenCode receives the original request plus the Codex failure and is told to inspect partial edits before continuing. It cannot inherit Codex's native conversation.
- `run_checks` executes local commands without a shell. It is for verification, not a substitute for a CLI agent doing the task.
- `inspect_changes` omits untracked file contents. Ask the worker to account for new files or use another appropriate read tool when reviewing them.
- The MCP limits working directories to `CLAUDE_WORKER_ROOTS`; it is not a filesystem sandbox for OpenCode. Follow the project's own safety and approval rules.
