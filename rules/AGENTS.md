# Colab 云算力泛化触发规则

当用户使用泛化自然语言表达云端算力或云渲染需求（例如：「启用云算力」「用云算力渲染」「开启云端算力」「上云渲染」「云端 GPU 跑」「用多号并行渲染」「云端跑 Blender / AI」）时，**不要反问用户具体工具名或 MCP 指令**，直接按以下规则执行：

1. **立即加载技能**：先读取并遵循本插件的 `cloud-compute` 技能（`skills/cloud-compute/SKILL.md`）。
2. **按任务类型与规模自动分流**：
   - **大批量 Blender 帧序列（如几十～3000 帧 `.blend` 渲染 + 本地打包）**：通过 `run_command` 调用本插件的 `tools/blender_render_batch.mjs`，自动并发调度多个账号、`manifest.json` 断点续跑、回传分片并在本地打包 `frames_all.zip` 与 `final.mp4`。
   - **单任务 / 轻量 GPU / PyTorch / 文件传取**：使用已挂载的 `colab_*` MCP 工具（`colab_ensure_runtime` / `colab_upload` / `colab_exec` / `colab_run_script` / `colab_download` / `colab_delete`）。
   - **网页 / HTML / CSS / Remotion / HyperFrames 视频渲染**：改用 `hyperrender` 插件（`render_local` 或 `render_github`）。
3. **工具调用规范**：调用任何懒加载 MCP 工具前，先读取 `<appDataDir>\mcp\<serverName>\<toolName>.json` 确认参数 schema；使用 `keep: true` 或 `colab_ensure_runtime` 后务必调用 `colab_delete` 清理实例。
