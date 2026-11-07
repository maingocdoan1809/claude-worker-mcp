#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendEvent, readJob, releaseProject, writeJob } from './store.mjs';
import { runCodex, runOpenCode } from './providers.mjs';

const id = process.argv[2];
let child = null;
let activePeer = null;
let cancelled = false;

function short(value, max = 4000) { return String(value ?? '').slice(0, max); }

function eventDetail(provider, value) {
  const item = value.item ?? value.part ?? value.properties?.part ?? {};
  const text = item.text ?? value.text ?? value.message ?? value.error?.message ?? value.properties?.error?.message ?? '';
  return {
    provider,
    eventType: String(value.type ?? value.method ?? 'event'),
    itemType: item.type ?? null,
    text: short(text),
    command: short(item.command ?? item.input?.command ?? '', 500),
    status: value.turn?.status ?? item.status ?? null
  };
}

function extractSession(provider, value) {
  if (provider === 'codex') return value.thread_id ?? value.threadId ?? value.thread?.id ?? null;
  return value.sessionID ?? value.sessionId ?? value.session?.id ?? value.properties?.sessionID ?? value.properties?.sessionId ?? null;
}

function runProcess(command, args, cwd, stdinText, timeoutMs, provider, job) {
  return new Promise(resolve => {
    const output = { code: null, signal: null, error: null, sessionId: null, finalText: '', tail: '', turnStatus: null, timedOut: false };
    let settled = false;
    let timer = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim(), false);
      if (stderrBuffer.trim()) handleLine(stderrBuffer.trim(), true);
      child = null;
      resolve(output);
    };
    const handleLine = (line, stderr) => {
      output.tail = short((output.tail + '\n' + line).slice(-8000), 8000);
      if (stderr) { appendEvent(job.id, 'stderr', { provider, text: short(line, 2000) }); return; }
      let value;
      try { value = JSON.parse(line); }
      catch { appendEvent(job.id, 'output', { provider, text: short(line, 2000) }); output.finalText = short(line, 8000); return; }
      const session = extractSession(provider, value);
      if (session) { output.sessionId = session; job.providerSessionId = session; writeJob(job); }
      const detail = eventDetail(provider, value);
      appendEvent(job.id, 'cli_event', detail);
      if (provider === 'codex') {
        if (value.type === 'turn.completed') output.turnStatus = value.turn?.status ?? 'completed';
        if (value.type === 'turn.failed') { output.turnStatus = 'failed'; output.error = value.turn?.error?.message ?? value.error?.message ?? 'Codex turn failed'; }
        if (value.type === 'error') output.error = value.message ?? value.error?.message ?? 'Codex reported an error';
        if (value.type === 'item.completed' && value.item?.type === 'agent_message') output.finalText = short(value.item.text, 16000);
      } else {
        if (value.type === 'error') output.error = value.error?.message ?? value.properties?.error?.message ?? value.message ?? 'OpenCode reported an error';
        if (value.type === 'text' || detail.itemType === 'text') output.finalText = short((output.finalText + (detail.text || '')).slice(-16000), 16000);
      }
    };
    const consume = (chunk, stderr) => {
      let buffer = (stderr ? stderrBuffer : stdoutBuffer) + chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      if (stderr) stderrBuffer = buffer; else stdoutBuffer = buffer;
      for (const line of lines) if (line.trim()) handleLine(line, stderr);
    };
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) { output.error = error.message; finish(); return; }
    child.stdout.on('data', chunk => consume(chunk, false));
    child.stderr.on('data', chunk => consume(chunk, true));
    child.once('error', error => { output.error = error.message; finish(); });
    child.once('close', (code, signal) => { output.code = code; output.signal = signal; finish(); });
    if (stdinText != null) child.stdin.end(stdinText); else child.stdin.end();
    timer = setTimeout(() => { output.timedOut = true; output.error = `Timed out after ${Math.round(timeoutMs / 1000)} seconds`; child?.kill('SIGTERM'); }, timeoutMs);
  });
}

async function runTask(job) {
  const providers = job.providerPreference === 'auto' ? ['codex', 'opencode'] : [job.providerPreference];
  const originalPrompt = job.prompt;
  for (const provider of providers) {
    if (cancelled || job.status === 'cancel_requested' || job.authorizationDenied) break;
    job.provider = provider;
    job.providerSessionId = null;
    if (provider !== job.resumeProvider) job.resumeSessionId = null;
    writeJob(job);
    appendEvent(job.id, 'attempt_started', { provider });
    const result = await (provider === 'codex' ? runCodex : runOpenCode)(job, () => cancelled, peer => { activePeer = peer; });
    job.attempts.push({ provider, error: result.error, sessionId: result.sessionId, succeeded: result.succeeded });
    appendEvent(job.id, 'attempt_finished', { provider, succeeded: result.succeeded, error: short(result.error, 2000), sessionId: result.sessionId });
    if (result.succeeded) {
      job.status = 'completed';
      job.providerSessionId = result.sessionId;
      job.result = result.finalText || 'Provider completed without a final text message. Inspect the event log and working tree.';
      job.prompt = originalPrompt;
      return;
    }
    job.error = result.error || `${provider} failed`;
    if (provider === 'codex' && job.providerPreference === 'auto' && !cancelled && !job.authorizationDenied) {
      appendEvent(job.id, 'fallback', { from: 'codex', to: 'opencode', reason: short(job.error, 2000) });
      job.prompt = `${originalPrompt}\n\nCodex stopped before completing this task. Inspect the current working tree and existing edits first; preserve useful partial work, avoid repeating side effects, then finish the requested task and tests. Codex failure: ${short(job.error, 1500)}. Codex final output: ${short(result.finalText, 5000)}`;
      job.resumeSessionId = null;
    }
  }
  job.prompt = originalPrompt;
  job.status = cancelled || job.status === 'cancel_requested' ? 'cancelled' : 'failed';
}

async function runChecks(job) {
  job.checkResults = [];
  for (const check of job.checks) {
    if (cancelled || job.status === 'cancel_requested') { job.status = 'cancelled'; return; }
    const [command, ...args] = check.argv;
    appendEvent(job.id, 'check_started', { argv: check.argv });
    const result = await runProcess(command, args, job.cwd, null, check.timeoutSeconds * 1000, 'check', job);
    const entry = { argv: check.argv, code: result.code, timedOut: result.timedOut, error: result.error, outputTail: result.tail };
    job.checkResults.push(entry);
    writeJob(job);
    appendEvent(job.id, 'check_finished', entry);
  }
  job.status = job.checkResults.every(item => item.code === 0 && !item.error) ? 'completed' : 'failed';
  job.result = `${job.checkResults.filter(item => item.code === 0 && !item.error).length}/${job.checkResults.length} checks passed`;
}

async function main() {
  if (!id) throw new Error('worker requires a job ID');
  const job = readJob(id);
  process.on('SIGTERM', () => { cancelled = true; child?.kill('SIGTERM'); void activePeer?.close(); });
  process.on('SIGINT', () => { cancelled = true; child?.kill('SIGTERM'); void activePeer?.close(); });
  job.pid = process.pid;
  job.status = 'running';
  writeJob(job);
  appendEvent(id, 'job_started', { kind: job.kind, cwd: job.cwd });
  try {
    if (job.kind === 'check') await runChecks(job); else await runTask(job);
  } catch (error) {
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (cancelled) job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    writeJob(job);
    appendEvent(id, 'job_finished', { status: job.status, result: short(job.result, 2000), error: short(job.error, 2000) });
    releaseProject(job.project, id);
  }
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
