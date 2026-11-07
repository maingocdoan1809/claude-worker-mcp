import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** JSON-RPC over newline-delimited stdio, as used by Codex app-server and OpenCode ACP. */
export class RpcPeer {
  constructor({ command, args, cwd, env = process.env, versionField = false, onNotification = () => {}, onRequest = async () => null, onStderr = () => {} }) {
    this.versionField = versionField;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.exitError = null;
    this.whenClosed = new Promise((_, reject) => { this.rejectClosed = reject; });
    this.whenClosed.catch(() => {});
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => this.handleLine(line));
    createInterface({ input: this.child.stderr }).on('line', line => onStderr(line));
    this.child.once('error', error => this.terminate(error));
    this.child.once('exit', (code, signal) => this.terminate(new Error(`CLI exited (code=${code}, signal=${signal})`)));
  }

  get alive() { return !this.closed; }

  write(message) {
    if (this.closed) throw this.exitError || new Error('CLI is closed');
    this.child.stdin.write(JSON.stringify(this.versionField ? { jsonrpc: '2.0', ...message } : message) + '\n');
  }

  request(method, params = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(this.exitError || new Error('CLI is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.write({ id, method, params });
    });
  }

  notify(method, params) { this.write(params === undefined ? { method } : { method, params }); }

  handleLine(line) {
    if (!line.trim().startsWith('{')) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) { void this.answer(message); return; }
    if (message.method) { this.onNotification(message.method, message.params); return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message ?? 'RPC error'} (${message.error.code ?? -32000})`));
      else pending.resolve(message.result);
    }
  }

  async answer(message) {
    try {
      const result = await this.onRequest(message.method, message.params, message.id);
      if (this.alive) this.write({ id: message.id, result: result ?? null });
    } catch (error) {
      if (this.alive) this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  terminate(error) {
    if (this.closed) return;
    this.closed = true;
    this.exitError = error;
    this.rejectClosed(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 2000);
      this.child.once('exit', done);
    });
  }
}
