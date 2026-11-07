#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { acquireProject, alive, appendEvent, listJobs, newJob, publicJob, readEvents, readJob, releaseProject, resolveWorkspace, stateDir, submitResponse, writeJob } from './store.mjs';

const execFileAsync = promisify(execFile);
const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const server = new McpServer({ name: 'claude-worker-mcp', version: '0.1.0' });
const providerSchema = z.enum(['auto', 'codex', 'opencode']);

function ok(data) { return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
function fail(error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
function tool(name, description, inputSchema, handler, annotations = {}) {
  server.registerTool(name, { description, inputSchema, annotations }, async args => {
    try { return ok(await handler(args)); } catch (error) { return fail(error); }
  });
}

async function startJob(fields) {
  const { cwd, project } = resolveWorkspace(fields.cwd);
  const job = newJob({ ...fields, cwd, project });
  acquireProject(project, job.id);
  try {
    writeJob(job);
    appendEvent(job.id, 'queued', { kind: job.kind, providerPreference: job.providerPreference ?? null });
    const child = spawn(process.execPath, [workerPath, job.id], { cwd, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { jobId: job.id, status: 'queued', cwd, providerPreference: job.providerPreference ?? null };
  } catch (error) {
    job.status = 'failed'; job.error = `Could not start worker: ${error.message}`;
    writeJob(job);
    releaseProject(project, job.id);
    throw error;
  }
}

function currentJob(id) {
  const job = readJob(id);
  if (['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(job.status) && Date.now() - Date.parse(job.createdAt) > 10000 && !alive(job.pid)) {
    job.status = 'interrupted'; job.error = 'Worker process is no longer running';
    writeJob(job); releaseProject(job.project, id);
  }
  return job;
}

async function probe(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000, maxBuffer: 2048 });
    return { available: true, detail: (stdout || stderr).trim().split('\n')[0] };
  } catch (error) { return { available: false, detail: error.code === 'ENOENT' ? 'not installed' : String(error.stderr || error.message).slice(0, 300) }; }
}

tool('worker_capabilities', 'Check which local coding CLIs are available. No task or model call is made.', {}, async () => {
  const codex = await probe(process.env.CLAUDE_WORKER_CODEX_BIN || 'codex', ['--version']);
  const opencode = await probe(process.env.CLAUDE_WORKER_OPENCODE_BIN || 'opencode', ['--version']);
  return { codex, opencode, fallback: 'Codex to OpenCode on failed Codex execution when provider=auto', stateDir };
}, { readOnlyHint: true });

tool('delegate_task', 'Start a coding or read-only review task. Default provider=auto tries Codex, then OpenCode if Codex fails. Returns a job ID. Claude must answer pending permission and input requests with respond_request.', {
  cwd: z.string().describe('Absolute working directory inside CLAUDE_WORKER_ROOTS (default: user home)'),
  prompt: z.string().min(1).max(100000).describe('Complete task, acceptance criteria and expected tests'),
  provider: providerSchema.default('auto'),
  mode: z.enum(['work', 'review']).default('work'),
  model: z.string().optional().describe('Codex model override; omit to use Codex config'),
  opencode_model: z.string().optional().describe('OpenCode provider/model override; omit to use OpenCode config'),
  timeout_seconds: z.number().int().min(30).max(7200).default(1800)
}, async args => startJob({ kind: 'task', cwd: args.cwd, prompt: args.prompt, providerPreference: args.provider, mode: args.mode, model: args.model, opencodeModel: args.opencode_model, timeoutSeconds: args.timeout_seconds }), { destructiveHint: true });

tool('task_status', 'Read a job status, provider attempts, CLI session ID, final answer and check results. Call task_events for detailed progress.', {
  job_id: z.string()
}, async args => publicJob(currentJob(args.job_id)), { readOnlyHint: true });

tool('respond_request', 'Answer a pending worker permission request or question. Claude decides within the user-authorized task scope. For questions supply answers keyed by question ID; deny unsafe or out-of-scope requests.', {
  job_id: z.string(), request_id: z.string(), decision: z.enum(['approve', 'deny']),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional()
}, async args => {
  const response = { decision: args.decision, answers: args.answers ?? {} };
  submitResponse(args.job_id, args.request_id, response);
  appendEvent(args.job_id, 'claude_decision_submitted', { requestId: args.request_id, decision: args.decision });
  return { accepted: true, jobId: args.job_id, requestId: args.request_id, decision: args.decision };
}, { destructiveHint: true });

tool('task_events', 'Read paginated progress events and test output for a job. Use nextOffset to continue without repeating lines.', {
  job_id: z.string(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50)
}, async args => readEvents(args.job_id, args.offset, args.limit), { readOnlyHint: true });

tool('list_tasks', 'List recent jobs across projects, optionally filtered by cwd or status.', {
  cwd: z.string().optional(), status: z.enum(['queued', 'running', 'waiting_for_claude', 'completed', 'failed', 'cancel_requested', 'cancelled', 'interrupted']).optional(), limit: z.number().int().min(1).max(100).default(20)
}, async args => {
  const cwd = args.cwd ? resolveWorkspace(args.cwd).cwd : null;
  return { jobs: listJobs(args.limit).filter(job => (!cwd || job.cwd === cwd) && (!args.status || job.status === args.status)).map(publicJob) };
}, { readOnlyHint: true });

tool('continue_task', 'Send follow-up instructions into a finished provider session. Creates a new background job. For Codex, provider=auto permits OpenCode fallback.', {
  job_id: z.string(), prompt: z.string().min(1).max(100000), provider: providerSchema.optional(), timeout_seconds: z.number().int().min(30).max(7200).default(1800)
}, async args => {
  const prior = currentJob(args.job_id);
  if (['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(prior.status)) throw new Error('Cannot continue an active job');
  if (prior.kind !== 'task') throw new Error('Only agent tasks have provider sessions');
  if (!prior.providerSessionId) throw new Error('No provider session ID was captured; start a new delegate_task instead');
  const provider = args.provider ?? (prior.provider === 'codex' ? 'auto' : 'opencode');
  if (prior.provider === 'opencode' && provider === 'auto') throw new Error('OpenCode sessions must continue with provider=opencode');
  if (provider !== 'auto' && provider !== prior.provider) throw new Error('A provider session cannot be resumed by a different provider; start a new task instead');
  return startJob({ kind: 'task', parentJobId: prior.id, cwd: prior.cwd, prompt: args.prompt, providerPreference: provider, resumeProvider: prior.provider, resumeSessionId: prior.providerSessionId, mode: prior.mode, model: prior.model, opencodeModel: prior.opencodeModel, timeoutSeconds: args.timeout_seconds });
}, { destructiveHint: true });

tool('run_checks', 'Run explicit test/build/lint commands as a background verification job. Commands are argv arrays executed without a shell; inspect task_status and task_events for actual exit codes and output.', {
  cwd: z.string(),
  checks: z.array(z.object({ argv: z.array(z.string()).min(1).max(100), timeout_seconds: z.number().int().min(1).max(3600).default(300) })).min(1).max(20)
}, async args => startJob({ kind: 'check', cwd: args.cwd, checks: args.checks.map(check => ({ argv: check.argv, timeoutSeconds: check.timeout_seconds })) }), { destructiveHint: true });

tool('inspect_changes', 'Read Git status and a bounded diff in a workspace so Claude can review what the worker changed. No edits are made.', {
  cwd: z.string(), max_chars: z.number().int().min(1000).max(100000).default(30000)
}, async args => {
  const { cwd, project } = resolveWorkspace(args.cwd);
  const options = { cwd: project, timeout: 10000, maxBuffer: 2_000_000 };
  const [status, diff] = await Promise.all([
    execFileAsync('git', ['status', '--short'], options),
    execFileAsync('git', ['diff', '--no-ext-diff', '--', '.'], options)
  ]);
  return { cwd, project, status: status.stdout, diff: diff.stdout.slice(0, args.max_chars), diffTruncated: diff.stdout.length > args.max_chars, note: 'Git diff does not include untracked file contents.' };
}, { readOnlyHint: true });

tool('cancel_task', 'Request cancellation of an active background job and its CLI child process.', {
  job_id: z.string()
}, async args => {
  const job = currentJob(args.job_id);
  if (!['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(job.status)) return { jobId: job.id, status: job.status };
  job.status = 'cancel_requested'; writeJob(job);
  appendEvent(job.id, 'cancel_requested');
  if (alive(job.pid)) process.kill(job.pid, 'SIGTERM');
  return { jobId: job.id, status: 'cancel_requested' };
}, { destructiveHint: true });

await server.connect(new StdioServerTransport());
