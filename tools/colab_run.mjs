#!/usr/bin/env node
// 用 CDP 驱动一个已登录的浏览器打开 Colab notebook 并「全部运行」。
// 复用 flowkit 的浏览器连接层（同一个 ego 浏览器 / 同一个 Edge 都行），不装 playwright。
//
// 用法：
//   node tools/colab_run.mjs --url "https://colab.research.google.com/drive/ABC123"
//   node tools/colab_run.mjs --url ... --timeout 1800 --shot ./colab.png --json
//
// 免责：Colab 的界面会改版，这里用的是最稳的两条路 —— URL 直达 + Ctrl+F9 全部运行，
// 所以它的作用是「省掉几十次手点」，不是无人值守跑通宵。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../flowkit/src/ego.mjs';
import { Page, sleep } from '../../flowkit/src/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = A.indexOf('--' + k);
  if (i === -1) return d;
  const v = A[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const url = arg('url');
if (!url) {
  console.error('用法: node tools/colab_run.mjs --url "https://colab.research.google.com/drive/<FILE_ID>" [--timeout 1800] [--shot out.png]');
  process.exit(2);
}
const timeoutSec = Number(arg('timeout', 1800));
const asJson = !!arg('json');
const shot = arg('shot');
const log = (...m) => { if (!asJson) console.error('·', ...m); };

const { cdp, info } = await connect({ url: arg('ws') || process.env.FLOWCTL_WS || undefined });
log(`浏览器 ${info.source || ''} ${info.port ? 'port=' + info.port : ''}`);

// 找已有 colab 标签页，没有就新建
let target = (await cdp.send('Target.getTargets')).targetInfos.find(
  (t) => t.type === 'page' && (t.url || '').includes('colab.research.google.com')
);
if (!target) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  target = { targetId, url };
}
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
const page = new Page(cdp, sessionId, target.targetId);

const t0 = Date.now();
const elapsed = () => Math.round((Date.now() - t0) / 1000);

try {
  const cur = await page.url();
  if (!cur.includes('colab.research.google.com') || !cur.includes('drive')) {
    await page.navigate(url, { settle: 2500 });
  }
  log(`打开 ${await page.url()}`);

  // 等 notebook 骨架出现（.cell 或 colab 应用容器）
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.eval(
      `!!document.querySelector('.notebook-vertical') || !!document.querySelector('colab-app') || document.querySelectorAll('.cell').length > 0`,
      { awaitPromise: false }
    );
    if (ready) break;
    await sleep(1500);
  }
  if (!ready) throw new Error('notebook 90s 内没加载出来（可能没登录 Google 或链接不对）');
  log('notebook 已加载');

  await sleep(2500);
  // Ctrl+F9 = 全部运行（Colab 的稳定快捷键）
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'F9', code: 'F9', windowsVirtualKeyCode: 120, nativeVirtualKeyCode: 120, modifiers: 2 },
    sessionId
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'F9', code: 'F9', windowsVirtualKeyCode: 120, nativeVirtualKeyCode: 120, modifiers: 2 },
    sessionId
  );
  log('已按 Ctrl+F9（全部运行）');

  // 轮询：busy 单元数量归零 = 跑完
  let idleStreak = 0;
  let lastBusy = -1;
  while (elapsed() < timeoutSec) {
    await sleep(3000);
    const st = await page.eval(
      `(() => {
         const busy = document.querySelectorAll('.cell.busy').length;
         const err = document.querySelectorAll('.cell .output-error, .cell [data-error="true"]').length;
         const spin = !!document.querySelector('#top-toolbar [role="progressbar"], .top-toolbar [role="progressbar"]');
         return { busy, err, spin, cells: document.querySelectorAll('.cell').length };
       })()`,
      { awaitPromise: false }
    );
    if (st.busy !== lastBusy) log(`busy=${st.busy} cells=${st.cells} err=${st.err} (${elapsed()}s)`);
    lastBusy = st.busy;
    if (st.busy === 0) {
      idleStreak += 1;
      if (idleStreak >= 3) {
        const result = { ok: st.err === 0, cells: st.cells, errors: st.err, seconds: elapsed() };
        if (shot) result.screenshot = await page.screenshot(path.resolve(shot));
        if (asJson) console.log(JSON.stringify(result, null, 2));
        else console.log(st.err ? `⚠️ 跑完，但有 ${st.err} 个单元报错` : `✅ 全部跑完（${elapsed()}s）`);
        cdp.close();
        process.exit(st.err ? 1 : 0);
      }
    } else {
      idleStreak = 0;
    }
  }
  throw new Error(`超过 ${timeoutSec}s 还在跑`);
} catch (e) {
  if (shot) {
    try { await page.screenshot(path.resolve(shot)); } catch {}
  }
  if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  else console.error(`✗ ${e.message}`);
  cdp.close();
  process.exit(1);
}
