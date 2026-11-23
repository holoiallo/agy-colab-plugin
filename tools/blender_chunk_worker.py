# blender_chunk_worker.py -- Remote Colab Blender frame-list / range worker.
# Driven by blender_render_batch.mjs via CK_* environment variables:
#   CK_BLEND_PATH     path to .blend inside runtime (empty => procedural smoke scene)
#   CK_FRAMES         comma-separated frame indices (takes precedence over CK_START/CK_END)
#   CK_START/CK_END   inclusive frame range fallback (default 1..1)
#   CK_OUT_ZIP        output zip path (default /content/job/chunk.zip)
#   CK_BLENDER_SERIES preferred release series, e.g. Blender5.3 / Blender5.0 / Blender4.5
#   CK_SAMPLES        optional Cycles samples override
#   CK_RES            optional WxH resolution override
#   CK_DEPTH          optional PNG bit depth (8 or 16)
#   CK_MIN_BYTES      minimum valid frame size in bytes (default 500)
#   CK_INNER_PY_B64   base64-encoded blender_inner_render.py injected by caller
import base64
import glob
import os
import re
import shutil
import subprocess
import time
import urllib.request
import zipfile

MIRROR = "https://download.blender.org/release"
DRIVE = "/content/drive/MyDrive"
APPS = os.path.join(DRIVE, "colabkit/apps") if os.path.isdir(DRIVE) else "/content/colabkit/apps"
DEFAULT_SERIES = ("Blender5.3", "Blender5.0", "Blender4.5", "Blender4.2")


def sh(cmd, check=True):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.returncode != 0 and check:
        print("STDOUT:", (p.stdout or "")[-800:])
        print("STDERR:", (p.stderr or "")[-1200:])
        raise RuntimeError(f"command failed ({p.returncode}): {cmd[:120]}")
    return p


def pick_blender(series):
    try:
        req = urllib.request.Request(f"{MIRROR}/{series}/", headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        print("LIST_FAIL", series, e, flush=True)
        return None
    ver = series.replace("Blender", "")
    names = sorted(set(re.findall(rf"blender-{re.escape(ver)}\.\d+-linux-x64\.tar\.xz", html)))
    return names[-1] if names else None


def ensure_blender(preferred_series=""):
    if preferred_series:
        ver = preferred_series.replace("Blender", "")
        got = sorted(glob.glob(f"/content/blender-{ver}*/blender"))
        if got:
            return got[-1], "reuse"
    got = sorted(glob.glob("/content/blender-*/blender"))
    if got and not preferred_series:
        return got[-1], "reuse"

    os.makedirs(APPS, exist_ok=True)
    candidates = [preferred_series] + [s for s in DEFAULT_SERIES if s != preferred_series] if preferred_series else list(DEFAULT_SERIES)

    picked_series = None
    picked_name = None
    for s in candidates:
        n = pick_blender(s)
        if n:
            picked_series, picked_name = s, n
            break

    if not picked_name:
        sh("apt-get -qq update >/dev/null 2>&1; apt-get -qq install -y blender >/dev/null 2>&1", check=False)
        b = shutil.which("blender")
        if not b:
            raise RuntimeError("failed to install blender via mirror or apt")
        return b, "apt"

    tarball = os.path.join(APPS, picked_name)
    if not os.path.exists(tarball) or os.path.getsize(tarball) < 100_000_000:
        url = f"{MIRROR}/{picked_series}/{picked_name}"
        part = tarball + ".part"
        print("DOWNLOAD_BLENDER", picked_name, url, flush=True)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=180) as resp, open(part, "wb") as out_f:
                while True:
                    buf = resp.read(2 * 1024 * 1024)
                    if not buf:
                        break
                    out_f.write(buf)
            os.replace(part, tarball)
        except Exception as e:
            print("URLLIB_FAIL, trying curl:", e, flush=True)
            sh(f'curl -L -sS --fail -o "{part}" "{url}" && mv -f "{part}" "{tarball}"', check=True)

    sh(f'tar -xf "{tarball}" -C /content', check=True)
    ver_prefix = picked_series.replace("Blender", "")
    got = sorted(glob.glob(f"/content/blender-{ver_prefix}*/blender")) or sorted(glob.glob("/content/blender-*/blender"))
    if not got:
        raise RuntimeError("Blender binary missing after extraction")
    b = got[-1]
    sh(f'chmod +x "{b}"', check=True)
    return b, "downloaded"


def main():
    t0 = time.time()
    blend_path = os.environ.get("CK_BLEND_PATH", "").strip()
    frames_csv = os.environ.get("CK_FRAMES", "").strip()
    if frames_csv:
        frames = [int(x) for x in frames_csv.split(",") if x.strip()]
    else:
        s_f = int(os.environ.get("CK_START", "1"))
        e_f = int(os.environ.get("CK_END", str(s_f)))
        frames = list(range(s_f, e_f + 1))
        frames_csv = ",".join(str(x) for x in frames)

    out_zip = os.environ.get("CK_OUT_ZIP", "/content/job/chunk.zip")
    preferred_series = os.environ.get("CK_BLENDER_SERIES", "").strip()
    samples = os.environ.get("CK_SAMPLES", "").strip()
    res = os.environ.get("CK_RES", "").strip()
    depth = os.environ.get("CK_DEPTH", "").strip()
    min_bytes = int(os.environ.get("CK_MIN_BYTES", "500"))
    inner_b64 = os.environ.get("CK_INNER_PY_B64", "").strip()
    if not inner_b64:
        raise RuntimeError("CK_INNER_PY_B64 missing")

    smoke = not blend_path
    if not smoke and not os.path.exists(blend_path):
        raise FileNotFoundError(f"blend file missing: {blend_path}")

    bl, how = ensure_blender(preferred_series)
    print("BLENDER", bl, how, "frames=", len(frames), flush=True)

    frames_dir = f"/content/job/frames_{os.path.splitext(os.path.basename(out_zip))[0]}"
    worker_py = "/content/job/inner_render_run.py"
    os.makedirs(os.path.dirname(worker_py), exist_ok=True)
    os.makedirs(os.path.dirname(out_zip), exist_ok=True)
    with open(worker_py, "wb") as f:
        f.write(base64.b64decode(inner_b64))

    def _run_blender(force_cuda):
        shutil.rmtree(frames_dir, ignore_errors=True)
        os.makedirs(frames_dir, exist_ok=True)
        args = [f"frames={frames_csv}", f"out_dir={frames_dir}", f"smoke={1 if smoke else 0}", f"force_cuda={1 if force_cuda else 0}"]
        if samples:
            args.append(f"samples={samples}")
        if res:
            args.append(f"res={res}")
        if depth:
            args.append(f"depth={depth}")
        blend_arg = "--factory-startup" if smoke else f'"{blend_path}"'
        cmd = f'"{bl}" -b {blend_arg} -P "{worker_py}" -- ' + " ".join(args)
        p = sh(cmd, check=True)
        print((p.stdout or "")[-1200:], flush=True)

    try:
        _run_blender(force_cuda=False)
    except Exception as e:
        print("OPTIX_RETRY_WITH_CUDA:", e, flush=True)
        _run_blender(force_cuda=True)

    expected = [f"frame_{f:06d}.png" for f in frames]
    bad = [
        n for n in expected
        if not os.path.exists(os.path.join(frames_dir, n)) or os.path.getsize(os.path.join(frames_dir, n)) < min_bytes
    ]
    if bad:
        raise RuntimeError(f"missing/corrupt rendered frames: {bad[:10]}")

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_STORED) as zf:
        for n in expected:
            zf.write(os.path.join(frames_dir, n), arcname=n)

    shutil.rmtree(frames_dir, ignore_errors=True)
    size = os.path.getsize(out_zip)
    print(f"CHUNK_OK {out_zip} {len(expected)} {size} elapsed={round(time.time() - t0, 1)}s", flush=True)


if __name__ == "__main__":
    main()
