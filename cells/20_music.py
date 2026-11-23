# %% [markdown]
# # 20 · 云端显卡出音乐 / 音效（MusicGen，稳、快、无门禁）
# 适合做视频配乐、氛围垫、十几秒的 loop。要更强的中文人声/翻唱，再上 ACE-Step（文件末尾给了装法）。
# T4 上 musicgen-small 出一条 15 秒约 20–40 秒；medium 慢 3 倍但质感明显好。

# %%
import subprocess, os, json, time
from pathlib import Path

def sh(cmd, check=True):
    print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.stdout: print(p.stdout.strip()[-2000:])
    if p.returncode != 0 and check:
        print(p.stderr.strip()[-1500:]); raise RuntimeError(cmd)
    return p

sh("pip -q install -U transformers scipy soundfile")

import torch, numpy as np, scipy.io.wavfile as wavfile
from transformers import AutoProcessor, MusicgenForConditionalGeneration

OUT = Path(os.environ.get("CK_OUT", "/content/colabkit/outputs/music"))
OUT.mkdir(parents=True, exist_ok=True)

SIZE = os.environ.get("CK_MUSIC_SIZE", "medium")   # small / medium / large
MODEL = f"facebook/musicgen-{SIZE}"
print("模型:", MODEL)

processor = AutoProcessor.from_pretrained(MODEL)
model = MusicgenForConditionalGeneration.from_pretrained(
    MODEL, torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32
).to("cuda" if torch.cuda.is_available() else "cpu")
print("就绪")

# %%
SR = model.config.audio_encoder.sampling_rate  # 32000
TOKENS_PER_SEC = 50

def make_music(prompt, seconds=15, seed=None, name=None, guidance=3.0):
    t = time.time()
    inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(model.device)
    if seed is not None:
        torch.manual_seed(int(seed))
    with torch.no_grad():
        audio = model.generate(**inputs, do_sample=True, guidance_scale=guidance,
                               max_new_tokens=int(seconds * TOKENS_PER_SEC))
    arr = audio[0, 0].float().cpu().numpy()
    arr = np.clip(arr / max(1e-6, np.abs(arr).max()) * 0.95, -1, 1)
    stem = name or f"music_{int(time.time())}"
    f = OUT / f"{stem}.wav"
    wavfile.write(str(f), SR, (arr * 32767).astype(np.int16))
    row = {"file": str(f), "prompt": prompt, "seconds": seconds, "sr": SR,
           "elapsed": round(time.time() - t, 1), "size_mb": round(f.stat().st_size / 1024**2, 1)}
    print(json.dumps(row, ensure_ascii=False))
    return row

# %%
rows = []
rows.append(make_music(
    "cinematic ambient piano with soft strings, slow build, warm analog texture, no drums",
    seconds=15, seed=7,
))
rows.append(make_music(
    "雨声 + 远处地铁轰鸣 + 便利店自动门叮咚，写实环境音，无音乐",
    seconds=10, seed=8,
))

# 和视频等长的一条背景垫（视频 5 秒 → 生成 6 秒留剪辑余量）
rows.append(make_music("minimal tech house loop, 100 bpm, filtered chords, subtle pump",
                       seconds=6, seed=9))

(OUT / "manifest.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n✅ {len(rows)} 条 → {OUT}")

# %% [markdown]
# ## 想要「带人声 / 中文歌」就换 ACE-Step
# ```bash
# !git clone --depth 1 https://github.com/ace-step/ACE-Step.git /content/ACE-Step
# %cd /content/ACE-Step && pip -q install -e .
# # 然后把模型缓存放 Drive： export ACESTEP_CACHE=/content/drive/MyDrive/colabkit/hf-cache/acestep
# # 命令行出歌：
# !acestep --config_path example.json --device cuda --output_path /content/colabkit/outputs/music
# ```
# 显存：T4 可用，但 3 分钟以上的整曲建议 A100/L4。
