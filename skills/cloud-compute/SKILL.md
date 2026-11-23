---
name: cloud-compute
description: >-
  当用户说“启用云算力”、“启用云算力渲染”、“用云端 GPU 跑”、“上云渲染”、“多账号并行渲染”、“Colab 跑 Blender/模型”等泛化语言时触发。自动识别任务类型、探测可用 Colab 账号实例并并发执行云端渲染或 GPU 计算。
---

# 云算力自动调度工作流（Cloud Compute & Multi-Account Render）

当用户输入泛化指令（如「启用云算力」「启用云算力渲染」）时，按以下步骤自动推进：

## 1. 先判断目标与任务类型

- **如果用户指定了具体任务/文件**（例如 `.blend` 场景、Python 脚本、帧区间、推理代码）：直接进入第 2 步。
- **如果用户只说了“启用云算力”或“启用云算力渲染”而未指定文件**：
  1. 先检查当前工作区是否存在待渲染/待运行目标（如 `.blend`、`.py`、`html/index.html`）；
  2. 同时并发调用已挂载的 `colab_*` MCP 实例的 `colab_list`（查看有哪些节点在线、是否有残留实例）；
  3. 向用户简明汇报各节点就绪情况，并列出可直接开跑的方案或确认渲染文件与帧区间。
- **任务分流**：
  - **Blender / 3D / GPU / PyTorch / Python**：继续本工作流，走 `colab` 实例。
  - **HTML / 动效 / 网页视频**：转交 `hyperrender` 插件（≤ 20 秒用 `render_local`，> 20 秒用 `render_github`）。

## 2. 按任务规模选择执行方式

### A. 大批量 / 长帧序列 Blender 渲染（如数百～3000 帧 `.blend` + 本地打包）
直接通过 `run_command` 调用多账号批处理调度器 `<PLUGIN_DIR>\tools\blender_render_batch.mjs`（默认位于 `%USERPROFILE%\.gemini\config\plugins\colab\tools\blender_render_batch.mjs`，自动读取 `mcp_config.json` 中全部账号并发执行、上传 `.blend`、分批渲染、`manifest.json` 断点续跑、拉回结果并本地打包为 `frames_all.zip` 与 `final.mp4`）：

```powershell
node "<PLUGIN_DIR>\tools\blender_render_batch.mjs" `
  --blend "<本地scene.blend路径>" --start <起始帧> --end <结束帧> --batch 25 --fps 24 --spec gpu_t4 --out "<本地输出目录>"
```

- 若中途部分节点抢不到 GPU 或意外中断，使用完全相同的 `--out` 目录重新执行（自动跳过 `manifest.json` 中已完成的批次续跑）。
- 参数参考：`--samples`（采样数覆盖）、`--res 1920x1080`、`--profiles colab,colab_pro2,...`、`--no-video`、`--pack-only`。

### B. 轻量单任务 / 交互式脚本 / 需手动传取文件
使用已挂载的 `colab_*` MCP 实例工具（以当前会话 `<mcp_servers>` 列表为准）。调用任何懒加载工具前，先读取 `<appDataDir>\mcp\<serverName>\<toolName>.json`：

- 仅跑一段 Python / 脚本：`colab_exec` / `colab_run_script`（默认 `spec="gpu_t4"`、`keep=false`）。
- 需上传本地资产再运行并下载结果：
  1. `colab_ensure_runtime({ spec: "gpu_t4" })` 创建并锁定运行时；
  2. `colab_upload({ localPath, remotePath })` 将文件传到 `/content/<remotePath>`；
  3. `colab_exec({ code, keep: true })` 执行处理（或并发拆给多个实例）；
  4. `colab_download({ remotePath, localPath })` 将产物拉回本机；
  5. 务必调用 `colab_delete({ runtime })` 销毁运行时。

## 3. 容错与清理原则

- 若某实例返回 `The service is currently unavailable.` 或 `FAILED_PRECONDITION`（当前时段 T4 资源池无余量），将对应分片改派给其他空闲实例或延后重试。
- 所有通过 `keep=true` 或 `colab_ensure_runtime` 开启的运行时，任务结束后必须调用对应实例的 `colab_delete` 并用 `colab_list` 确认无残留。
