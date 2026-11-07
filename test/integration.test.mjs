import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
function executable(file, body) { fs.writeFileSync(file, '#!/usr/bin/env node\n' + body, { mode: 0o755 }); }
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content.map(x => x.text).join('\n'));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function until(client, id, predicate) {
  for (let n = 0; n < 150; n++) {
    const job = await call(client, 'task_status', { job_id: id });
    if (predicate(job)) return job;
    await delay(100);
  }
  throw new Error('job did not reach expected state: ' + id);
}
const done = j => !['queued', 'running', 'waiting_for_claude', 'cancel_requested'].includes(j.status);

test('questions, approvals, native resume, fallback and checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-worker-test-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const codex = path.join(root, 'codex');
  const opencode = path.join(root, 'opencode');
  executable(codex, `
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('codex fake');process.exit(0)}
let prompt='',resumed=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume'){resumed=m.method==='thread/resume';return send({id:m.id,result:{thread:{id:'11111111-1111-1111-1111-111111111111'}}})}
 if(m.method==='turn/start'){
  prompt=m.params.input[0].text;
  send({id:m.id,result:{turn:{id:'turn-fake',status:'inProgress'}}});
  if(prompt.includes('FAIL_CODEX')){fs.writeFileSync(path.join(process.cwd(),'partial.txt'),'Codex started this');return send({method:'turn/completed',params:{turn:{status:'failed',error:{message:'quota exceeded'}}}})}
  if(prompt.includes('QUESTION'))return send({id:900,method:'item/tool/requestUserInput',params:{questions:[{id:'color',question:'Which color?'}]}});
  return send({id:901,method:'item/commandExecution/requestApproval',params:{command:'node write-file.js',cwd:process.cwd()}});
 }
 if(m.id===900){fs.writeFileSync(path.join(process.cwd(),'answer.txt'),m.result?.answers?.color?.answers?.[0]??'missing');return send({id:901,method:'item/commandExecution/requestApproval',params:{command:'node write-file.js',cwd:process.cwd()}})}
 if(m.id===901){
  const status=m.result?.decision==='accept'?'completed':'failed';
  if(status==='completed')fs.writeFileSync(path.join(process.cwd(),'codex.txt'),resumed?'resumed':'initial');
  send({method:'item/completed',params:{item:{type:'agentMessage',text:'Codex '+status}}});
  return send({method:'turn/completed',params:{turn:{status,error:status==='failed'?{message:'permission denied'}:null}}});
 }
});`);
  executable(opencode, `
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('opencode fake');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:1}});
 if(m.method==='session/new'||m.method==='session/load')return send({id:m.id,result:{sessionId:'ses_fake'}});
 if(m.method==='session/prompt'){
  promptId=m.id;
  if(!m.params.prompt[0].text.includes('Codex stopped')||!fs.existsSync(path.join(process.cwd(),'partial.txt')))return send({id:m.id,error:{code:-32000,message:'missing handoff'}});
  return send({id:700,method:'session/request_permission',params:{options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}],toolCall:{title:'Write file'}}});
 }
 if(m.id===700){
  if(m.result?.outcome?.optionId==='yes')fs.writeFileSync(path.join(process.cwd(),'finished.txt'),'OpenCode inspected partial work');
  send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OpenCode finished'}}}});
  return send({id:promptId,result:{stopReason:m.result?.outcome?.optionId==='yes'?'end_turn':'cancelled'}});
 }
});`);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, CLAUDE_WORKER_STATE_DIR: path.join(root, 'state'), CLAUDE_WORKER_ROOTS: root, CLAUDE_WORKER_CODEX_BIN: codex, CLAUDE_WORKER_OPENCODE_BIN: opencode }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.some(x => x.name === 'delegate-work'));
    for (const name of ['delegate_task','respond_request','task_status','task_events','continue_task','run_checks','cancel_task','inspect_changes']) assert.ok(tools.tools.some(x => x.name === name));
    const first = await call(client,'delegate_task',{cwd:project,prompt:'QUESTION: implement feature'});
    const question = await until(client,first.jobId,j => j.pendingRequests.length > 0);
    assert.equal(question.status,'waiting_for_claude');
    assert.equal(question.pendingRequests[0].method,'item/tool/requestUserInput');
    await call(client,'respond_request',{job_id:first.jobId,request_id:question.pendingRequests[0].id,decision:'approve',answers:{color:'blue'}});
    const approval = await until(client,first.jobId,j => j.pendingRequests.some(r => r.method==='item/commandExecution/requestApproval'));
    await call(client,'respond_request',{job_id:first.jobId,request_id:approval.pendingRequests[0].id,decision:'approve'});
    assert.equal((await until(client,first.jobId,done)).status,'completed');
    assert.equal(fs.readFileSync(path.join(project,'answer.txt'),'utf8'),'blue');
    assert.equal(fs.readFileSync(path.join(project,'codex.txt'),'utf8'),'initial');
    const followup = await call(client,'continue_task',{job_id:first.jobId,prompt:'Improve feature'});
    const followupApproval = await until(client,followup.jobId,j => j.pendingRequests.length > 0);
    await call(client,'respond_request',{job_id:followup.jobId,request_id:followupApproval.pendingRequests[0].id,decision:'approve'});
    assert.equal((await until(client,followup.jobId,done)).status,'completed');
    assert.equal(fs.readFileSync(path.join(project,'codex.txt'),'utf8'),'resumed');
    const fallback = await call(client,'delegate_task',{cwd:project,prompt:'FAIL_CODEX then finish'});
    const fallbackApproval = await until(client,fallback.jobId,j => j.pendingRequests.some(r => r.provider==='opencode'));
    await call(client,'respond_request',{job_id:fallback.jobId,request_id:fallbackApproval.pendingRequests[0].id,decision:'approve'});
    const result = await until(client,fallback.jobId,done);
    assert.equal(result.status,'completed');
    assert.equal(result.provider,'opencode');
    assert.deepEqual(result.attempts.map(x => x.succeeded),[false,true]);
    assert.match(fs.readFileSync(path.join(project,'finished.txt'),'utf8'),/inspected partial/);
    assert.ok((await call(client,'task_events',{job_id:fallback.jobId})).events.some(e => e.type==='fallback'));
    const denied = await call(client,'delegate_task',{cwd:project,prompt:'DENY this command'});
    const deniedRequest = await until(client,denied.jobId,j => j.pendingRequests.length > 0);
    await call(client,'respond_request',{job_id:denied.jobId,request_id:deniedRequest.pendingRequests[0].id,decision:'deny'});
    const deniedResult = await until(client,denied.jobId,done);
    assert.equal(deniedResult.status,'failed');
    assert.equal(deniedResult.authorizationDenied,true);
    assert.equal(deniedResult.attempts.length,1);
    const check = await call(client,'run_checks',{cwd:project,checks:[{argv:[process.execPath,'-e',"require('node:fs').accessSync('finished.txt')"]},{argv:[process.execPath,'-e','process.exit(2)']}]});
    const checkResult = await until(client,check.jobId,done);
    assert.equal(checkResult.status,'failed');
    assert.deepEqual(checkResult.checkResults.map(x => x.code),[0,2]);
  } finally { await client.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
