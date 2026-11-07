import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const stateDir = path.resolve(process.env.CLAUDE_WORKER_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'claude-worker-mcp'));
const jobsDir = path.join(stateDir, 'jobs');
const locksDir = path.join(stateDir, 'locks');
const responsesDir = path.join(stateDir, 'responses');

export function ensureStore() {
  for (const dir of [stateDir, jobsDir, locksDir, responsesDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

export function resolveWorkspace(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
  const real = fs.realpathSync(cwd);
  if (!fs.statSync(real).isDirectory()) throw new Error('cwd is not a directory');
  const roots = (process.env.CLAUDE_WORKER_ROOTS || os.homedir()).split(path.delimiter).filter(Boolean).map(p => fs.realpathSync(p));
  if (!roots.some(root => inside(root, real))) throw new Error(`cwd is outside allowed roots: ${roots.join(', ')}`);
  let project = real;
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: real, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (gitRoot && inside(fs.realpathSync(gitRoot), real)) project = fs.realpathSync(gitRoot);
  } catch { /* Non-Git projects use cwd as their project boundary. */ }
  if (!roots.some(root => inside(root, project))) throw new Error('project Git root is outside allowed roots');
  return { cwd: real, project };
}

function validId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid job_id');
  return id;
}

function jobFile(id) { return path.join(jobsDir, `${validId(id)}.json`); }
export function logFile(id) { return path.join(jobsDir, `${validId(id)}.jsonl`); }
function lockFile(project) { return path.join(locksDir, createHash('sha256').update(project).digest('hex') + '.lock'); }
function responseFile(jobId, requestId) { return path.join(responsesDir, `${validId(jobId)}-${validId(requestId)}.json`); }

export function submitResponse(jobId, requestId, response) {
  ensureStore();
  const job = readJob(jobId);
  if (!['running', 'waiting_for_claude'].includes(job.status)) throw new Error('job is not waiting for a response');
  const request = job.pendingRequests?.find(item => item.id === requestId);
  if (!request) throw new Error('unknown or expired request_id');
  if (response.decision === 'approve' && request.method === 'item/tool/requestUserInput') {
    for (const question of request.params?.questions ?? []) {
      if (!Object.hasOwn(response.answers ?? {}, question.id)) throw new Error(`missing answer for question ${question.id}`);
    }
  }
  fs.writeFileSync(responseFile(jobId, requestId), JSON.stringify(response), { flag: 'wx', mode: 0o600 });
}

export function takeResponse(jobId, requestId) {
  const file = responseFile(jobId, requestId);
  try {
    const response = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return response;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readJob(id) {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`unknown job_id: ${id}`); throw error; }
}

export function writeJob(job) {
  ensureStore();
  job.updatedAt = new Date().toISOString();
  const dest = jobFile(job.id);
  const temp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, dest);
  return job;
}

export function appendEvent(id, type, detail = {}) {
  ensureStore();
  fs.appendFileSync(logFile(id), JSON.stringify({ at: new Date().toISOString(), type, ...detail }) + '\n', { mode: 0o600 });
}

export function readEvents(id, offset = 0, limit = 50) {
  readJob(id);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be between 1 and 200');
  let lines = [];
  try { lines = fs.readFileSync(logFile(id), 'utf8').trimEnd().split('\n').filter(Boolean); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { events: lines.slice(offset, offset + limit).map(line => JSON.parse(line)), nextOffset: Math.min(lines.length, offset + limit), hasMore: offset + limit < lines.length };
}

export function listJobs(limit = 20) {
  ensureStore();
  return fs.readdirSync(jobsDir).filter(name => name.endsWith('.json')).map(name => {
    try { return JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(limit, 1), 100));
}

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireProject(project, id) {
  ensureStore();
  const file = lockFile(project);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, id, { flag: 'wx', mode: 0o600 }); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = fs.readFileSync(file, 'utf8').trim();
    let stale = true;
    try {
      const job = readJob(owner);
      const young = Date.now() - Date.parse(job.createdAt) < 10000;
      stale = !['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(job.status) || (!alive(job.pid) && !young);
      if (stale && ['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(job.status)) {
        job.status = 'interrupted';
        job.error = 'Worker process is no longer running';
        writeJob(job);
      }
    } catch { /* An orphan lock is stale. */ }
    if (!stale) throw new Error(`project already has active job ${owner}`);
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('could not acquire project lock');
}

export function releaseProject(project, id) {
  const file = lockFile(project);
  try { if (fs.readFileSync(file, 'utf8').trim() === id) fs.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function newJob(fields) {
  const now = new Date().toISOString();
  return { id: randomUUID(), status: 'queued', provider: null, providerSessionId: null, attempts: [], pendingRequests: [], authorizationDenied: false, result: null, error: null, pid: null, createdAt: now, updatedAt: now, ...fields };
}

export function publicJob(job) {
  const { prompt, checks, ...safe } = job;
  return { ...safe, promptPreview: prompt?.slice(0, 160), checks: checks?.map(c => c.argv) };
}
