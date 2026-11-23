// 自测 colabkit MCP server：握手 → 列工具 → 列机型 → 在 colab 上跑一句代码
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, [process.argv[2] || 'tools/colab-mcp-server.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});
let buf = '';
const pend = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
const call = (id, method, params) =>
  new Promise((r) => { pend.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
console.log('initialize:', JSON.stringify(init.result.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await call(2, 'tools/list', {});
console.log('tools:', list.result.tools.map((t) => t.name).join(', '));

const sub = await call(3, 'tools/call', { name: 'colab_subscription', arguments: {} });
console.log('subscription:', sub.result.content[0].text.slice(0, 200));

const specs = await call(4, 'tools/call', { name: 'colab_specs', arguments: {} });
const txt = specs.result.content[0].text;
const eligible = [...txt.matchAll(/"accelerator": "(\w+)"[\s\S]{0,120}?"shape": "(\w+)"[\s\S]{0,120}?"eligible": true/gi)].map((m) => `${m[1]}/${m[2]}`);
console.log('eligible(粗筛):', eligible.join(', ') || '(parsed none)');

const exec = await call(5, 'tools/call', {
  name: 'colab_exec',
  arguments: { spec: 'cpu', code: 'import platform;print("py",platform.python_version())' },
});
const out = JSON.parse(exec.result.content[0].text);
console.log('exec:', JSON.stringify({ ok: out.ok, runtime: out.runtime, stdout: out.stdout, error: out.error }));

child.kill();
