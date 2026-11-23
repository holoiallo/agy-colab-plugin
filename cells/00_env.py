# %% [markdown]
# # 00 · 环境自检 + 挂盘（每次开会话先跑这一个）
# 目的：30 秒内搞清楚「这台机器是什么卡、还剩多少空间、模型缓存放哪、产物往哪存」。
# 关键点：**把 HF 缓存和输出都放到 Drive**，这样断线重连不用重新下模型，产出也不会随会话蒸发。

# %%
import os, sys, json, shutil, subprocess, textwrap, time
from pathlib import Path

def sh(cmd, check=True, quiet=False):
    """在 Colab 和本地都能用的 shell 执行器。"""
    if not quiet:
        print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.stdout and not quiet:
        print(p.stdout.strip()[-4000:])
    if p.returncode != 0:
        print(p.stderr.strip()[-2000:])
        if check:
            raise RuntimeError(f"命令失败({p.returncode}): {cmd}")
    return p

IN_COLAB = "google.colab" in sys.modules or Path("/content").exists()

# %%
# ── 1. 机器体检 ──
report = {"in_colab": IN_COLAB, "python": sys.version.split()[0]}

try:
    import torch
    report["torch"] = torch.__version__
    report["cuda"] = torch.version.cuda
    report["gpu_available"] = torch.cuda.is_available()
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        report["gpu"] = p.name
        report["vram_gb"] = round(p.total_memory / 1024**3, 1)
        report["capability"] = f"{p.major}.{p.minor}"
except Exception as e:
    report["torch_error"] = str(e)

if shutil.which("nvidia-smi"):
    out = subprocess.run("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader",
                         shell=True, capture_output=True, text=True).stdout.strip()
    report["nvidia_smi"] = out

du = shutil.disk_usage("/content" if Path("/content").exists() else ".")
report["disk_free_gb"] = round(du.free / 1024**3, 1)
report["cpu_count"] = os.cpu_count()
try:
    report["ram_gb"] = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 1)
except Exception:
    report["ram_gb"] = None

print(json.dumps(report, ensure_ascii=False, indent=2))

if not report.get("gpu_available"):
    print("\n⚠️ 没有 GPU。右上角「连接」→「更改运行时类型」→ 硬件加速器选 T4 GPU，再重跑本格。")

# %%
# ── 2. 挂 Google Drive（模型缓存 + 产物都放这）──
DRIVE = Path("/content/drive/MyDrive")
MOUNTED = False
if IN_COLAB:
    try:
        from google.colab import drive
        if not DRIVE.exists() or not any(DRIVE.iterdir()):
            drive.mount("/content/drive", force_remount=False)
        MOUNTED = DRIVE.exists()
    except Exception as e:
        print("挂载失败（可跳过，产物就只在 /content 里）:", e)
else:
    MOUNTED = False
print("Drive:", "已挂载 " + str(DRIVE) if MOUNTED else "未挂载")

# %%
# ── 3. 目录约定：缓存放 Drive，产物放 Drive/outputs/<项目名>/ ──
PROJECT = os.environ.get("CK_PROJECT", "colabkit")
BASE = (DRIVE / "colabkit") if MOUNTED else Path("/content/colabkit")
PATHS = {
    "base": BASE,
    "hf_cache": BASE / "hf-cache",
    "outputs": BASE / "outputs" / PROJECT,
    "logs": BASE / "logs",
}
for p in PATHS.values():
    p.mkdir(parents=True, exist_ok=True)

os.environ["HF_HOME"] = str(PATHS["hf_cache"])
os.environ["HUGGINGFACE_HUB_CACHE"] = str(PATHS["hf_cache"] / "hub")
os.environ["TRANSFORMERS_CACHE"] = str(PATHS["hf_cache"] / "hub")
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
print(json.dumps({k: str(v) for k, v in PATHS.items()}, ensure_ascii=False, indent=2))

# %%
# ── 4. 基础依赖（只装缺的，装完不用重启）──
sh("pip -q install -U 'huggingface_hub[hf_transfer]' imageio imageio-ffmpeg soundfile librosa", check=False)
sh("ffmpeg -version | head -1", check=False)

try:
    du = shutil.disk_usage(str(BASE))
    print(f"工作盘剩余 {du.free/1024**3:.1f} GB")
    if du.free / 1024**3 < 10:
        print("⚠️ 剩余空间偏小：视频模型往往 5–15 GB，建议先清理 " + str(BASE))
except Exception as e:
    print(e)

print("\n✅ 00 完成。下一步按需跑 10/20/30/40 里的任意一格，最后跑 90 收产物。")
