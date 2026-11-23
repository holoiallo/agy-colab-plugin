#!/usr/bin/env node
// colab MCP server (stdio, zero-dependency)
// Wraps the official Colab MCP endpoint + connectionInfo file transfer as tools an agent can call directly.
// The OAuth token is refreshed through gcloud on every call, so no manual credential handling.
//
// Tools:
//   colab_specs / colab_subscription / colab_ensure_runtime / colab_exec / colab_run_script /
//   colab_upload / colab_download / colab_list / colab_delete
//
// Env:
//   COLAB_PROJECT    quota project id (required)
//   CLOUDSDK_CONFIG  isolated gcloud config dir per account (optional)
//   COLAB_STATE_DIR  isolated runtime state dir (optional; defaults inside CLOUDSDK_CONFIG if set)
//   GCLOUD_CMD       path to gcloud.cmd (optional)
//   COLAB_TOKEN      manual token (optional, wins over gcloud)
//   COLAB_MCP_URL    default https://colaboratory.googleapis.com/mcp
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SPECS,
  createColabClient,
  findGcloud,
  pickRuntime,
  pickSession,
} from './colab_client.mjs';

const GCLOUD = findGcloud(process.env.GCLOUD_CMD);
const STATE_DIR =
  process.env.COLAB_STATE_DIR ||
  (process.env.CLOUDSDK_CONFIG ? path.join(process.env.CLOUDSDK_CONFIG, '.colabkit-mcp') : path.join(os.homedir(), '.colabkit-mcp'));
const STATE = path.join(STATE_DIR, 'state.json');

const quotaProject = () => process.env.COLAB_PROJECT || '';

const client = createColabClient({
  endpoint: process.env.COLAB_MCP_URL,
  quotaProject: quotaProject(),
  gcloudCmd: GCLOUD,
  cloudSdkConfig: process.env.CLOUDSDK_CONFIG,
  manualToken: process.env.COLAB_TOKEN,
});

/* ---------- local state: only tracks runtimes WE created ---------- */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function forgetRuntime() {
  const s = loadState();
  delete s.runtime;
  delete s.session;
  delete s.at;
  saveState(s);
}

async function ensureManagedRuntime(spec = 'gpu_t4') {
  const key = SPECS[spec] ? spec : 'gpu_t4';
  const st = loadState();
  if (st.runtime && Date.now() - (st.at || 0) < 25 * 60 * 1000) {
    return { ok: true, runtime: st.runtime, spec: st.spec || key, reused: true };
  }
  const rt = await client.callTool('create_runtime', {
    requestId: randomUUID(),
    runtime: { runtimeSpec: SPECS[key] },
  });
  const runtime = pickRuntime(rt.text);
  if (!runtime) return { ok: false, stage: 'create_runtime', detail: rt.text.slice(0, 500) };
  saveState({ runtime, spec: key, at: Date.now() });
  return { ok: true, runtime, spec: key, reused: false };
}

function resolveRuntimeArg(runtime) {
  if (runtime) return runtime.startsWith('runtimes/') ? runtime : `runtimes/${runtime}`;
  const st = loadState();
  if (st.runtime && Date.now() - (st.at || 0) < 25 * 60 * 1000) return st.runtime;
  throw new Error('no active kept runtime; call colab_ensure_runtime or pass runtime explicitly');
}

/* ---------- tools ---------- */
const tools = {
  colab_specs: {
    title: 'Available runtimes',
    description: 'List Colab runtime specs and whether this account is eligible (T4/A100/L4/H100/CPU/TPU).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await client.callTool('list_runtime_specs', {});
      return r.structured || r.text;
    },
  },

  colab_subscription: {
    title: 'Subscription tier',
    description: 'Show the Colab subscription tier (free / pro / pro+).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await client.callTool('get_subscription', {});
      return r.structured || r.text;
    },
  },

  colab_ensure_runtime: {
    title: 'Create or reuse a kept runtime',
    description:
      'Create a Colab runtime (or reuse the active kept runtime within 25 minutes) without destroying it, so you can upload files, run multiple batches, and download outputs. Remember to call colab_delete when done.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'gpu_t4 / gpu_t4_highmem / gpu_l4 / gpu_a100 / cpu (default gpu_t4)' },
      },
    },
    handler: async ({ spec = 'gpu_t4' } = {}) => ensureManagedRuntime(spec),
  },

  colab_exec: {
    title: 'Run Python on Colab',
    description:
      'Create or reuse a Colab runtime (default T4) and run Python in it, returning stdout/stderr. Destroyed afterwards unless keep=true. If no GPU capacity is available the API returns FAILED_PRECONDITION or unavailable: try spec=cpu or retry later.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute' },
        spec: { type: 'string', description: 'gpu_t4 / gpu_t4_highmem / gpu_l4 / gpu_a100 / cpu (default gpu_t4)' },
        keep: { type: 'boolean', description: 'keep the runtime for reuse (remember to delete it)' },
      },
      required: ['code'],
    },
    handler: async ({ code, spec = 'gpu_t4', keep = false }) => {
      const ensured = await ensureManagedRuntime(spec);
      if (!ensured.ok) return ensured;
      const { runtime, reused } = ensured;

      const ses = await client.callTool('create_session', { parent: runtime });
      const session = pickSession(ses.text);
      if (!session) return { ok: false, stage: 'create_session', detail: ses.text.slice(0, 500) };

      const exec = await client.callTool('execute_code', { session, executionId: randomUUID(), code });
      const p = exec.structured || {};
      const result = {
        ok: !p.executionError,
        reused,
        runtime,
        session,
        stdout: p.stdout ?? exec.text,
        stderr: p.stderr ?? '',
        result: p.result ?? null,
        error: p.executionError ?? null,
        truncated: !!p.outputTruncated,
      };

      if (!keep) {
        await client.callTool('delete_session', { name: session }).catch(() => {});
        await client.callTool('delete_runtime', { name: runtime }).catch(() => {});
        forgetRuntime();
      }
      return result;
    },
  },

  colab_run_script: {
    title: 'Run a local script on Colab',
    description:
      'Read a local .py file (e.g. colabkit/tools/blender_job.py), submit it to Colab, return stdout. Good for long jobs like installing Blender and rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'absolute path or repo-relative .py' },
        spec: { type: 'string' },
        keep: { type: 'boolean' },
      },
      required: ['path'],
    },
    handler: async ({ path: p, spec = 'gpu_t4', keep = false }) => {
      const file = path.isAbsolute(p) ? p : path.resolve(p);
      if (!fs.existsSync(file)) return { ok: false, error: `script not found: ${file}` };
      const code = fs.readFileSync(file, 'utf8');
      return await tools.colab_exec.handler({ code, spec, keep });
    },
  },

  colab_upload: {
    title: 'Upload a local file to Colab runtime',
    description:
      'Upload a local file (such as .blend, .zip, .py, textures) into /content/<remotePath> on a kept runtime via its connectionInfo channel.',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: 'Local file path on Windows' },
        remotePath: { type: 'string', description: 'Destination path relative to /content (e.g. job/scene.blend)' },
        runtime: { type: 'string', description: 'Optional runtime name; defaults to current kept runtime' },
      },
      required: ['localPath', 'remotePath'],
    },
    handler: async ({ localPath, remotePath, runtime }) => {
      const rt = resolveRuntimeArg(runtime);
      return await client.uploadFile(rt, localPath, remotePath);
    },
  },

  colab_download: {
    title: 'Download a file from Colab runtime',
    description:
      'Download a file (such as rendered .zip, .png, .mp4) from /content/<remotePath> on a kept runtime to localPath via its connectionInfo channel.',
    inputSchema: {
      type: 'object',
      properties: {
        remotePath: { type: 'string', description: 'Source path relative to /content (e.g. job/chunk_0001.zip)' },
        localPath: { type: 'string', description: 'Destination local file path' },
        runtime: { type: 'string', description: 'Optional runtime name; defaults to current kept runtime' },
      },
      required: ['remotePath', 'localPath'],
    },
    handler: async ({ remotePath, localPath, runtime }) => {
      const rt = resolveRuntimeArg(runtime);
      return await client.downloadFile(rt, remotePath, localPath);
    },
  },

  colab_list: {
    title: 'List runtimes',
    description: 'List the running Colab runtimes on this account (including ones opened from notebooks).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await client.callTool('list_runtimes', {});
      return r.structured || r.text;
    },
  },

  colab_delete: {
    title: 'Delete a runtime',
    description: 'Delete a runtime by name (its files and sessions go with it). Only pass a runtime you mean to delete.',
    inputSchema: { type: 'object', properties: { runtime: { type: 'string' } }, required: ['runtime'] },
    handler: async ({ runtime }) => {
      const name = runtime.startsWith('runtimes/') ? runtime : `runtimes/${runtime}`;
      const r = await client.callTool('delete_runtime', { name });
      forgetRuntime();
      return { ok: !r.isError, detail: r.text || 'deleted' };
    },
  },
};

/* ---------- MCP stdio ---------- */
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let buf = '';

process.stdin.on('data', async (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'colabkit', version: '0.2.0' },
        },
      });
      continue;
    }
    if (msg.method === 'notifications/initialized') continue;
    if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      continue;
    }
    if (msg.method === 'tools/call') {
      const t = tools[msg.params?.name];
      if (!t) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `unknown tool: ${msg.params?.name}` }], isError: true },
        });
        continue;
      }
      try {
        const out = await t.handler(msg.params?.arguments || {});
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }],
            structuredContent: typeof out === 'object' ? out : undefined,
          },
        });
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `failed: ${e.message}` }], isError: true },
        });
      }
      continue;
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported ${msg.method}` } });
    }
  }
});

process.stderr.write(`colabkit MCP ready (gcloud=${GCLOUD}, project=${quotaProject() || '(COLAB_PROJECT not set)'}, stateDir=${STATE_DIR})\n`);
