# %% [markdown]
# # 90 · 收产物（打包 / 落到 Drive / 出下载清单）
# 会话一断 `/content` 就清空，所以**每次跑完都执行这一格**。
# 有挂 Drive 时产物本来就在 Drive 里，这一步只是打包 + 出清单，方便手机端直接下载。

# %%
import os, json, shutil, subprocess, time
from pathlib import Path

def sh(cmd, check=False):
    print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.stdout: print(p.stdout.strip()[-2000:])
    if p.returncode != 0 and check:
        raise RuntimeError(cmd)
    return p

OUT_ROOT = Path(os.environ.get("CK_OUT_ROOT", "/content/colabkit/outputs"))
if not OUT_ROOT.exists():
    OUT_ROOT = Path("/content")
print("扫描:", OUT_ROOT)

files = [p for p in OUT_ROOT.rglob("*") if p.is_file() and p.suffix.lower() in
         {".mp4", ".wav", ".mp3", ".png", ".jpg", ".srt", ".txt", ".json"}]
files.sort(key=lambda p: p.stat().st_mtime, reverse=True)

rows = [{"name": str(p.relative_to(OUT_ROOT)), "mb": round(p.stat().st_size / 1024**2, 2),
         "mtime": time.strftime("%H:%M:%S", time.localtime(p.stat().st_mtime))} for p in files]
for r in rows[:40]:
    print(f"  {r['mb']:>7.2f} MB  {r['mtime']}  {r['name']}")

print(f"\n共 {len(rows)} 个文件，合计 {sum(r['mb'] for r in rows):.1f} MB")

# %%
# 打包（只打产物，跳过模型缓存）
if rows:
    stamp = time.strftime("%m%d-%H%M")
    zip_path = OUT_ROOT.parent / f"colabkit-{stamp}.zip"
    with shutil.make_archive(str(zip_path.with_suffix("")), "zip", root_dir=str(OUT_ROOT)) as _:
        pass
    print("📦", zip_path, f"{zip_path.stat().st_size/1024**2:.1f} MB")

# 若在 Drive 里，浏览器左侧「文件」面板就能下载；也可以在下一格出直链
# %%
# 有 Drive 时的下载提示
DRIVE_ZIP = list(Path("/content/drive/MyDrive/colabkit").glob("*.zip")) if Path("/content/drive/MyDrive").exists() else []
for z in DRIVE_ZIP:
    print("Drive 里的压缩包（手机/电脑都能直接下）:", z)
print("\n✅ 收尾完成。接着可以：右上角「断开连接」省配额，或继续下一批。")
