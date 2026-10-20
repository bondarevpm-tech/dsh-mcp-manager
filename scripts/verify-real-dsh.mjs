// Opt-in real Loader/agent/tool-registry smoke; no model request is submitted.
// Usage: node scripts/verify-real-dsh.mjs /path/to/npm-prefix
// The prefix must contain @deepseek-ai/dsh@0.2.1-rc.2 and its dependencies.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const runtime = resolve(process.argv[2] ?? '/tmp/issue17-dsh');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, '0.2.1-rc.2');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-real-'));
const workspace = join(scratch, 'workspace');
mkdirSync(workspace);
const resultPath = join(scratch, 'result.json');
const verifier = join(scratch, 'verify.mjs');
writeFileSync(verifier, `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'issue17-verifier';
export const inject = ['agents', 'agentLoop', 'webServer'];
export function apply(ctx) {
 void (async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async fn => { for (let i=0;i<200;i++) { if (await fn()) return; await sleep(50); } throw Error('smoke condition timed out'); };
  let owned;
  const server = createServer((req,res) => {
    let text=''; req.on('data', c => text+=c); req.on('end', () => {
      const msg=JSON.parse(text);
      const result=msg.method==='initialize' ? {protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'isolated',version:'1'}} : msg.method==='tools/list' ? {tools:[{name:'echo',inputSchema:{type:'object'}}]} : {};
      res.writeHead(msg.id===undefined ? 202 : 200, {'Content-Type':'application/json'});
      res.end(msg.id===undefined ? undefined : JSON.stringify({jsonrpc:'2.0',id:msg.id,result}));
    });
  });
  try {
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    const port=server.address().port;
    await new Promise(r => server.close(r));
    const ws=${JSON.stringify(workspace)};
    mkdirSync(join(ws,'.dsh/dshmm'), {recursive:true});
    writeFileSync(join(ws,'.dsh/dshmm/mcp.json'), JSON.stringify({mcpServers:{real:{type:'http',authMode:'none',url:'http://127.0.0.1:'+port+'/mcp'}}}));
    // Await actual web route mount and the plugin's agent method decorators.
    await until(async () => { if (!ctx.webServer.port) return false; return (await fetch(ctx.webServer.getOrigin()+'/mcp-manager/api/ping')).ok; });
    owned=await ctx.agents.create({sessionId:'issue17-isolated',meta:{cwd:ws}});
    const api=ctx.webServer.getOrigin()+'/mcp-manager/api';
    const view=async () => (await (await fetch(api+'/workspaces')).json()).workspaces.find(w=>w.path===ws).servers[0];
    assert.equal((await view()).status,'error');
    assert.match((await view()).error,/ECONNREFUSED/);
    await new Promise(r => server.listen(port,'127.0.0.1',r));
    await until(() => owned.agent.ctx.tools.schemas(owned.agent).some(t=>t.name==='mcp__real__echo'));
    const connected=await view(); assert.equal(connected.status,'connected');
    const logs=await fetch(api+'/servers/'+connected.id+'/logs'); assert.equal(logs.status,200);
    assert.ok((await logs.json()).logs.some(x=>/ECONNREFUSED/.test(x.detail)));
    const manual=await fetch(api+'/servers/'+connected.id+'/connect',{method:'POST'}); assert.equal(manual.status,200);
    assert.equal((await manual.json()).server.status,'connected');
    await owned.dispose(); owned=null;
    writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true,dsh:'0.2.1-rc.2',delayedStartup:'connected',tool:'mcp__real__echo',logs:200,connect:200}));
  } catch(error) { writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:error.stack})); }
  finally { await owned?.dispose(); server.closeAllConnections(); await new Promise(r=>server.close(r)); }
 })();
}
`);
const patch = join(scratch, 'smoke.yml');
const host = fileURLToPath(new URL('../lib/index.js', import.meta.url));
writeFileSync(patch, `- insert:\n    - id: issue17-manager\n      name: ${JSON.stringify(host)}\n    - id: issue17-verifier\n      name: ${JSON.stringify(verifier)}\n`);
let output = '';
const child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
  cwd: workspace,
  env: { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'), DEEPSEEK_API_KEY: '', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', c => output += c);
child.stderr.on('data', c => output += c);
const exit = new Promise(r => child.once('exit', r));
try {
  const end = Date.now() + 60000;
  while (!existsSync(resultPath) && Date.now() < end && child.exitCode === null) await new Promise(r => setTimeout(r, 100));
  assert.ok(existsSync(resultPath), `DSH smoke did not complete: ${output}`);
  const result = JSON.parse(readFileSync(resultPath));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  console.log(JSON.stringify(result));
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(r => setTimeout(r, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
