# blender_chunk_worker.py -- Remote Colab Blender frame-range worker.
# Driven by blender_render_batch.mjs (or colab_exec) via CK_* environment variables:
#   CK_BLEND_PATH  path to .blend inside runtime (empty => procedural smoke scene)
#   CK_START       start frame (inclusive, default 1)
#   CK_END         end frame (inclusive, default 1)
#   CK_OUT_ZIP     output zip path (default /content/job/chunk.zip)
#   CK_SAMPLES     optional Cycles samples override
#   CK_RES         optional WxH resolution override (e.g. 1920x1080)
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


def sh(cmd, check=True):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.returncode != 0 and check:
        print("STDOUT:", (p.stdout or "")[-800:])
        print("STDERR:", (p.stderr or "")[-1200:])
        raise RuntimeError(f"command failed ({p.returncode}): {cmd[:100]}")
    return p


def pick_blender(series="Blender4.5"):
    try:
        html = urllib.request.urlopen(f"{MIRROR}/{series}/", timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        print("LIST_FAIL", series, e)
        return None
    ver = series.replace("Blender", "")
    names = sorted(set(re.findall(rf"blender-{re.escape(ver)}\.\d+-linux-x64\.tar\.xz", html)))
    return names[-1] if names else None


def ensure_blender():
    got = sorted(glob.glob("/content/blender-*/blender"))
    if got:
        return got[-1], "reuse"
    os.makedirs(APPS, exist_ok=True)
    series = "Blender4.5"
    name = pick_blender(series)
    if not name:
        series = "Blender4.2"
        name = pick_blender(series)
    if not name:
        sh("apt-get -qq update >/dev/null 2>&1 && apt-get -qq install -y blender >/dev/null 2>&1", check=False)
        b = shutil.which("blender")
        if not b:
            raise RuntimeError("failed to install blender via mirror or apt")
        return b, "apt"
    tarball = os.path.join(APPS, name)
    if not os.path.exists(tarball):
        print("DOWNLOAD_BLENDER", name, flush=True)
        urllib.request.urlretrieve(f"{MIRROR}/{series}/{name}", tarball)
    sh(f'tar -xf "{tarball}" -C /content')
    b = sorted(glob.glob("/content/blender-*/blender"))[-1]
    sh(f'chmod +x "{b}"')
    return b, "downloaded"


WORKER_PY = r'''
import bpy, math, os, sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
o = dict(a.split("=", 1) for a in argv if "=" in a)
start_f = int(o["start"])
end_f = int(o["end"])
out_dir = o["out_dir"]
smoke = o.get("smoke", "0") == "1"

if smoke:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=10)
    bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1.1))
    mo = bpy.context.object
    mo.rotation_euler = (0, 0, 0)
    mo.keyframe_insert(data_path="rotation_euler", frame=1)
    mo.rotation_euler = (0, 0, math.radians(360))
    mo.keyframe_insert(data_path="rotation_euler", frame=120)
    bpy.ops.object.light_add(type="AREA", location=(3, -3, 5))
    bpy.context.object.data.energy = 800
    bpy.ops.object.camera_add(location=(4.5, -4.5, 3.0))
    cam = bpy.context.object
    cam.rotation_euler = (math.radians(66), 0, math.radians(45))
    sc.camera = cam

sc = bpy.context.scene
sc.render.engine = "CYCLES"
if o.get("samples"):
    sc.cycles.samples = int(o["samples"])
elif smoke:
    sc.cycles.samples = 8
sc.cycles.use_denoising = True

if o.get("res"):
    rx, ry = o["res"].split("x")
    sc.render.resolution_x, sc.render.resolution_y = int(rx), int(ry)
elif smoke:
    sc.render.resolution_x, sc.render.resolution_y = 480, 270

sc.render.image_settings.file_format = "PNG"
sc.render.filepath = os.path.join(out_dir, "frame_######")
sc.frame_start = start_f
sc.frame_end = end_f

try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    cuda_devs = [d for d in prefs.devices if d.type == "CUDA"]
    for d in prefs.devices:
        d.use = (d.type == "CUDA")
    sc.cycles.device = "GPU" if cuda_devs else "CPU"
    print("CYCLE_DEVICE", sc.cycles.device, [(d.name, d.type, d.use) for d in prefs.devices])
except Exception as e:
    print("GPU_FALLBACK_CPU", e)
    sc.cycles.device = "CPU"

bpy.ops.render.render(animation=True)
print("RENDER_DONE", start_f, end_f)
'''


def main():
    t0 = time.time()
    blend_path = os.environ.get("CK_BLEND_PATH", "").strip()
    start_f = int(os.environ.get("CK_START", "1"))
    end_f = int(os.environ.get("CK_END", str(start_f)))
    out_zip = os.environ.get("CK_OUT_ZIP", "/content/job/chunk.zip")
    samples = os.environ.get("CK_SAMPLES", "").strip()
    res = os.environ.get("CK_RES", "").strip()

    smoke = not blend_path
    if not smoke and not os.path.exists(blend_path):
        raise FileNotFoundError(f"blend file missing: {blend_path}")

    bl, how = ensure_blender()
    print("BLENDER", bl, how, flush=True)

    frames_dir = f"/content/job/frames_{start_f:06d}_{end_f:06d}"
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)
    os.makedirs(os.path.dirname(out_zip), exist_ok=True)

    worker_py = "/content/job/worker_run.py"
    os.makedirs(os.path.dirname(worker_py), exist_ok=True)
    with open(worker_py, "w", encoding="utf-8") as f:
        f.write(WORKER_PY)

    args = [f"start={start_f}", f"end={end_f}", f"out_dir={frames_dir}", f"smoke={1 if smoke else 0}"]
    if samples:
        args.append(f"samples={samples}")
    if res:
        args.append(f"res={res}")

    blend_arg = "--factory-startup" if smoke else f'"{blend_path}"'
    cmd = f'"{bl}" -b {blend_arg} -P "{worker_py}" -- ' + " ".join(args)
    p = sh(cmd, check=True)
    print((p.stdout or "")[-1200:])

    expected = [f"frame_{f:06d}.png" for f in range(start_f, end_f + 1)]
    missing = [n for n in expected if not os.path.exists(os.path.join(frames_dir, n))]
    if missing:
        raise RuntimeError(f"missing rendered frames: {missing[:10]}")

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_STORED) as zf:
        for n in expected:
            zf.write(os.path.join(frames_dir, n), arcname=n)

    shutil.rmtree(frames_dir, ignore_errors=True)
    size = os.path.getsize(out_zip)
    print(f"CHUNK_OK {out_zip} {len(expected)} {size} elapsed={round(time.time() - t0, 1)}s")


if __name__ == "__main__":
    main()
