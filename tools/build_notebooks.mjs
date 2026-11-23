#!/usr/bin/env node
// 把 cells/*.py 组装成可直接拖进 Colab 的 .ipynb。
// 规则：源码里 `# %%` 分格；紧跟 `# %% [markdown]` 的格是 Markdown；其余是代码格。
// 这样维护一份 .py 就够了，ipynb 永远是它的产物，不会两边走样。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CELLS = path.join(ROOT, 'cells');
const OUT = path.join(ROOT, 'notebooks');

const TITLES = {
  '00_env.py': '00 环境自检 + 挂盘',
  '10_video_wan.py': '10 文生视频（Wan2.1 1.3B）',
  '20_music.py': '20 音乐 / 音效（MusicGen）',
  '30_tts.py': '30 旁白 + SRT（edge-tts）',
  '40_asr.py': '40 语音转文字（faster-whisper）',
  '50_blender.py': '50 Blender 云端渲染（Cycles + CUDA）',
  '85_checkpoint.py': '85 断线可续（检查点）',
  '90_push.py': '90 收产物（打包 / 落 Drive）',
};

function splitCells(src) {
  const parts = src.split(/^# %%.*$/m);
  const marks = [...src.matchAll(/^# %%.*$/gm)].map((m) => m[0]);
  const cells = [];
  // 第一段（文件开头到首个标记之间）
  if (parts[0].trim()) cells.push({ kind: 'code', text: parts[0] });
  for (let i = 1; i < parts.length; i++) {
    const marker = marks[i - 1] || '';
    const kind = /\[markdown\]/.test(marker) ? 'markdown' : 'code';
    cells.push({ kind, text: parts[i] });
  }
  return cells
    .map((c) => {
      let text = c.text.replace(/^\n+/, '').replace(/\s+$/, '');
      if (c.kind === 'markdown') {
        // Markdown 格里保留 `# ` 也能读，但去掉更像文档
        text = text
          .split('\n')
          .map((l) => l.replace(/^#\s?/, ''))
          .join('\n');
      }
      return { kind: c.kind, text };
    })
    .filter((c) => c.text.length > 0);
}

function toLines(text) {
  const lines = text.split('\n').map((l) => l + '\n');
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\n$/, '');
  return lines;
}

function notebook(cells, title) {
  return {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {
      colab: { provenance: [], toc_visible: true, name: title },
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
    },
    cells: cells.map((c) =>
      c.kind === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source: toLines(c.text) }
        : { cell_type: 'code', metadata: { id: Math.random().toString(36).slice(2, 10) }, execution_count: null, outputs: [], source: toLines(c.text) }
    ),
  };
}

fs.mkdirSync(OUT, { recursive: true });
const files = fs.readdirSync(CELLS).filter((f) => f.endsWith('.py')).sort();
const manifest = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(CELLS, f), 'utf8');
  const cells = splitCells(src);
  const title = TITLES[f] || f.replace(/\.py$/, '');
  const nb = notebook(cells, title);
  const outFile = path.join(OUT, f.replace(/\.py$/, '.ipynb'));
  fs.writeFileSync(outFile, JSON.stringify(nb, null, 1));
  manifest.push({ cell: f, notebook: path.basename(outFile), cells: cells.length, title });
}

// 一个「全流程」合集，省得来回切文件
const all = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(CELLS, f), 'utf8');
  all.push({ kind: 'markdown', text: `# ${TITLES[f] || f}` });
  all.push(...splitCells(src));
}
const allFile = path.join(OUT, 'colabkit-all.ipynb');
fs.writeFileSync(allFile, JSON.stringify(notebook(all, 'colabkit 全流程'), null, 1));
manifest.push({ cell: '(all)', notebook: path.basename(allFile), cells: all.length, title: 'colabkit 全流程' });

console.log(`生成 ${manifest.length} 个 notebook → ${OUT}`);
for (const m of manifest) console.log(`  ${m.notebook.padEnd(28)} ${String(m.cells).padStart(2)} 格  ${m.title}`);
