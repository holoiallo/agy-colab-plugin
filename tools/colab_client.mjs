// colab_client.mjs -- Shared Colab MCP JSON-RPC + connectionInfo file transfer client (zero-dependency).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DEFAULT_ENDPOINT = process.env.COLAB_MCP_URL || 'https://colaboratory.googleapis.com/mcp';

export const SPECS = {
  gpu_t4: { accelerator: 'T4', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  gpu_t4_highmem: { accelerator: 'T4', shape: 'SHAPE_HIGHMEM', variant: 'VARIANT_GPU' },
  gpu_l4: { accelerator: 'L4', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  gpu_a100: { accelerator: 'A100', shape: 'SHAPE_STANDARD', variant: 'VARIANT_GPU' },
  cpu: { accelerator: 'NONE', shape: 'SHAPE_STANDARD', variant: 'VARIANT_CPU' },
};

export function findGcloud(preferred) {
  const candidates = [
    preferred,
    process.env.GCLOUD_CMD,
    'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
    'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    '/usr/bin/gcloud',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'gcloud';
}

export function ensureWindowsProxyEnv() {
  if (process.platform !== 'win32') return false;
  let needReexec = false;
  if (!process.env.HTTPS_PROXY) {
    try {
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable & reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      );
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
      const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
      if (enabled && m?.[1]) {
        let proxy = m[1].trim();
        if (!/^https?:\/\//i.test(proxy)) proxy = `http://${proxy}`;
        process.env.HTTPS_PROXY = proxy;
        process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;
        needReexec = true;
      }
    } catch {}
  }
  if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1') {
    process.env.NODE_USE_ENV_PROXY = '1';
    needReexec = true;
  }
  return needReexec;
}

const tokenCache = new Map();

export function getAccessToken({ gcloudCmd, cloudSdkConfig, manualToken } = {}) {
  if (manualToken) return manualToken;
  const cacheKey = cloudSdkConfig || '__default__';
  const hit = tokenCache.get(cacheKey);
  if (hit && Date.now() < hit.exp) return hit.token;

  const gcloud = findGcloud(gcloudCmd);
  const env = { ...process.env };
  if (cloudSdkConfig) env.CLOUDSDK_CONFIG = cloudSdkConfig;

  const out = execSync(`"${gcloud}" auth application-default print-access-token`, {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
    env,
  }).trim();
  if (!out) throw new Error('no ADC token: run gcloud auth application-default login first');
  tokenCache.set(cacheKey, { token: out, exp: Date.now() + 45 * 60 * 1000 });
  return out;
}

export function normalizeRemoteRelPath(remotePath) {
  let p = String(remotePath || '').replace(/\\/g, '/').trim();
  if (!p || p.includes('..')) throw new Error(`invalid remotePath: ${remotePath}`);
  if (p.startsWith('/')) {
    p = p.replace(/^\/+/, '');
  } else if (!p.startsWith('content/')) {
    p = `content/${p}`;
  }
  if (!p) throw new Error(`invalid remotePath: ${remotePath}`);
  return p;
}

export const pickRuntime = (text) => (String(text || '').match(/runtimes\/[A-Za-z0-9._-]+/) || [])[0] || null;
export const pickSession = (text) =>
  (String(text || '').match(/runtimes\/[A-Za-z0-9._-]+\/sessions\/[A-Za-z0-9._-]+/) || [])[0] || null;

export function createColabClient(opts = {}) {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const quotaProject = opts.quotaProject || process.env.COLAB_PROJECT || '';
  let sessionId = null;

  async function rpc(method, params = {}, { notify = false } = {}) {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: randomUUID(), method, params };
    const token = getAccessToken(opts);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${token}`,
    };
    if (quotaProject) headers['x-goog-user-project'] = quotaProject;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);

    if (text.trimStart().startsWith('event:') || text.includes('\ndata:')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const j = JSON.parse(raw);
          if (j.id || j.result !== undefined || j.error) {
            if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            return j;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
      return null;
    }
    const j = JSON.parse(text);
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j;
  }

  async function ensureUpstream() {
    if (sessionId) return;
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'colabkit', version: '0.2.0' },
    });
    await rpc('notifications/initialized', {}, { notify: true }).catch(() => {});
  }

  async function callTool(name, args = {}) {
    await ensureUpstream();
    const r = await rpc('tools/call', { name, arguments: args });
    const result = r?.result || {};
    const text = (result.content || []).map((c) => c.text || '').join('\n');
    return { text, structured: result.structuredContent, isError: !!result.isError };
  }

  async function getConnectionInfo(runtimeName) {
    const name = runtimeName.startsWith('runtimes/') ? runtimeName : `runtimes/${runtimeName}`;
    const r = await callTool('get_runtime', { name });
    const ci = r.structured?.connectionInfo;
    if (!ci?.url || !ci?.token) {
      throw new Error(`get_runtime missing connectionInfo for ${name}: ${r.text.slice(0, 300)}`);
    }
    return { url: ci.url.replace(/\/$/, ''), token: ci.token, expireTime: ci.expireTime };
  }

  async function ensureRemoteDir(conn, relDir) {
    if (!relDir || relDir === '.') return;
    const parts = relDir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const apiUrl = `${conn.url}/api/contents/${cur.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'X-Colab-Runtime-Proxy-Token': conn.token,
          Authorization: `token ${conn.token}`,
        },
        body: JSON.stringify({ type: 'directory' }),
      });
      if (!res.ok && res.status !== 409) {
        const txt = await res.text().catch(() => '');
        throw new Error(`mkdir ${cur} failed (${res.status}): ${txt.slice(0, 200)}`);
      }
    }
  }

  async function uploadFile(runtimeName, localPath, remotePath) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs)) throw new Error(`local file not found: ${abs}`);
    const rel = normalizeRemoteRelPath(remotePath);
    const conn = await getConnectionInfo(runtimeName);
    const relDir = path.posix.dirname(rel);
    await ensureRemoteDir(conn, relDir);

    const buf = fs.readFileSync(abs);
    const apiUrl = `${conn.url}/api/contents/${rel.split('/').map(encodeURIComponent).join('/')}`;
    const hdrs = {
      'content-type': 'application/json',
      'X-Colab-Runtime-Proxy-Token': conn.token,
      Authorization: `token ${conn.token}`,
    };
    const CHUNK_BYTES = 4 * 1024 * 1024;
    if (buf.length <= CHUNK_BYTES) {
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: hdrs,
        body: JSON.stringify({ type: 'file', format: 'base64', content: buf.toString('base64') }),
      });
      if (!res.ok) throw new Error(`upload ${rel} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    } else {
      const totalChunks = Math.ceil(buf.length / CHUNK_BYTES);
      for (let i = 0; i < totalChunks; i++) {
        const slice = buf.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, buf.length));
        const chunkIdx = i === totalChunks - 1 ? -1 : i + 1;
        const res = await fetch(apiUrl, {
          method: 'PUT',
          headers: hdrs,
          body: JSON.stringify({ type: 'file', format: 'base64', chunk: chunkIdx, content: slice.toString('base64') }),
        });
        if (!res.ok) throw new Error(`upload chunk ${i + 1}/${totalChunks} for ${rel} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
    }
    return { ok: true, remotePath: `/${rel}`, bytes: buf.length };
  }

  async function downloadFile(runtimeName, remotePath, localPath) {
    const rel = normalizeRemoteRelPath(remotePath);
    const abs = path.resolve(localPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const conn = await getConnectionInfo(runtimeName);
    const hdrs = {
      'X-Colab-Runtime-Proxy-Token': conn.token,
      Authorization: `token ${conn.token}`,
    };
    const enc = rel.split('/').map(encodeURIComponent).join('/');
    const filesRes = await fetch(`${conn.url}/files/${enc}`, { headers: hdrs });
    if (filesRes.ok) {
      const ab = await filesRes.arrayBuffer();
      const out = Buffer.from(ab);
      fs.writeFileSync(abs, out);
      return { ok: true, remotePath: `/${rel}`, localPath: abs, bytes: out.length, via: 'files' };
    }
    const apiRes = await fetch(`${conn.url}/api/contents/${enc}?content=1`, { headers: hdrs });
    if (!apiRes.ok) {
      throw new Error(`download ${rel} failed (files=${filesRes.status}, contents=${apiRes.status}): ${(await apiRes.text()).slice(0, 300)}`);
    }
    const j = await apiRes.json();
    const out = j.format === 'base64' ? Buffer.from(j.content || '', 'base64') : Buffer.from(j.content || '', 'utf8');
    fs.writeFileSync(abs, out);
    return { ok: true, remotePath: `/${rel}`, localPath: abs, bytes: out.length, via: 'contents' };
  }

  return { callTool, getConnectionInfo, uploadFile, downloadFile };
}
