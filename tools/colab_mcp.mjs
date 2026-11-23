#!/usr/bin/env node
// colab_mcp.mjs — 直连 Google 官方 Colab MCP 服务（https://colaboratory.googleapis.com/mcp）
//
// 为什么用它：官方 MCP 暴露 create_runtime / create_session / execute_code / delete_session，
// agent 只要会发 JSON-RPC 就能「起 T4 → 跑代码 → 取回 stdout → 销毁」，全程不碰浏览器、不点按钮。
//
// 授权（已验证可用的一步到位版）：
//   gcloud auth application-default login --launch-browser \
//     --scopes="https://www.googleapis.com/auth/colaboratory,https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email"
//   gcloud projects create <ID> && gcloud services enable colaboratory.googleapis.com --project=<ID>
//   gcloud auth application-default set-quota-project <ID>
//   gcloud projects add-iam-policy-binding <ID> --member="user:你@gmail.com" --role="roles/serviceusage.serviceUsageConsumer"
//
// 用法：
//   node colab_mcp.mjs probe                 验证端点（不需要 token）
//   node colab_mcp.mjs tools                 列出工具
//   node colab_mcp.mjs specs                 列出机型与可用性
//   node colab_mcp.mjs subscription          订阅档
//   node colab_mcp.mjs run --script job.py --spec gpu_t4 [--keep]
//   node colab_mcp.mjs exec --code "print(1+1)"
//   node colab_mcp.mjs ls                    列 runtime
//   node colab_mcp.mjs rm <runtime_id>       删 runtime
//
// 环境变量：COLAB_TOKEN（必需）、COLAB_QUOTA_PROJECT（用 ADC 时必需）、COLAB_MCP_URL、COLAB_SPEC

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ENDPOINT = process.env.COLAB_MCP_URL || 'https://colaboratory.googleapis.com/mcp';
const TOKEN = process.env.COLAB_TOKEN || '';
const QUOTA_PROJECT = process.env.COLAB_QUOTA_PROJECT || '';

// runtimeSpec 是扁平结构（带 key 会被 API 拒：Unknown name "key"）
const SPECS = {
  gpu_t4: { accelerator: 'T4', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  gpu_t4_highmem: { accelerator: 'T4', shape: 'SHAPE_HIGHMEM', variant: 'VARIANT_GPU' },
  gpu_l4: { accelerator: 'L4', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  gpu_a100: { accelerator: 'A100', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  cpu: { accelerator: 'NONE', shape: 'SHAPE_STANDARD', variant: 'VARIANT_CPU' },
};

const DEFAULT_SPEC = process.env.COLAB_SPEC || 'gpu_t4';

function specOf(name) {
  if (name && typeof name === 'object') return name;
  if (SPECS[name]) return SPECS[name];
  const s = String(name).trim();
  if (s.startsWith('{')) return JSON.parse(s);
  throw new Error(`未知 spec: ${name}（可用 ${Object.keys(SPECS).join(' / ')}，或直接给 JSON）`);
}

/* ───────── JSON-RPC over streamable HTTP ───────── */
let sessionId = null;

async function rpc(method, params = {}, { notify = false } = {}) {
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: randomUUID(), method, params };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': process.env.MCP_PROTOCOL_VERSION || '2025-06-18',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (QUOTA_PROJECT) headers['x-goog-user-project'] = QUOTA_PROJECT;
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();

  if (!res.ok) {
    const hint =
      res.status === 401 ? 'token 缺失或无效（COLAB_TOKEN）'
      : res.status === 403 ? 'token 有效但权限/额度项目不对（见顶部授权步骤）'
      : res.status === 404 ? '端点或 API 未启用'
      : '';
    throw new Error(`HTTP ${res.status} ${res.statusText} ${hint}\n${text.slice(0, 500)}`);
  }
  if (!text) return null;

  if (text.trimStart().startsWith('event:') || text.includes('\ndata:')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const j = JSON.parse(raw);
        if (j.id || j.result !== undefined || j.error) return j;
      } catch {}
    }
    return null;
  }

  const j = JSON.parse(text);
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j;
}

async function ensureSession() {
  if (sessionId) return;
  await rpc('initialize', {
    protocolVersion: process.env.MCP_PROTOCOL_VERSION || '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'colabkit', version: '0.1.0' },
  });
  await rpc('notifications/initialized', {}, { notify: true }).catch(() => {});
}

async function callTool(name, args = {}) {
  await ensureSession();
  const r = await rpc('tools/call', { name, arguments: args });
  const content = r?.result?.content || [];
  const text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return { text, structured: r?.result?.structuredContent, raw: r?.result };
}

/* ───────── 命令 ───────── */
const A = process.argv.slice(2);
const CMD = A[0];
const flag = (k, d = null) => {
  const i = A.indexOf('--' + k);
  if (i === -1) return d;
  const v = A[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

const showErr = (e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
};

try {
  if (CMD === 'probe') {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: '1', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
      }),
    });
    console.log('endpoint:', ENDPOINT);
    console.log('status:', res.status, res.statusText);
    console.log((await res.text()).slice(0, 400));
  } else if (CMD === 'tools') {
    await ensureSession();
    const r = await rpc('tools/list', {});
    for (const t of r?.result?.tools || []) {
      const req = (t.inputSchema?.required || []).join(', ');
      console.log(`- ${t.name}(${req})`);
    }
  } else if (CMD === 'specs' || CMD === 'subscription' || CMD === 'ls') {
    const name = CMD === 'specs' ? 'list_runtime_specs' : CMD === 'subscription' ? 'get_subscription' : 'list_runtimes';
    const r = await callTool(name, {});
    if (r.structured) say(r.structured);
    else {
      try { say(JSON.parse(r.text)); } catch { say(r.text); }
    }
  } else if (CMD === 'rm') {
    const id = A[1];
    if (!id) throw new Error('给 runtime id');
    const r = await callTool('delete_runtime', { name: id.startsWith('runtimes/') ? id : `runtimes/${id}` });
    say(r.text || r.structured || 'deleted');
  } else if (CMD === 'exec' || CMD === 'run') {
    const spec = flag('spec', DEFAULT_SPEC);
    let code = flag('code', '');
    const scriptFile = flag('script', '');
    if (scriptFile) code = fs.readFileSync(path.resolve(scriptFile), 'utf8');
    if (!code) throw new Error('给 --code 或 --script');

    const step = (m) => console.error(`· ${m}`);
    step(`create_runtime ${typeof spec === 'string' ? spec : JSON.stringify(spec)}`);

    const rt = await callTool('create_runtime', {
      requestId: randomUUID(),
      runtime: { runtimeSpec: specOf(spec) },
    });
    const runtimeName =
      rt.structured?.name || (rt.text.match(/runtimes\/[A-Za-z0-9_.-]+/) || [])[0];
    if (!runtimeName) throw new Error(`create_runtime 没返回 runtime：${rt.text.slice(0, 300)}`);
    step(`runtime = ${runtimeName}`);

    const ses = await callTool('create_session', { parent: runtimeName });
    const sessionName = ses.structured?.name || (ses.text.match(/runtimes\/[^\s"']+/) || [])[0];
    step(`session = ${sessionName}`);

    step('execute_code …（600s 上限；超时用同一 executionId 重试可续接）');
    const executionId = randomUUID();
    const out = await callTool('execute_code', { session: sessionName, executionId, code });
    const p = out.structured || {};
    console.log(JSON.stringify({
      runtime: runtimeName,
      session: sessionName,
      stdout: p.stdout ?? out.text,
      stderr: p.stderr ?? '',
      result: p.result ?? null,
      error: p.executionError ?? null,
      truncated: !!p.outputTruncated,
    }, null, 2));

    if (!flag('keep')) {
      step('delete_session');
      await callTool('delete_session', { name: sessionName }).catch(() => {});
    } else {
      step(`保留 session：${sessionName}`);
    }
  } else {
    console.log(`用法：
  node colab_mcp.mjs probe | tools | specs | subscription | ls
  node colab_mcp.mjs run --script job.py --spec gpu_t4 [--keep]
  node colab_mcp.mjs exec --code "print(1)"
  node colab_mcp.mjs rm <runtime_id>`);
  }
} catch (e) {
  showErr(e);
}
