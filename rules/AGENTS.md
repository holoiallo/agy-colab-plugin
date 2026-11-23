# Colab 云算力泛化触发规则

当用户使用泛化自然语言表达云端算力或云渲染需求（例如：「启用云算力」「用云算力渲染」「开启云端算力」「上云渲染」「云端 GPU 跑」「用多号并行渲染」「云端跑 Blender / AI」）时，**不要反问用户具体工具名或 MCP 指令**，直接按以下规则执行：

1. **立即加载技能**：先读取并遵循本插件的 `cloud-compute` 技能（`skills/cloud-compute/SKILL.md`）。
2. **默认混合算力 + 尊重仅云端选择**：
   - **大批量 Blender 帧序列（如几十～3000 帧 `.blend` 渲染 + 本地打包）**：通过 `run_command` 调用 `colabkit/tools/blender_render_batch.mjs`。默认使用 `--hybrid auto`（自动把本机静默模式 Blender 算力加入混合池：小任务本地直跑，大任务「本地静默 GPU 抢尾 + 云端多号抢头」并发）；若用户明确要求「仅云端 / 只用云算力 / 不占本地显卡」，必须传 `--cloud-only`。
   - **单任务 / 轻量 GPU / PyTorch / 文件传取**：使用 `colab_colab`、`colab_colab_pro2` ~ `colab_colab_pro7` 的 MCP 工具（`colab_ensure_runtime` / `colab_upload` / `colab_exec` / `colab_run_script` / `colab_download` / `colab_delete`）。
   - **网页 / HTML / CSS / Remotion / HyperFrames 视频渲染**：改用 `hyperrender` 插件（`render_local` 或 `render_github`）。
3. **强制主动汇报云机器状态（不等用户追问）**：
   - 在后台启动云端并发任务后、以及每次进度更新时，主动读取 `<outDir>/cluster_status.json` 或日志里的 `[CLUSTER]` 行，明确向用户汇报：**当前共几个云账号尝试连接、几台已成功上线拿到什么机型、几台处于 `standby` 后台重探、本地算力是否正在协同，以及剩余帧数**。
4. **工具调用规范**：调用任何懒加载 MCP 工具前，先读取 `<appDataDir>\mcp\<serverName>\<toolName>.json` 确认参数 schema；使用 `keep: true` 或 `colab_ensure_runtime` 后务必调用 `colab_delete` 清理实例。
