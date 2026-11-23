# %% [markdown]
# # 10 · 云端显卡出视频（Wan2.1 T2V 1.3B，T4 能跑）
# 为什么选它：开源、无 HF 门禁（不用申请授权）、1.3B 参数在 T4 16G 上 fp16 能跑 480p/49帧，
# 一条 5 秒片子约 2–4 分钟。要更高画质把 `PRESET` 换成 "quality"（显存不够会自己降级）。

# %%
# 依赖：diffusers 0.33+ 才内置 Wan 管线
import subprocess, sys, os, json, time
from pathlib import Path

def sh(cmd, check=True):
    print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.stdout: print(p.stdout.strip()[-3000:])
    if p.returncode != 0 and check:
        print(p.stderr.strip()[-2000:]); raise RuntimeError(cmd)
    return p

sh("pip -q install -U 'diffusers>=0.33' transformers accelerate ftfy sentencepiece imageio imageio-ffmpeg")

import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video

OUT = Path(os.environ.get("CK_OUT", "/content/colabkit/outputs/video"))
OUT.mkdir(parents=True, exist_ok=True)
print("输出目录:", OUT)

# %%
# ── 载模型（第一次会下 ~5GB 到 HF 缓存；缓存在 Drive 上时下次秒起）──
MODEL_ID = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
print("dtype:", dtype)

t0 = time.time()
pipe = WanPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype)
pipe.to("cuda")
pipe.set_progress_bar_config(disable=False)

# 显存吃紧时的省显存开关（T4 上先开着更稳，速度略降）
LOW_VRAM = True
if LOW_VRAM:
    pipe.enable_model_cpu_offload()
print(f"模型就绪 {time.time()-t0:.1f}s")

# %%
# ── 生成 ──
PRESETS = {
    "draft":   dict(height=480, width=832, num_frames=33, num_inference_steps=25, guidance_scale=5.0),
    "standard":dict(height=480, width=832, num_frames=49, num_inference_steps=35, guidance_scale=5.0),
    "quality": dict(height=720, width=1280, num_frames=49, num_inference_steps=45, guidance_scale=5.5),
}

def make_video(prompt, preset="standard", negative=None, seed=None, name=None):
    cfg = dict(PRESETS[preset])
    g = torch.Generator(device="cpu")
    if seed is not None:
        g.manual_seed(int(seed))
    t = time.time()
    frames = pipe(
        prompt=prompt,
        negative_prompt=negative or "低质量, 模糊, 静止画面, 变形, 水印, 文字",
        generator=g,
        **cfg,
    ).frames[0]
    elapsed = time.time() - t
    stem = name or f"wan_{preset}_{int(time.time())}"
    mp4 = OUT / f"{stem}.mp4"
    export_to_video(frames, str(mp4), fps=16)
    size_mb = mp4.stat().st_size / 1024**2
    row = {"file": str(mp4), "prompt": prompt, "preset": preset, "seed": seed,
           "seconds": round(elapsed, 1), "size_mb": round(size_mb, 1), **cfg}
    print(json.dumps(row, ensure_ascii=False))
    return row

# %%
# ── 跑一条（改 prompt 就行）──
rows = []
rows.append(make_video(
    "电影感镜头：雨夜便利店门口，一只橘猫蹲在自动贩卖机旁，霓虹招牌在积水里反光，镜头缓慢推近",
    preset="standard", seed=1234,
))

# 批量：一次排队多条，跑完统一记账
BATCH = [
    # ("another prompt", "draft"),
]
for i, (p, preset) in enumerate(BATCH):
    rows.append(make_video(p, preset=preset, seed=1000 + i))

(OUT / "manifest.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n✅ 完成 {len(rows)} 条，清单: {OUT/'manifest.json'}")
print("下载：左侧文件夹面板拖出来，或跑 90_push.py 打包。")
