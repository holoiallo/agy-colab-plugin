---
name: cloud-compute
description: >-
  当用户说“启用云算力”、“启用云算力渲染”、“用云端 GPU 跑”、“上云渲染”、“多账号并行渲染”、“Colab 跑 Blender/模型”等泛化语言时触发。自动识别任务类型、探测可用 Colab 账号实例并动态调度混合（默认含本地）或仅云端并发渲染。
---

# 云算力自动调度工作流（Cloud Compute & Dynamic Hybrid Render）

当用户输入泛化指令（如「启用云算力」「启用云算力渲染」）时，按以下步骤自动推进：

## 1. 先判断目标与算力模式

- **如果用户指定了具体任务/文件**（例如 `.blend` 场景、Python 脚本、帧区间、推理代码）：直接进入第 2 步。
- **如果用户只说了“启用云算力”或“启用云算力渲染”而未指定文件**：
  1. 先检查当前工作区是否存在待渲染/待运行目标（如 `.blend`、`.py`、`html/index.html`）；
  2. 同时并发调用已挂载的 `colab_*` MCP 实例的 `colab_list`（查看有哪些节点在线、是否有残留实例）；
  3. 向用户简明汇报各节点就绪情况，并列出可直接开跑的方案或确认渲染文件与帧区间。
- **任务分流**：
  - **Blender / 3D / GPU / PyTorch / Python**：继续本工作流，走动态混合算力池。
  - **HTML / 动效 / 网页视频**：转交 `hyperrender` 插件（≤ 20 秒用 `render_local`，> 20 秒用 `render_github`）。
- **算力模式判定**：
  - 默认 `--hybrid auto`：把本地算力也纳入调度（总待渲染帧 `<= 60` 时本地静默模式直接跑；`> 60` 时本地静默 GPU 从尾部抢帧 + 云端多账号从头部抢帧并发）。
  - 用户明确说「仅用云端 / 只走云端 / 别用本地显卡」→ 传 `--cloud-only`（等价 `--hybrid cloud-only`）。
  - 用户明确说「强制混合 / 即使帧数少也要本地+云端」→ 传 `--hybrid on`；说「本地全速」→ `--local-mode full`。

## 2. 按任务规模选择执行方式

### A. Blender 帧序列（连续帧或 `--step` 抽帧 + 本地打包）
直接通过 `run_command` 调用动态调度器 `<PLUGIN_DIR>\tools\blender_render_batch.mjs`（默认位于 `%USERPROFILE%\.gemini\config\plugins\colab\tools\blender_render_batch.mjs`）：

```powershell
# 先 --dry-run 核对路由、本地 Blender 与帧数（1 秒完成）
node "<PLUGIN_DIR>\tools\blender_render_batch.mjs" `
  --blend "<本地scene.blend路径>" --start <起始帧> --end <结束帧> --step 1 --dry-run

# 正式运行（默认 --hybrid auto + --spec auto + EWMA 自适应分片 + 后台 Late-Join 重探）
node "<PLUGIN_DIR>\tools\blender_render_batch.mjs" `
  --blend "<本地scene.blend路径>" --start <起始帧> --end <结束帧> --step 1 --fps 24 --out "<本地输出目录>"
```

- **常用开关**：
  - `--cloud-only`：仅用云端（不占本机算力）；`--hybrid on`：强制本地+云端同时开跑；`--local-mode full`：本地全核全速。
  - `--auto-pack`：若 `.blend` 引用了外部贴图，自动调用本地 Blender 打包成自包含 `.blend` 再上传。
  - `--local-blender "<路径>"`：本地存在多个版本（如便携版 Blender 5.3）时指定本地执行程序；`--blender-series Blender5.3` 指定云端版本号。
  - `--samples` / `--res` / `--depth 8|16`：覆盖采样、分辨率与色深；断点续跑直接用相同 `--out` 重跑即可。

### B. 轻量单任务 / 交互式脚本 / 需手动传取文件
使用已挂载的 `colab_*` MCP 实例工具（调用任何懒加载工具前，先读取 `<appDataDir>\mcp\<serverName>\<toolName>.json`）：
- 仅跑一段 Python / 脚本：`colab_exec` / `colab_run_script`（默认 `spec="gpu_t4"`、`keep=false`）。
- 需上传本地资产再运行并下载结果：`colab_ensure_runtime` → `colab_upload` → `colab_exec({ keep: true })` → `colab_download` → `colab_delete`。

## 3. 主动汇报集群状态与清理原则（强制）

1. **启动与运行中必须主动汇报在线机器数**：
   - 在启动长任务后的首条进度更新、以及后续每次查看任务状态时，读取 `<outDir>/cluster_status.json` 或任务日志中的 `[CLUSTER]` 行，**主动向用户汇报**：
     - 几台云账号已成功拿到 GPU 在线干活（及各自机型如 `T4`/`L4`/`A100`）；
     - 几台因池满进入 `standby` 后台重探、几台已下线；
     - 本地算力是否在线协同，以及当前剩余帧数。
2. **收尾汇报与零残留核查**：
   - 任务结束后，在最终结果中附上各节点（本地与各云账号）完成的批次数与帧数（`workerChunks` / `workerFrames`），以及产物路径（`frames_all.zip`、`final.mp4`）。
   - 若手动使用过 `keep=true` 或 `colab_ensure_runtime`，务必调用 `colab_delete` 并用 `colab_list` 确认无残留运行时。
