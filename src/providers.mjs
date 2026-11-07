import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appendEvent, takeResponse, writeJob } from './store.mjs';
import { RpcPeer } from './rpc-peer.mjs';

function short(value, max = 4000) { return String(value ?? '').slice(0, max); }

async function askClaude(job, provider, method, params, isCancelled) {
  const id = randomUUID();
  const request = { id, provider, method, params, createdAt: new Date().toISOString() };
  job.pendingRequests.push(request);
  job.status = 'waiting_for_claude';
  writeJob(job);
  appendEvent(job.id, 'request_for_claude', { requestId: id, provider, method, params });
  const deadline = Date.now() + 15 * 60_000;
  let response = null;
  while (Date.now() < deadline && !isCancelled()) {
    response = takeResponse(job.id, id);
    if (response) break;
    await delay(150);
  }
  job.pendingRequests = job.pendingRequests.filter(item => item.id !== id);
  if (response?.decision !== 'approve') job.authorizationDenied = true;
  if (job.pendingRequests.length === 0) job.status = 'running';
  writeJob(job);
  appendEvent(job.id, 'claude_response', { requestId: id, decision: response?.decision ?? 'deny', timedOut: !response });
  return response ?? { decision: 'deny', answers: {} };
}

function codexApproval(method, params, response) {
  const approved = response.decision === 'approve';
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { decision: approved ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval': return { permissions: approved ? Object.fromEntries(Object.entries(params?.permissions ?? {}).filter(([, value]) => value != null)) : {}, scope: 'turn' };
    case 'item/tool/requestUserInput': {
      const answers = {};
      for (const question of params?.questions ?? []) {
        const value = approved ? response.answers?.[question.id] : undefined;
        if (value !== undefined) answers[question.id] = { answers: Array.isArray(value) ? value.map(String) : [String(value)] };
      }
      return { answers };
    }
    case 'mcpServer/elicitation/request': return { action: approved ? 'accept' : 'decline', content: approved ? response.answers ?? null : null, _meta: null };
    case 'execCommandApproval':
    case 'applyPatchApproval': return { decision: approved ? 'approved' : 'denied' };
    default: throw new Error(`Unsupported Codex request: ${method}`);
  }
}

function acpApproval(params, response) {
  const approved = response.decision === 'approve';
  const wanted = approved ? 'allow_once' : 'reject_once';
  const option = params?.options?.find(item => item.kind === wanted);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}

export async function runCodex(job, isCancelled, setPeer) {
  let finalText = '';
  let failure = null;
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const peer = new RpcPeer({
    command: process.env.CLAUDE_WORKER_CODEX_BIN || 'codex', args: ['app-server'], cwd: job.cwd,
    onStderr: line => appendEvent(job.id, 'stderr', { provider: 'codex', text: short(line, 2000) }),
    onRequest: async (method, params) => codexApproval(method, params, await askClaude(job, 'codex', method, params, () => isCancelled() || !peer.alive)),
    onNotification: (method, params = {}) => {
      if (method === 'item/agentMessage/delta') finalText += String(params.delta ?? '');
      if (method === 'item/completed' && params.item?.type === 'agentMessage') finalText = String(params.item.text ?? finalText);
      if (method === 'error' && !params.willRetry) failure = String(params.error?.message ?? 'Codex reported an error');
      if (method === 'turn/completed') complete(params.turn);
      if (['item/started', 'item/completed', 'error', 'turn/completed'].includes(method)) appendEvent(job.id, 'cli_event', {
        provider: 'codex', method, itemType: params.item?.type ?? null,
        text: short(params.item?.text ?? params.error?.message ?? params.turn?.error?.message ?? '', 2000),
        command: short(params.item?.command ?? '', 500), status: params.turn?.status ?? params.item?.status ?? null
      });
    }
  });
  setPeer(peer);
  try {
    await peer.request('initialize', { clientInfo: { name: 'claude-worker-mcp', title: 'Claude Worker MCP', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 15000);
    peer.notify('initialized');
    const sandbox = job.mode === 'review' ? 'read-only' : 'workspace-write';
    const thread = await peer.request(job.resumeSessionId ? 'thread/resume' : 'thread/start', {
      ...(job.resumeSessionId ? { threadId: job.resumeSessionId } : { ephemeral: false }),
      cwd: job.cwd, ...(job.model ? { model: job.model } : {}),
      approvalPolicy: 'on-request', sandbox,
      developerInstructions: 'The calling Claude supervisor answers permission and input requests. Ask through the native protocol when needed. Work within the assigned task. Do not commit, push, deploy, publish, or change production systems unless the task explicitly authorizes it.'
    }, 30000);
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('Codex returned no thread ID');
    if (job.resumeSessionId && threadId !== job.resumeSessionId) throw new Error('Codex resumed a different thread');
    job.providerSessionId = threadId;
    writeJob(job);
    appendEvent(job.id, 'session_started', { provider: 'codex', sessionId: threadId });
    const started = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: job.prompt, text_elements: [] }], ...(job.model ? { model: job.model } : {}) }, 30000);
    job.turnId = started.turn?.id ?? null;
    writeJob(job);
    const timeout = new AbortController();
    let turn;
    try {
      turn = started.turn?.status && started.turn.status !== 'inProgress'
        ? started.turn
        : await Promise.race([completion, peer.whenClosed, delay(job.timeoutSeconds * 1000, null, { signal: timeout.signal }).then(() => { throw new Error(`Codex turn timed out after ${job.timeoutSeconds}s`); })]);
    } finally { timeout.abort(); }
    const succeeded = turn?.status === 'completed' && !failure && !isCancelled() && !job.authorizationDenied;
    return { succeeded, sessionId: threadId, finalText: short(finalText, 16000), error: succeeded ? null : String(job.authorizationDenied ? 'Claude denied a worker request' : turn?.error?.message ?? failure ?? `Codex turn ${turn?.status ?? 'failed'}`) };
  } catch (error) {
    return { succeeded: false, sessionId: job.providerSessionId, finalText: short(finalText, 16000), error: error instanceof Error ? error.message : String(error) };
  } finally { await peer.close(); setPeer(null); }
}

export async function runOpenCode(job, isCancelled, setPeer) {
  let finalText = '';
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({
    ...(process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {}),
    permissions: [{ action: '*', resource: '*', effect: 'ask' }]
  }) };
  const peer = new RpcPeer({
    command: process.env.CLAUDE_WORKER_OPENCODE_BIN || 'opencode', args: ['acp'], cwd: job.cwd, env, versionField: true,
    onStderr: line => appendEvent(job.id, 'stderr', { provider: 'opencode', text: short(line, 2000) }),
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`Unsupported OpenCode request: ${method}`);
      return acpApproval(params, await askClaude(job, 'opencode', method, params, () => isCancelled() || !peer.alive));
    },
    onNotification: (method, params = {}) => {
      if (method !== 'session/update') return;
      const update = params.update ?? {};
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') finalText += String(update.content.text ?? '');
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) appendEvent(job.id, 'cli_event', {
        provider: 'opencode', method: update.sessionUpdate, tool: short(update.title ?? update.kind ?? '', 300), status: update.status ?? null,
        input: short(JSON.stringify(update.rawInput ?? {}), 2000)
      });
    }
  });
  setPeer(peer);
  try {
    await peer.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claude-worker-mcp', title: 'Claude Worker MCP', version: '0.1.0' } }, 15000);
    const session = await peer.request(job.resumeSessionId ? 'session/load' : 'session/new', {
      ...(job.resumeSessionId ? { sessionId: job.resumeSessionId } : {}), cwd: job.cwd, mcpServers: []
    }, 30000);
    const sessionId = session.sessionId ?? job.resumeSessionId;
    if (!sessionId) throw new Error('OpenCode returned no session ID');
    job.providerSessionId = sessionId;
    writeJob(job);
    appendEvent(job.id, 'session_started', { provider: 'opencode', sessionId });
    if (job.opencodeModel) await peer.request('session/set_config_option', { sessionId, configId: 'model', value: job.opencodeModel }, 10000);
    const preface = job.mode === 'review' ? 'Review only. Do not edit files.\n\n' : '';
    const prompt = `${preface}The calling Claude supervisor handles permissions and questions. Ask when needed. Do not commit, push, deploy, publish, or change production systems unless the task explicitly authorizes it.\n\n${job.prompt}`;
    const result = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, job.timeoutSeconds * 1000);
    const stop = result?.stopReason ?? 'end_turn';
    const succeeded = stop === 'end_turn' && !isCancelled() && !job.authorizationDenied;
    return { succeeded, sessionId, finalText: short(finalText, 16000), error: succeeded ? null : job.authorizationDenied ? 'Claude denied a worker request' : `OpenCode stopped: ${stop}` };
  } catch (error) {
    return { succeeded: false, sessionId: job.providerSessionId, finalText: short(finalText, 16000), error: error instanceof Error ? error.message : String(error) };
  } finally { await peer.close(); setPeer(null); }
}
