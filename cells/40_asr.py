# %% [markdown]
# # 40 · 语音转文字 / 出字幕（faster-whisper large-v3，GPU）
# 用途：把已有视频/播客转成带时间轴的文稿；给成片烧字幕；把别人视频的内容扒下来做整理。
# T4 上 large-v3 走 float16，1 小时音频约 4–8 分钟。

# %%
import subprocess, os, json, time
from pathlib import Path

def sh(cmd, check=True):
    print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.stdout: print(p.stdout.strip()[-1500:])
    if p.returncode != 0 and check:
        print(p.stderr.strip()[-1200:]); raise RuntimeError(cmd)
    return p

sh("pip -q install -U faster-whisper")

from faster_whisper import WhisperModel

OUT = Path(os.environ.get("CK_OUT", "/content/colabkit/outputs/asr"))
OUT.mkdir(parents=True, exist_ok=True)

MODEL_SIZE = os.environ.get("CK_WHISPER", "large-v3")   # large-v3 / medium / small
COMPUTE = "float16" if __import__("torch").cuda.is_available() else "int8"
print("模型:", MODEL_SIZE, COMPUTE)
model = WhisperModel(MODEL_SIZE, device="cuda" if COMPUTE != "int8" else "cpu", compute_type=COMPUTE)

# %%
def _ts(sec):
    h = int(sec // 3600); m = int(sec % 3600 // 60); s = sec % 60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"

def transcribe(media, language="zh", name=None, vad=True):
    media = Path(media)
    if not media.exists():
        # 视频先抽音轨（faster-whisper 自己能读视频，但先转 16k wav 更省内存）
        raise FileNotFoundError(media)
    t = time.time()
    segments, info = model.transcribe(
        str(media), language=language, beam_size=5,
        vad_filter=vad, vad_parameters={"min_silence_duration_ms": 400},
        word_timestamps=False,
    )
    stem = name or media.stem
    srt, txt, rows = [], [], []
    for i, s in enumerate(segments, 1):
        rows.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})
        srt += [str(i), f"{_ts(s.start)} --> {_ts(s.end)}", s.text.strip(), ""]
        txt.append(s.text.strip())
    (OUT / f"{stem}.srt").write_text("\n".join(srt), encoding="utf-8")
    (OUT / f"{stem}.txt").write_text("\n".join(txt), encoding="utf-8")
    row = {"audio": str(media), "duration_s": round(info.duration, 1), "language": info.language,
           "segments": len(rows), "elapsed": round(time.time() - t, 1),
           "srt": str(OUT / f'{stem}.srt'), "txt": str(OUT / f'{stem}.txt')}
    print(json.dumps(row, ensure_ascii=False))
    return row, rows

# %%
# 用法一：转 Drive 上的一个文件
# rows_info, segs = transcribe("/content/drive/MyDrive/colabkit/inputs/demo.mp4")

# 用法二：先用 yt-dlp 拉一个视频/音频再转（B 站的音频也行）
MEDIA_URL = os.environ.get("CK_MEDIA_URL", "")
if MEDIA_URL:
    sh("pip -q install -U yt-dlp", check=False)
    sh(f'cd /content && yt-dlp -x --audio-format m4a -o "/content/colabkit/in_%(id)s.%(ext)s" "{MEDIA_URL}"', check=False)
    cand = sorted(Path("/content/colabkit").glob("in_*"))
    if cand:
        transcribe(cand[-1])

print(f"\n✅ 输出目录 {OUT}")
