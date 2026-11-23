#!/usr/bin/env node
// blender_render_batch.mjs -- Dynamic Hybrid (Colab Cloud Pool + Local GPU) Blender Batch Renderer & Packager.
//
// Features:
//   - Hybrid pool by default (--hybrid auto): small tasks run locally without cold-start overhead;
//     large tasks run Local Quiet GPU (from tail) + Multi-Account Colab GPUs (from head) in parallel.
//   - Explicit mode selection: --hybrid auto | on | cloud-only | local-only (or --cloud-only / --local-only).
//   - Dynamic compute allocation: EWMA adaptive batch sizing + speculative tail splitting.
//   - Auto GPU tier probe (--spec auto: A100 -> L4 -> T4_HIGHMEM -> T4) + background Late-Join re-probing.
//   - Staggered startup, upload retries, 600s/terminated executionId reattach, and disk+manifest resume.
//   - Automatic local packaging: frames_all.zip + final.mp4 + timing.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SPECS,
  createColabClient,
  ensureWindowsProxyEnv,
  interruptibleSleep,
  isTransientOrTimeoutError,
  parseEligibleSpecs,
  pickRuntime,
  pickSession,
} from './colab_client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PY = path.join(HERE, 'blender_chunk_worker.py');
const INNER_PY = path.join(HERE, 'blender_inner_render.py');
const DEFAULT_MCP_CFG = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'colab', 'mcp_config.json');

const args = process.argv.slice(2);
const hasFlag = (k) => args.includes('--' + k);
const getArg = (k, d = null) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

function findLocalBlender(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.BLENDER_PATH) candidates.push(process.env.BLENDER_PATH);

  try {
    const which = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['blender'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    for (const line of which.split(/\r?\n/)) if (line.trim()) candidates.push(line.trim());
  } catch {}

  if (process.platform === 'win32') {
    const bf = 'C:\\Program Files\\Blender Foundation';
    if (fs.existsSync(bf)) {
      const dirs = fs.readdirSync(bf).filter((d) => /^Blender\s+\d+/i.test(d)).sort().reverse();
      for (const d of dirs) candidates.push(path.join(bf, d, 'blender.exe'));
    }
    for (const regKey of [
      'HKCU\\Software\\Classes\\blendfile\\shell\\open\\command',
      'HKCR\\blendfile\\shell\\open\\command',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\blender.exe',
    ]) {
      try {
        const out = execFileSync('reg', ['query', regKey, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const m = out.match(/"([^"]*blender[^"]*\.exe)"/i) || out.match(/([A-Za-z]:\\[^\r\n"]*blender[^"\r\n]*\.exe)/i);
        if (m?.[1]) candidates.push(m[1].replace('blender-launcher.exe', 'blender.exe'));
      } catch {}
    }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      let version = null;
      let series = '';
      try {
        const vOut = execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        const vm = vOut.match(/Blender\s+(\d+\.\d+)\.(\d+)/i);
        if (vm) {
          version = `${vm[1]}.${vm[2]}`;
          series = `Blender${vm[1]}`;
        }
      } catch {}
      return { path: c, version, series };
    }
  }
  return null;
}

function loadProfiles(mcpCfgPath, filterNames) {
  if (!fs.existsSync(mcpCfgPath)) return [];
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
  return list;
}

function frameFileName(f) {
  return `frame_${String(f).padStart(6, '0')}.png`;
}

function isFramePresent(dir, f, minBytes = 500) {
  const p = path.join(dir, frameFileName(f));
  return fs.existsSync(p) && fs.statSync(p).size >= minBytes;
}

function allFramesPresent(dir, frames, minBytes = 500) {
  for (const f of frames) {
    if (!isFramePresent(dir, f, minBytes)) return false;
  }
  return true;
}

function parseFrameList() {
  const csv = getArg('frames', '');
  if (csv) {
    return Array.from(new Set(csv.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0))).sort((a, b) => a - b);
  }
  const smoke = hasFlag('smoke');
  const start = Number(getArg('start', '1'));
  const end = Number(getArg('end', smoke ? '4' : '1'));
  const step = Math.max(1, Number(getArg('step', '1')));
  const list = [];
  for (let f = start; f <= end; f += step) list.push(f);
  return list;
}

function inspectAndInitState(manifestPath, opts) {
  let prev = null;
  if (fs.existsSync(manifestPath)) {
    prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!opts.dryRun) {
      fs.mkdirSync(opts.framesDir, { recursive: true });
      for (const c of prev.chunks || []) {
        if (c.status === 'done' && c.zipFile && fs.existsSync(c.zipFile) && !allFramesPresent(opts.framesDir, c.frames || [], opts.minBytes)) {
          execFileSync('tar.exe', ['-xf', c.zipFile, '-C', opts.framesDir], { stdio: 'inherit' });
        }
      }
    }
  }

  const doneChunks = (prev?.chunks || []).filter(
    (c) => c.status === 'done' && Array.isArray(c.frames) && c.frames.length > 0 && allFramesPresent(opts.framesDir, c.frames, opts.minBytes)
  );
  const pending = opts.frameList.filter((f) => !isFramePresent(opts.framesDir, f, opts.minBytes));

  const manifest = {
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    blend: opts.blend || null,
    smoke: !!opts.smoke,
    spec: opts.spec,
    hybrid: opts.hybrid,
    fps: opts.fps,
    samples: opts.samples || null,
    res: opts.res || null,
    depth: opts.depth || null,
    frameList: opts.frameList,
    chunks: doneChunks,
    pendingCount: pending.length,
  };
  return { manifest, pending };
}

function saveManifest(manifestPath, manifest, pending) {
  manifest.updatedAt = new Date().toISOString();
  manifest.pendingCount = pending.length;
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function injectEnvPython(pyTemplate, envMap) {
  const lines = Object.entries(envMap)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(String(v))}`)
    .join('\n');
  return `import os\n${lines}\n` + pyTemplate;
}

function createSharedCoordinator(manifestPath, statusPath, manifest, pending, opts) {
  let seqId = manifest.chunks.length;
  const activeWorkers = new Map();
  const inFlight = new Map();
  const nodeStates = new Map();

  const save = () => saveManifest(manifestPath, manifest, pending);

  const saveClusterStatus = (printLine = false) => {
    const nodes = {};
    let onlineCloud = 0;
    let standbyCloud = 0;
    let offlineCloud = 0;
    let totalCloud = 0;
    let onlineLocal = 0;
    const onlineNames = [];

    for (const [name, st] of nodeStates.entries()) {
      nodes[name] = st;
      if (st.isLocal) {
        if (st.state === 'online_rendering' || st.state === 'starting') onlineLocal += 1;
      } else {
        totalCloud += 1;
        if (st.state === 'online_rendering' || st.state === 'uploading' || st.state === 'starting') {
          onlineCloud += 1;
          onlineNames.push(`${name}(${st.spec || '?'})`);
        } else if (st.state === 'standby' || st.state === 'probing') {
          standbyCloud += 1;
        } else {
          offlineCloud += 1;
        }
      }
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      route: opts.routeLabel,
      pendingFrames: pending.length,
      inFlightChunks: inFlight.size,
      summary: { totalCloud, onlineCloud, standbyCloud, offlineCloud, onlineLocal },
      nodes,
    };
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2));
    if (printLine) {
      const listStr = onlineNames.length > 0 ? ` [${onlineNames.join(', ')}]` : '';
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] [CLUSTER] cloud_online=${onlineCloud}/${totalCloud}${listStr} | standby=${standbyCloud} | offline=${offlineCloud} | local=${onlineLocal} | pending=${pending.length}f`
      );
    }
  };

  const setNodeState = (name, patch, printLine = false) => {
    const prev = nodeStates.get(name) || {
      isLocal: false,
      state: 'probing',
      spec: null,
      runtime: null,
      chunksDone: 0,
      framesDone: 0,
      ewmaSecPerFrame: null,
      lastEvent: '',
    };
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    nodeStates.set(name, next);
    saveClusterStatus(printLine);
  };

  return {
    ...opts,
    pending,
    totalPending: () => pending.length,
    totalInFlight: () => inFlight.size,
    hasPending: () => pending.length > 0,
    setNodeState,
    getNodeState: (name) => nodeStates.get(name),
    getClusterSnapshot: () => {
      let onlineCloud = 0;
      let totalCloud = 0;
      for (const st of nodeStates.values()) {
        if (!st.isLocal) {
          totalCloud += 1;
          if (['online_rendering', 'uploading', 'starting'].includes(st.state)) onlineCloud += 1;
        }
      }
      return { onlineCloud, totalCloud };
    },

    registerWorker: (name, isLocal = false) => activeWorkers.set(name, { isLocal }),
    unregisterWorker: (name) => activeWorkers.delete(name),

    claimDynamic: ({ workerName, ewmaSecPerFrame, isLocal, fromTail }) => {
      if (pending.length === 0) return null;

      const initB = isLocal ? opts.localInitBatch : opts.initBatch;
      const maxB = isLocal ? opts.localMaxBatch : opts.maxBatch;
      let desired = opts.fixedBatch
        ? initB
        : ewmaSecPerFrame > 0
          ? Math.round(opts.targetSec / ewmaSecPerFrame)
          : initB;
      desired = Math.max(opts.minBatch, Math.min(maxB, desired));

      const onlineCount = Math.max(1, activeWorkers.size);
      if (!opts.fixedBatch && pending.length <= onlineCount * desired) {
        const tailShare = Math.ceil(pending.length / onlineCount);
        desired = Math.min(desired, Math.max(opts.minBatch, tailShare));
      }

      const take = Math.max(1, Math.min(desired, pending.length));
      const frames = fromTail ? pending.splice(pending.length - take, take) : pending.splice(0, take);

      const chunk = {
        id: `chunk_${String(++seqId).padStart(4, '0')}_${String(frames[0]).padStart(6, '0')}_${String(frames[frames.length - 1]).padStart(6, '0')}`,
        frames,
        status: 'running',
        zipFile: null,
        worker: workerName,
        elapsedSec: null,
        renderSec: null,
        error: null,
      };
      inFlight.set(chunk.id, chunk);
      save();
      return chunk;
    },

    markDone: (chunk, info) => {
      inFlight.delete(chunk.id);
      Object.assign(chunk, { status: 'done', error: null, ...info });
      manifest.chunks.push(chunk);
      save();
    },

    markPending: (chunk, err) => {
      inFlight.delete(chunk.id);
      const merged = new Set(pending);
      for (const f of chunk.frames || []) {
        if (!isFramePresent(opts.framesDir, f, opts.minBytes)) merged.add(f);
      }
      const rebuilt = Array.from(merged).sort((a, b) => a - b);
      pending.splice(0, pending.length, ...rebuilt);
      chunk.status = 'pending';
      chunk.error = String(err || '').slice(0, 300);
      save();
    },
  };
}

async function runCloudWorker(profile, shared, workerIndex = 0) {
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${profile.name}] ${m}`);
  shared.setNodeState(profile.name, { isLocal: false, state: 'probing', lastEvent: 'queued' }, false);

  if (workerIndex > 0 && shared.staggerMs > 0) {
    const delayMs = workerIndex * shared.staggerMs;
    log(`staggering initial wave by ${(delayMs / 1000).toFixed(1)}s...`);
    const okWait = await interruptibleSleep(delayMs, () => !shared.hasPending());
    if (!okWait) {
      shared.setNodeState(profile.name, { state: 'offline', lastEvent: 'completed before stagger' }, false);
      return;
    }
  }

  let wave = 0;
  let cachedAutoSpecs = null;
  let ewmaSecPerFrame = 0;

  while (shared.hasPending()) {
    wave += 1;
    if (wave > 1 && shared.totalPending() < shared.lateJoinMinFrames) {
      log(`remaining ${shared.totalPending()} frames < late-join threshold (${shared.lateJoinMinFrames}); exiting.`);
      shared.setNodeState(profile.name, { state: 'offline', lastEvent: 'exited (low remaining)' }, false);
      return;
    }

    let client = null;
    let runtime = null;
    let session = null;
    let acquiredSpec = null;

    try {
      let specList;
      if (shared.spec === 'auto') {
        if (!cachedAutoSpecs) {
          try {
            const probeClient = createColabClient({
              quotaProject: profile.quotaProject,
              cloudSdkConfig: profile.cloudSdkConfig,
              gcloudCmd: profile.gcloudCmd,
            });
            const sRes = await probeClient.callTool('list_runtime_specs', {});
            cachedAutoSpecs = parseEligibleSpecs(sRes);
            log(`auto eligible specs: ${cachedAutoSpecs.join(' -> ')}`);
          } catch (e) {
            cachedAutoSpecs = ['gpu_t4'];
            log(`list_runtime_specs failed (${e.message.slice(0, 120)}), defaulting to gpu_t4`);
          }
        }
        specList = cachedAutoSpecs;
      } else {
        if (!SPECS[shared.spec]) throw new Error(`unknown spec: ${shared.spec}`);
        specList = [shared.spec];
      }

      const maxAttempts = wave === 1 ? shared.runtimeRetries : 1;
      for (let attempt = 1; attempt <= maxAttempts && !runtime; attempt++) {
        for (const specKey of specList) {
          if (!shared.hasPending()) {
            shared.setNodeState(profile.name, { state: 'offline', lastEvent: 'no pending frames' }, false);
            return;
          }
          client = createColabClient({
            quotaProject: profile.quotaProject,
            cloudSdkConfig: profile.cloudSdkConfig,
            gcloudCmd: profile.gcloudCmd,
          });
          shared.setNodeState(profile.name, { state: 'probing', spec: specKey, lastEvent: `create_runtime wave=${wave} try=${attempt}` }, false);
          log(`creating runtime (${specKey}, wave ${wave} attempt ${attempt}/${maxAttempts})...`);
          try {
            const rt = await client.callTool('create_runtime', {
              requestId: randomUUID(),
              runtime: { runtimeSpec: SPECS[specKey] },
            });
            runtime = pickRuntime(rt.text);
            if (runtime) {
              acquiredSpec = specKey;
              break;
            }
            log(`no runtime returned (${specKey}): ${rt.text.slice(0, 200)}`);
          } catch (e) {
            log(`create_runtime (${specKey}) error: ${e.message.slice(0, 200)}`);
          }
        }
        if (!runtime && attempt < maxAttempts) {
          const waitMs = 10000 * attempt + Math.floor(Math.random() * 4000);
          const okSleep = await interruptibleSleep(waitMs, () => !shared.hasPending());
          if (!okSleep) return;
        }
      }

      if (!runtime) {
        if (shared.totalPending() < shared.lateJoinMinFrames) {
          log('no runtime acquired and remaining work below late-join threshold; exiting.');
          shared.setNodeState(profile.name, { state: 'offline', spec: null, runtime: null, lastEvent: 'no gpu capacity' }, true);
          return;
        }
        const sleepSec = shared.reprobeSec + Math.floor(Math.random() * 20);
        shared.setNodeState(profile.name, { state: 'standby', spec: null, runtime: null, lastEvent: `standby (${sleepSec}s)` }, true);
        log(`late-join standby: will re-probe in ${sleepSec}s while >= ${shared.lateJoinMinFrames} frames remain...`);
        const woke = await interruptibleSleep(sleepSec * 1000, () => shared.totalPending() < shared.lateJoinMinFrames);
        if (!woke) {
          shared.setNodeState(profile.name, { state: 'offline', lastEvent: 'standby finished' }, false);
          return;
        }
        continue;
      }

      log(`runtime ready (${acquiredSpec}): ${runtime}`);
      if (!shared.hasPending()) {
        log('queue already drained before session setup; skipping upload and releasing runtime.');
        shared.setNodeState(profile.name, { state: 'offline', spec: acquiredSpec, runtime, lastEvent: 'queue already drained' }, false);
        break;
      }
      shared.setNodeState(profile.name, { state: 'starting', spec: acquiredSpec, runtime, lastEvent: 'runtime ready' }, true);
      const ses = await client.callTool('create_session', { parent: runtime });
      session = pickSession(ses.text);
      if (!session) throw new Error(`create_session failed: ${ses.text.slice(0, 300)}`);

      let remoteBlendPath = '';
      if (shared.blendAbs && shared.hasPending()) {
        shared.setNodeState(profile.name, { state: 'uploading', lastEvent: `uploading ${path.basename(shared.blendAbs)}` }, false);
        for (let upTry = 1; upTry <= 3; upTry++) {
          try {
            log(`uploading ${path.basename(shared.blendAbs)}${upTry > 1 ? ` (retry ${upTry}/3)` : ''}...`);
            const up = await client.uploadFile(runtime, shared.blendAbs, 'job/scene.blend');
            remoteBlendPath = up.remotePath;
            log(`uploaded ${up.bytes} bytes -> ${remoteBlendPath}`);
            break;
          } catch (e) {
            log(`upload error (${upTry}/3): ${e.message.slice(0, 200)}`);
            if (upTry >= 3 || /not found|unavailable|404|410|FAILED_PRECONDITION/i.test(e.message)) throw e;
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }

      let blenderWarm = false;
      shared.registerWorker(profile.name, false);
      shared.setNodeState(profile.name, { state: 'online_rendering', lastEvent: 'rendering chunks' }, true);

      while (true) {
        const chunk = shared.claimDynamic({
          workerName: profile.name,
          ewmaSecPerFrame,
          isLocal: false,
          fromTail: false,
        });
        if (!chunk) break;

        const tChunk0 = Date.now();
        try {
          const remoteZip = `/content/job/${chunk.id}.zip`;
          const localZip = path.join(shared.chunksDir, `${chunk.id}.zip`);
          const rateTag = ewmaSecPerFrame > 0 ? `${ewmaSecPerFrame.toFixed(2)}s/f` : 'cold';
          log(`rendering ${chunk.id} (${chunk.frames.length}f [${rateTag}]: ${chunk.frames[0]}..${chunk.frames[chunk.frames.length - 1]})...`);

          const code = injectEnvPython(shared.workerPy, {
            CK_BLEND_PATH: remoteBlendPath,
            CK_FRAMES: chunk.frames.join(','),
            CK_OUT_ZIP: remoteZip,
            CK_BLENDER_SERIES: shared.blenderSeries,
            CK_SAMPLES: shared.samples,
            CK_RES: shared.res,
            CK_DEPTH: shared.depth,
            CK_MIN_BYTES: shared.minBytes,
            CK_INNER_PY_B64: shared.innerPyB64,
          });

          const tExec0 = Date.now();
          const executionId = randomUUID();
          let execRes = null;
          let reattached = false;
          for (let tryWait = 1; tryWait <= 6; tryWait++) {
            try {
              execRes = await client.callTool('execute_code', { session, executionId, code });
              break;
            } catch (e) {
              if (isTransientOrTimeoutError(e.message) && tryWait < 6) {
                reattached = true;
                log(`execute_code interrupted on ${chunk.id} (${e.message.slice(0, 100)}), reattaching (${tryWait}/6)...`);
                await new Promise((r) => setTimeout(r, 4000));
                continue;
              }
              throw e;
            }
          }

          const p = execRes?.structured || {};
          const stdout = p.stdout ?? execRes?.text ?? '';
          if (p.executionError || !stdout.includes('CHUNK_OK')) {
            throw new Error(`remote render failed: ${JSON.stringify(p.executionError || stdout.slice(-500))}`);
          }

          const wasWarm = blenderWarm || /BLENDER\s+\S+\s+reuse/i.test(stdout);
          blenderWarm = true;

          const dl = await client.downloadFile(runtime, remoteZip, localZip);
          if (!fs.existsSync(localZip) || fs.statSync(localZip).size === 0) {
            throw new Error(`downloaded zip empty: ${localZip}`);
          }

          fs.mkdirSync(shared.framesDir, { recursive: true });
          execFileSync('tar.exe', ['-xf', localZip, '-C', shared.framesDir], { stdio: 'inherit' });
          if (!allFramesPresent(shared.framesDir, chunk.frames, shared.minBytes)) {
            throw new Error(`missing extracted frame(s) for ${chunk.id}`);
          }

          const execSec = +((Date.now() - tExec0) / 1000).toFixed(2);
          const elapsedSec = +((Date.now() - tChunk0) / 1000).toFixed(1);
          if (wasWarm || reattached) {
            const sampleRate = Math.max(0.25, execSec / chunk.frames.length);
            ewmaSecPerFrame = ewmaSecPerFrame > 0 ? 0.55 * sampleRate + 0.45 * ewmaSecPerFrame : sampleRate;
          }

          shared.markDone(chunk, {
            zipFile: localZip,
            worker: profile.name,
            spec: acquiredSpec,
            elapsedSec,
            renderSec: execSec,
          });
          const curSt = shared.getNodeState(profile.name);
          shared.setNodeState(
            profile.name,
            {
              chunksDone: (curSt?.chunksDone || 0) + 1,
              framesDone: (curSt?.framesDone || 0) + chunk.frames.length,
              ewmaSecPerFrame: ewmaSecPerFrame > 0 ? +ewmaSecPerFrame.toFixed(2) : null,
              lastEvent: `done ${chunk.id} (${execSec}s)`,
            },
            true
          );
          log(`done ${chunk.id} (${dl.bytes}B, ${elapsedSec}s wall / ${execSec}s exec)`);
        } catch (e) {
          log(`chunk ${chunk.id} failed: ${e.message.slice(0, 240)}`);
          shared.markPending(chunk, e.message);
          shared.setNodeState(profile.name, { lastEvent: `chunk error: ${e.message.slice(0, 80)}` }, false);
          if (/not found|unavailable|404|410|FAILED_PRECONDITION|session.*closed|runtime.*deleted/i.test(e.message)) {
            log('runtime/session lost; releasing worker.');
            break;
          }
        }
      }
    } finally {
      shared.unregisterWorker(profile.name);
      if (client && session) await client.callTool('delete_session', { name: session }).catch(() => {});
      if (client && runtime) {
        await client.callTool('delete_runtime', { name: runtime }).catch(() => {});
        log(`deleted runtime ${runtime}`);
      }
      shared.setNodeState(profile.name, { state: 'offline', runtime: null, lastEvent: 'runtime deleted' }, false);
    }

    if (!shared.hasPending() || shared.totalPending() < shared.lateJoinMinFrames) break;
    const sleepSec = shared.reprobeSec + Math.floor(Math.random() * 20);
    log(`re-entering standby for ${sleepSec}s...`);
    const woke = await interruptibleSleep(sleepSec * 1000, () => shared.totalPending() < shared.lateJoinMinFrames);
    if (!woke) break;
  }
}

function runLocalBlenderOnce({ blenderExe, blendAbs, smoke, frames, framesDir, samples, res, depth, localMode, forceCuda }) {
  return new Promise((resolve, reject) => {
    const threads = localMode === 'quiet' ? '4' : '0';
    const bArgs = ['-b', '-t', threads, '--python-exit-code', '1'];
    if (smoke || !blendAbs) bArgs.push('--factory-startup');
    else bArgs.push(blendAbs);
    bArgs.push('-P', INNER_PY, '--', `frames=${frames.join(',')}`, `out_dir=${framesDir}`, `smoke=${smoke || !blendAbs ? 1 : 0}`, `force_cuda=${forceCuda ? 1 : 0}`);
    if (samples) bArgs.push(`samples=${samples}`);
    if (res) bArgs.push(`res=${res}`);
    if (depth) bArgs.push(`depth=${depth}`);

    const child = spawn(blenderExe, bArgs, { windowsHide: true });
    if (localMode === 'quiet' && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`local blender exit ${code}: ${(stderr || stdout).slice(-400)}`));
        return;
      }
      const m = stdout.match(/RENDER_DONE\s+count=(\d+)\s+render_s=([0-9.]+)/);
      resolve({ stdout, renderSec: m ? Number(m[2]) : null });
    });
  });
}

async function runLocalWorker(localBlender, shared) {
  const workerName = `local_${shared.localMode}`;
  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${workerName}] ${m}`);
  let ewmaSecPerFrame = 0;
  shared.registerWorker(workerName, true);
  shared.setNodeState(
    workerName,
    {
      isLocal: true,
      state: 'online_rendering',
      spec: `local_${shared.localMode}_${localBlender.version || 'unknown'}`,
      lastEvent: 'local worker started',
    },
    true
  );

  try {
    while (shared.hasPending()) {
      const chunk = shared.claimDynamic({
        workerName,
        ewmaSecPerFrame,
        isLocal: true,
        fromTail: true,
      });
      if (!chunk) break;

      const t0 = Date.now();
      const rateTag = ewmaSecPerFrame > 0 ? `${ewmaSecPerFrame.toFixed(2)}s/f` : 'cold';
      log(`rendering ${chunk.id} (${chunk.frames.length}f [${rateTag}]: ${chunk.frames[0]}..${chunk.frames[chunk.frames.length - 1]})...`);

      try {
        let resRun;
        try {
          resRun = await runLocalBlenderOnce({
            blenderExe: localBlender.path,
            blendAbs: shared.blendAbs,
            smoke: shared.smoke,
            frames: chunk.frames,
            framesDir: shared.framesDir,
            samples: shared.samples,
            res: shared.res,
            depth: shared.depth,
            localMode: shared.localMode,
            forceCuda: false,
          });
        } catch (e) {
          log(`local OPTIX attempt failed (${e.message.slice(0, 120)}), retrying CUDA...`);
          resRun = await runLocalBlenderOnce({
            blenderExe: localBlender.path,
            blendAbs: shared.blendAbs,
            smoke: shared.smoke,
            frames: chunk.frames,
            framesDir: shared.framesDir,
            samples: shared.samples,
            res: shared.res,
            depth: shared.depth,
            localMode: shared.localMode,
            forceCuda: true,
          });
        }

        if (!allFramesPresent(shared.framesDir, chunk.frames, shared.minBytes)) {
          throw new Error(`local missing frame(s) for ${chunk.id}`);
        }
        const elapsedSec = +((Date.now() - t0) / 1000).toFixed(2);
        const rate = Math.max(0.15, elapsedSec / chunk.frames.length);
        ewmaSecPerFrame = ewmaSecPerFrame > 0 ? 0.6 * rate + 0.4 * ewmaSecPerFrame : rate;

        shared.markDone(chunk, {
          zipFile: null,
          worker: workerName,
          spec: `local_${shared.localMode}_${localBlender.version || 'unknown'}`,
          elapsedSec,
          renderSec: resRun.renderSec ?? elapsedSec,
        });
        const curSt = shared.getNodeState(workerName);
        shared.setNodeState(
          workerName,
          {
            chunksDone: (curSt?.chunksDone || 0) + 1,
            framesDone: (curSt?.framesDone || 0) + chunk.frames.length,
            ewmaSecPerFrame: +ewmaSecPerFrame.toFixed(2),
            lastEvent: `done ${chunk.id} (${elapsedSec}s)`,
          },
          true
        );
        log(`done ${chunk.id} (${elapsedSec}s wall, ${rate.toFixed(2)}s/f)`);
      } catch (e) {
        log(`chunk ${chunk.id} failed: ${e.message.slice(0, 240)}`);
        shared.markPending(chunk, e.message);
        shared.setNodeState(workerName, { state: 'offline', lastEvent: `error: ${e.message.slice(0, 80)}` }, true);
        break;
      }
    }
  } finally {
    shared.unregisterWorker(workerName);
    shared.setNodeState(workerName, { state: 'done', lastEvent: 'finished' }, false);
  }
}

function packageLocally({ outDir, framesDir, frameList, fps, noVideo }) {
  const frameFiles = frameList.map((f) => frameFileName(f)).filter((n) => fs.existsSync(path.join(framesDir, n)));
  if (frameFiles.length === 0) throw new Error(`no frames found in ${framesDir}`);

  const zipPath = path.join(outDir, 'frames_all.zip');
  fs.rmSync(zipPath, { force: true });
  execFileSync('tar.exe', ['-a', '-cf', zipPath, '-C', framesDir, ...frameFiles], { stdio: 'inherit' });

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

function resolveBlendForCloud(localBlender, blendAbs, outDir, autoPack) {
  if (!autoPack || !blendAbs || !localBlender) return blendAbs;
  const packedPath = path.join(outDir, 'staged_packed.blend');
  const py = 'import bpy, sys; bpy.ops.file.pack_all(); bpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1], compress=True)';
  console.log(`Packing external assets into ${packedPath} using local Blender...`);
  execFileSync(localBlender.path, ['-b', blendAbs, '--python-expr', py, '--', packedPath], {
    stdio: 'pipe',
    windowsHide: true,
  });
  return packedPath;
}

async function main() {
  if (ensureWindowsProxyEnv()) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env });
    process.exit(r.status ?? 1);
  }

  const tWall0 = Date.now();
  const packOnly = hasFlag('pack-only');
  const dryRun = hasFlag('dry-run');
  const smoke = hasFlag('smoke');
  const blend = getArg('blend', '');
  const outDir = path.resolve(getArg('out', 'out-blender'));
  const framesDir = path.join(outDir, 'frames');
  const chunksDir = path.join(outDir, 'chunks');
  const manifestPath = path.join(outDir, 'manifest.json');
  const statusPath = path.join(outDir, 'cluster_status.json');
  const timingOut = path.join(outDir, 'timing.json');

  if (!packOnly && !smoke && !blend) {
    throw new Error('pass --blend <file.blend>, --smoke, or --pack-only');
  }
  const blendAbsOrig = blend ? path.resolve(blend) : '';
  if (blendAbsOrig && !fs.existsSync(blendAbsOrig)) throw new Error(`blend file not found: ${blendAbsOrig}`);

  const frameList = parseFrameList();
  if (frameList.length === 0) throw new Error('empty frame list');

  const fps = Number(getArg('fps', '24'));
  const samples = getArg('samples', '');
  const res = getArg('res', '');
  const depth = getArg('depth', '');
  const minBytes = Math.max(100, Number(getArg('min-bytes', smoke ? '500' : '2000')));
  const noVideo = hasFlag('no-video');
  const autoPack = hasFlag('auto-pack');

  const explicitBatch = getArg('batch', null);
  const fixedBatch = hasFlag('fixed-batch');
  const initBatch = Math.max(1, Number(getArg('init-batch', explicitBatch || '10')));
  const minBatch = Math.max(1, Number(getArg('min-batch', explicitBatch ? Math.min(4, initBatch) : '4')));
  const maxBatch = Math.max(minBatch, Number(getArg('max-batch', '40')));
  const localInitBatch = Math.max(1, Number(getArg('local-init-batch', explicitBatch || '16')));
  const localMaxBatch = Math.max(localInitBatch, Number(getArg('local-max-batch', '80')));
  const targetSec = Math.max(10, Number(getArg('target-sec', '55')));

  const spec = getArg('spec', 'auto');
  const runtimeRetries = Math.max(1, Number(getArg('runtime-retries', '3')));
  const staggerMs = Math.max(0, Number(getArg('stagger-ms', '6000')));
  const reprobeSec = Math.max(30, Number(getArg('reprobe-sec', '150')));
  const lateJoinMinFrames = Math.max(1, Number(getArg('late-join-min-frames', '20')));

  let hybrid = getArg('hybrid', 'auto').toLowerCase();
  if (hasFlag('cloud-only') || hybrid === 'off') hybrid = 'cloud-only';
  if (hasFlag('local-only')) hybrid = 'local-only';
  const localMode = getArg('local-mode', 'quiet').toLowerCase();
  const cloudThreshold = Math.max(0, Number(getArg('cloud-threshold', '60')));

  const localBlender = findLocalBlender(getArg('local-blender', ''));
  const blenderSeriesArg = getArg('blender-series', 'auto');
  const blenderSeries = blenderSeriesArg === 'auto' ? '' : blenderSeriesArg;
  const profiles = loadProfiles(getArg('mcp-config', DEFAULT_MCP_CFG), getArg('profiles', null));

  const { manifest, pending } = inspectAndInitState(manifestPath, {
    blend: blendAbsOrig || null,
    smoke,
    spec,
    hybrid,
    fps,
    samples,
    res,
    depth,
    frameList,
    framesDir,
    minBytes,
    dryRun,
  });

  let useLocal = false;
  let useCloud = false;
  let routeLabel = 'idle';

  if (!packOnly && pending.length > 0) {
    if (hybrid === 'cloud-only') {
      if (profiles.length === 0) throw new Error('cloud-only requested but no Colab profiles found in mcp_config.json');
      useCloud = true;
      routeLabel = `cloud-only (${profiles.length} Colab ${spec} workers)`;
    } else if (hybrid === 'local-only') {
      if (!localBlender) throw new Error('local-only requested but no local Blender executable found');
      useLocal = true;
      routeLabel = `local-only (${localMode} ${localBlender.version || 'Blender'})`;
    } else if (hybrid === 'on') {
      if (!localBlender) throw new Error('hybrid=on requested but no local Blender executable found');
      useLocal = true;
      useCloud = profiles.length > 0;
      routeLabel = `hybrid (Local ${localMode} + ${profiles.length} Colab ${spec} workers)`;
    } else {
      // hybrid === 'auto' (DEFAULT: include local compute!)
      if (localBlender && profiles.length > 0) {
        if (pending.length <= cloudThreshold) {
          useLocal = true;
          routeLabel = `local-only (${localMode}, ${pending.length} <= cloud-threshold ${cloudThreshold})`;
        } else {
          useLocal = true;
          useCloud = true;
          routeLabel = `hybrid (Local ${localMode} + ${profiles.length} Colab ${spec} workers, ${pending.length} > ${cloudThreshold})`;
        }
      } else if (localBlender) {
        useLocal = true;
        routeLabel = `local-only (no Colab profiles; ${localMode})`;
      } else if (profiles.length > 0) {
        useCloud = true;
        routeLabel = `cloud-only (no local Blender found; ${profiles.length} Colab ${spec} workers)`;
      } else {
        throw new Error('neither local Blender nor Colab MCP profiles found');
      }
    }
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      hybrid,
      route: routeLabel,
      useLocal,
      useCloud,
      localBlender,
      blenderSeries: blenderSeries || 'auto (5.3->5.0->4.5->4.2)',
      localMode,
      cloudThreshold,
      totalFrames: frameList.length,
      pendingFrames: pending.length,
      profiles: profiles.map((p) => p.name),
      policy: {
        targetSec,
        fixedBatch,
        initBatch,
        minBatch,
        maxBatch,
        localInitBatch,
        localMaxBatch,
        spec,
        staggerMs,
        reprobeSec,
        lateJoinMinFrames,
      },
      paths: { outDir, framesDir, manifestPath, statusPath, timingOut },
    }, null, 2));
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(chunksDir, { recursive: true });
  saveManifest(manifestPath, manifest, pending);

  if (!packOnly && pending.length > 0) {
    const stagedBlend = useCloud ? resolveBlendForCloud(localBlender, blendAbsOrig, outDir, autoPack) : blendAbsOrig;
    const workerPy = fs.readFileSync(WORKER_PY, 'utf8');
    const innerPyB64 = fs.readFileSync(INNER_PY).toString('base64');

    const shared = createSharedCoordinator(manifestPath, statusPath, manifest, pending, {
      routeLabel,
      outDir,
      framesDir,
      chunksDir,
      blendAbs: stagedBlend || blendAbsOrig,
      smoke,
      spec,
      blenderSeries,
      samples,
      res,
      depth,
      minBytes,
      workerPy,
      innerPyB64,
      runtimeRetries,
      staggerMs,
      reprobeSec,
      lateJoinMinFrames,
      targetSec,
      fixedBatch,
      initBatch,
      minBatch,
      maxBatch,
      localInitBatch,
      localMaxBatch,
      localMode,
    });

    console.log(`Dispatching ${pending.length} frame(s) via ${routeLabel}...`);
    const tasks = [];
    if (useLocal) tasks.push(runLocalWorker(localBlender, shared));
    if (useCloud) tasks.push(...profiles.map((p, idx) => runCloudWorker(p, shared, idx)));
    await Promise.all(tasks);
  }

  const allPresent = allFramesPresent(framesDir, frameList, minBytes);
  const doneChunks = manifest.chunks.filter((c) => c.status === 'done');
  const wallSec = +((Date.now() - tWall0) / 1000).toFixed(2);

  let packaged = null;
  const workerChunks = {};
  const workerFrames = {};
  for (const c of doneChunks) {
    if (c.worker) {
      workerChunks[c.worker] = (workerChunks[c.worker] || 0) + 1;
      workerFrames[c.worker] = (workerFrames[c.worker] || 0) + (c.frames?.length || 0);
    }
  }
  if (allPresent) {
    packaged = packageLocally({ outDir, framesDir, frameList, fps, noVideo });
    fs.writeFileSync(
      timingOut,
      JSON.stringify({ route: routeLabel, hybrid, spec, wallSec, totalFrames: frameList.length, workerChunks, workerFrames }, null, 2),
      'utf8'
    );
  }

  const summary = {
    ok: allPresent,
    route: routeLabel,
    totalFrames: frameList.length,
    remainingFrames: pending.length,
    doneChunks: doneChunks.length,
    wallSec,
    workerChunks,
    workerFrames,
    packaged,
    manifestPath,
    statusPath: fs.existsSync(statusPath) ? statusPath : null,
    timingOut: allPresent ? timingOut : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
