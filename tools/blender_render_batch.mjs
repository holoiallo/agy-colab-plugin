#!/usr/bin/env node
// blender_render_batch.mjs -- Multi-account parallel Blender batch renderer + checkpoint + local packager.
//
// Usage:
//   node tools/blender_render_batch.mjs --blend scene.blend --start 1 --end 3000 --batch 25 --fps 24 --out out-3000
//   node tools/blender_render_batch.mjs --smoke --start 1 --end 4 --batch 2 --spec cpu --out out-smoke
//   node tools/blender_render_batch.mjs --out out-3000 --pack-only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SPECS,
  createColabClient,
  ensureWindowsProxyEnv,
  pickRuntime,
  pickSession,
} from './colab_client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PY = path.join(HERE, 'blender_chunk_worker.py');
const DEFAULT_MCP_CFG = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'colab', 'mcp_config.json');

const args = process.argv.slice(2);
const hasFlag = (k) => args.includes('--' + k);
const getArg = (k, d = null) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

function loadProfiles(mcpCfgPath, filterNames) {
  if (!fs.existsSync(mcpCfgPath)) throw new Error(`mcp_config.json not found: ${mcpCfgPath}`);
  const raw = JSON.parse(fs.readFileSync(mcpCfgPath, 'utf8'));
  const servers = raw.mcpServers || {};
  const allow = filterNames ? new Set(filterNames.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const list = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (allow && !allow.has(name)) continue;
    const env = cfg.env || {};
    list.push({
      name,
      quotaProject: env.COLAB_PROJECT || process.env.COLAB_PROJECT || '',
      cloudSdkConfig: env.CLOUDSDK_CONFIG || '',
      gcloudCmd: env.GCLOUD_CMD || '',
    });
  }
  if (list.length === 0) throw new Error('no matching Colab MCP profiles found');
  return list;
}

function buildChunks(start, end, batch) {
  const chunks = [];
  let idx = 0;
  for (let cur = start; cur <= end; cur += batch) {
    const to = Math.min(cur + batch - 1, end);
    chunks.push({
      id: `chunk_${String(idx++).padStart(4, '0')}_${String(cur).padStart(6, '0')}_${String(to).padStart(6, '0')}`,
      start: cur,
      end: to,
      status: 'pending',
      file: null,
      worker: null,
      elapsedSec: null,
      error: null,
    });
  }
  return chunks;
}

function loadOrInitManifest(manifestPath, opts) {
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const c of m.chunks || []) {
      if (c.status === 'done' && c.file && fs.existsSync(c.file) && fs.statSync(c.file).size > 0) continue;
      if (c.status !== 'pending') {
        c.status = 'pending';
        c.worker = null;
      }
    }
    return m;
  }
  return {
    createdAt: new Date().toISOString(),
    blend: opts.blend || null,
    smoke: !!opts.smoke,
    start: opts.start,
    end: opts.end,
    batch: opts.batch,
    spec: opts.spec,
    fps: opts.fps,
    chunks: buildChunks(opts.start, opts.end, opts.batch),
  };
}

function saveManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function runWorkerScriptCode(workerTemplate, envMap) {
  const envLines = Object.entries(envMap)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(String(v))}`)
    .join('\n');
  return `import os\n${envLines}\n` + workerTemplate;
}

function isTimeoutError(msg) {
  return /timeout|timed out|deadline|504|ETIMEDOUT/i.test(String(msg || ''));
}

async function runAccountWorker(profile, shared) {
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${profile.name}] ${m}`);
  const client = createColabClient({
    quotaProject: profile.quotaProject,
    cloudSdkConfig: profile.cloudSdkConfig,
    gcloudCmd: profile.gcloudCmd,
  });

  const specObj = SPECS[shared.spec];
  if (!specObj) throw new Error(`unknown spec: ${shared.spec}`);

  let runtime = null;
  let session = null;
  const maxRtRetries = shared.runtimeRetries;

  try {
    for (let attempt = 1; attempt <= maxRtRetries; attempt++) {
      if (!shared.hasPending()) return;
      log(`creating runtime (${shared.spec}, attempt ${attempt}/${maxRtRetries})...`);
      try {
        const rt = await client.callTool('create_runtime', {
          requestId: randomUUID(),
          runtime: { runtimeSpec: specObj },
        });
        runtime = pickRuntime(rt.text);
        if (runtime) break;
        log(`no runtime returned: ${rt.text.slice(0, 200)}`);
      } catch (e) {
        log(`create_runtime error: ${e.message.slice(0, 200)}`);
      }
      if (attempt < maxRtRetries) await new Promise((r) => setTimeout(r, 8000 * attempt));
    }

    if (!runtime) {
      log('unable to acquire runtime; yielding remaining chunks to other accounts.');
      return;
    }
    log(`runtime ready: ${runtime}`);

    const ses = await client.callTool('create_session', { parent: runtime });
    session = pickSession(ses.text);
    if (!session) throw new Error(`create_session failed: ${ses.text.slice(0, 300)}`);

    let remoteBlendPath = '';
    if (shared.blendAbs) {
      log(`uploading ${path.basename(shared.blendAbs)}...`);
      const up = await client.uploadFile(runtime, shared.blendAbs, 'job/scene.blend');
      remoteBlendPath = up.remotePath;
      log(`uploaded ${up.bytes} bytes -> ${remoteBlendPath}`);
    }

    while (true) {
      const chunk = shared.claimNext();
      if (!chunk) break;

      const t0 = Date.now();
      const remoteZip = `/content/job/${chunk.id}.zip`;
      const localZip = path.join(shared.chunksDir, `${chunk.id}.zip`);
      log(`rendering ${chunk.id} (frames ${chunk.start}..${chunk.end})...`);

      try {
        const code = runWorkerScriptCode(shared.workerPy, {
          CK_BLEND_PATH: remoteBlendPath,
          CK_START: chunk.start,
          CK_END: chunk.end,
          CK_OUT_ZIP: remoteZip,
          CK_SAMPLES: shared.samples,
          CK_RES: shared.res,
        });

        const executionId = randomUUID();
        let execRes = null;
        for (let tryWait = 1; tryWait <= 3; tryWait++) {
          try {
            execRes = await client.callTool('execute_code', { session, executionId, code });
            break;
          } catch (e) {
            if (isTimeoutError(e.message) && tryWait < 3) {
              log(`execute_code timeout on ${chunk.id}, resuming with same executionId (${tryWait}/3)...`);
              continue;
            }
            throw e;
          }
        }

        const p = execRes?.structured || {};
        const stdout = p.stdout ?? execRes?.text ?? '';
        if (p.executionError || !stdout.includes('CHUNK_OK')) {
          throw new Error(`remote render failed: ${JSON.stringify(p.executionError || stdout.slice(-400))}`);
        }

        const dl = await client.downloadFile(runtime, remoteZip, localZip);
        if (!fs.existsSync(localZip) || fs.statSync(localZip).size === 0) {
          throw new Error(`downloaded zip empty: ${localZip}`);
        }

        const elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
        shared.markDone(chunk, { file: localZip, worker: profile.name, elapsedSec });
        log(`done ${chunk.id} (${dl.bytes} bytes, ${elapsedSec}s)`);
      } catch (e) {
        log(`chunk ${chunk.id} failed: ${e.message.slice(0, 240)}`);
        shared.markPending(chunk, e.message);
        // If session/runtime died, stop this worker cleanly so healthy workers finish.
        if (/not found|terminated|unavailable|session|runtime/i.test(e.message)) {
          log('runtime/session lost; releasing worker.');
          break;
        }
      }
    }
  } finally {
    if (session) await client.callTool('delete_session', { name: session }).catch(() => {});
    if (runtime) {
      await client.callTool('delete_runtime', { name: runtime }).catch(() => {});
      log(`deleted runtime ${runtime}`);
    }
  }
}

function packageLocally({ outDir, manifest, fps, noVideo }) {
  const framesDir = path.join(outDir, 'frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const doneChunks = manifest.chunks.filter((c) => c.status === 'done' && c.file && fs.existsSync(c.file));
  for (const c of doneChunks) {
    execFileSync('tar.exe', ['-xf', c.file, '-C', framesDir], { stdio: 'inherit' });
  }

  const frameFiles = fs.readdirSync(framesDir).filter((f) => /^frame_\d+\.png$/i.test(f)).sort();
  if (frameFiles.length === 0) throw new Error(`no frames extracted into ${framesDir}`);

  const zipPath = path.join(outDir, 'frames_all.zip');
  fs.rmSync(zipPath, { force: true });
  execFileSync('tar.exe', ['-a', '-cf', zipPath, '-C', framesDir, '.'], { stdio: 'inherit' });

  let videoPath = null;
  if (!noVideo) {
    const listFile = path.join(outDir, 'ffmpeg_frames.txt');
    const dur = (1 / fps).toFixed(6);
    const lines = frameFiles.map((f) => `file '${path.join(framesDir, f).replace(/'/g, "'\\''")}'\nduration ${dur}`);
    lines.push(`file '${path.join(framesDir, frameFiles[frameFiles.length - 1]).replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');

    const mp4 = path.join(outDir, 'final.mp4');
    fs.rmSync(mp4, { force: true });
    try {
      execFileSync(
        'ffmpeg',
        ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), mp4],
        { stdio: 'pipe' }
      );
      if (fs.existsSync(mp4) && fs.statSync(mp4).size > 0) videoPath = mp4;
    } catch (e) {
      console.warn(`ffmpeg encode skipped/failed: ${e.message}`);
    }
  }

  return { frameCount: frameFiles.length, framesDir, zipPath, videoPath };
}

async function main() {
  if (ensureWindowsProxyEnv()) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env });
    process.exit(r.status ?? 1);
  }

  const packOnly = hasFlag('pack-only');
  const smoke = hasFlag('smoke');
  const blend = getArg('blend', '');
  const outDir = path.resolve(getArg('out', 'out-blender'));
  const manifestPath = path.join(outDir, 'manifest.json');
  const chunksDir = path.join(outDir, 'chunks');
  const fps = Number(getArg('fps', '24'));
  const noVideo = hasFlag('no-video');

  if (!packOnly && !smoke && !blend) {
    throw new Error('pass --blend <file.blend>, --smoke, or --pack-only');
  }
  const blendAbs = blend ? path.resolve(blend) : '';
  if (blendAbs && !fs.existsSync(blendAbs)) throw new Error(`blend file not found: ${blendAbs}`);

  const start = Number(getArg('start', '1'));
  const end = Number(getArg('end', smoke ? '4' : '1'));
  const batch = Math.max(1, Number(getArg('batch', smoke ? '2' : '25')));
  const spec = getArg('spec', 'gpu_t4');
  const samples = getArg('samples', '');
  const res = getArg('res', '');
  const runtimeRetries = Math.max(1, Number(getArg('runtime-retries', '2')));

  const manifest = loadOrInitManifest(manifestPath, { blend: blendAbs || null, smoke, start, end, batch, spec, fps });
  saveManifest(manifestPath, manifest);

  if (!packOnly) {
    fs.mkdirSync(chunksDir, { recursive: true });
    const profiles = loadProfiles(getArg('mcp-config', DEFAULT_MCP_CFG), getArg('profiles', null));
    const workerPy = fs.readFileSync(WORKER_PY, 'utf8');

    const shared = {
      spec,
      blendAbs,
      samples,
      res,
      chunksDir,
      workerPy,
      runtimeRetries,
      hasPending: () => manifest.chunks.some((c) => c.status === 'pending'),
      claimNext: () => {
        const c = manifest.chunks.find((x) => x.status === 'pending');
        if (!c) return null;
        c.status = 'running';
        saveManifest(manifestPath, manifest);
        return c;
      },
      markDone: (c, info) => {
        Object.assign(c, { status: 'done', error: null, ...info });
        saveManifest(manifestPath, manifest);
      },
      markPending: (c, err) => {
        c.status = 'pending';
        c.worker = null;
        c.error = String(err || '').slice(0, 300);
        saveManifest(manifestPath, manifest);
      },
    };

    console.log(`Starting ${profiles.length} worker(s) for frames ${manifest.start}..${manifest.end} (${manifest.chunks.length} chunks, spec=${spec})`);
    await Promise.all(profiles.map((p) => runAccountWorker(p, shared)));
  }

  const doneCount = manifest.chunks.filter((c) => c.status === 'done').length;
  const totalCount = manifest.chunks.length;
  let packaged = null;
  if (doneCount === totalCount && totalCount > 0) {
    packaged = packageLocally({ outDir, manifest, fps: manifest.fps || fps, noVideo });
  }

  const summary = {
    ok: doneCount === totalCount,
    doneChunks: doneCount,
    totalChunks: totalCount,
    manifestPath,
    packaged,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
