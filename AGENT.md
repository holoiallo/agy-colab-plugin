# 接入 Agent：Google Colab MCP 架构与授权说明

## 一句话

Google 提供了官方 Colab MCP 端点：`https://colaboratory.googleapis.com/mcp`。
本插件将其封装为标准本地 stdio MCP 服务（`tools/colab-mcp-server.mjs`），通过 `gcloud` 自动刷新 OAuth ADC 令牌，并补齐了基于 `connectionInfo` 的二进制上传/下载以及多账号隔离并发调度能力。

---

## 上游官方 MCP 暴露的工具

```text
create_runtime(runtime)        起一个 runtime（T4 / CPU / L4 / A100）
create_session(parent)         在 runtime 上开 Jupyter kernel 会话
execute_code(code)             在会话里跑 Python，回 stdout/stderr/result
delete_session(name)           关会话（保留 runtime 与文件）
get_runtime(name)              查 runtime，含 connectionInfo（传文件用的 url + token）
list_runtimes()                列已有的 runtime
list_runtime_specs()           列机型 + eligible 资格
list_sessions(parent)          列会话
delete_runtime(name)           删 runtime（连同会话和容器文件一起清理）
get_subscription()             查询订阅档位（free / pro / pro+）
```

关键设计约束：
- 复用已有 runtime 时可用 `create_session` 隔离状态，减少重复起机等待；
- `execute_code` 单次超时约 600 秒；超时后用**同一个 `executionId`** 重试可续接输出而不是重跑；
- 传大文件不要走 base64 内联 `execute_code`，改用 `get_runtime().connectionInfo` 的 `/api/contents`（根目录对应容器 `/`）与 `/files/` 通道。

---

## 一次性授权配置（任何新机器只需跑一次）

```bash
# 1. OAuth 授权（必须带 colaboratory scope，否则 403 insufficient scopes）
gcloud auth application-default login --launch-browser \
  --scopes="https://www.googleapis.com/auth/colaboratory,https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email"

# 2. 建一个 GCP 项目并启用 API
gcloud projects create <YOUR_PROJECT_ID> --name="colabkit"
gcloud services enable colaboratory.googleapis.com --project=<YOUR_PROJECT_ID>

# 3. 告诉 ADC 用哪个项目算配额（否则 403 "requires a quota project"）
gcloud auth application-default set-quota-project <YOUR_PROJECT_ID>

# 4. 给账号授予 serviceUsageConsumer 角色（否则 403 "Caller does not have required permission"）
gcloud projects add-iam-policy-binding <YOUR_PROJECT_ID> \
  --member="user:you@gmail.com" --role="roles/serviceusage.serviceUsageConsumer"
```

---

## 本插件封装的 9 个 Antigravity MCP 工具

| 工具 | 作用 |
| :--- | :--- |
| `colab_specs` | 列出当前账号可用的机型规格与资格 |
| `colab_subscription` | 查看账号订阅档位 |
| `colab_ensure_runtime` | 创建或复用 25 分钟内的保留运行时（配合传文件使用） |
| `colab_exec` | 运行一段 Python 代码并返回 stdout/stderr（`keep=false` 时自动销毁） |
| `colab_run_script` | 读取本地 `.py` 文件提交到 Colab 执行 |
| `colab_upload` | 将本地文件上传至 Colab 容器（> 4 MiB 自动分块） |
| `colab_download` | 将 Colab 容器中的产物文件流式拉回本地 |
| `colab_list` | 列出当前账号运行中的 runtime |
| `colab_delete` | 按名称删除指定 runtime |

### 多账号隔离设计
- 每个账号使用独立的 `CLOUDSDK_CONFIG` 目录与 `COLAB_STATE_DIR` 缓存目录，OAuth 令牌与 `state.json` 互不覆盖；
- Windows 下通过 `gcloud.cmd` 刷新令牌（45 分钟内存缓存）；
- 大批量 Blender 渲染使用 `tools/blender_render_batch.mjs` 实现共享队列 + `manifest.json` 断点续跑 + 本地打包。
