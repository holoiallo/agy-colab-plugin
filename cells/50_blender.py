# %% [markdown]
# # 50 · Blender 云端渲染（Cycles + CUDA，T4 可用）
# 思路：
# 1. Blender 本体**缓存在 Drive**（只存 tar.xz），每次会话解压到 `/content`（快、不占 Drive 写入）
# 2. 渲染走 **Cycles GPU**：T4 支持 CUDA，第一次要先编译内核（1–3 分钟），之后就快了
# 3. 输出统一落 Drive，动画帧序列 + ffmpeg 合成 mp4
#
# ⚠️ EEVEE Next 需要 OpenGL 4.3 上下文，Colab 是无头环境，**大概率报错**；要 EEVEE 就自己加 `--gpu-backend egl` 试，别指望稳。

# %%
import os, sys, json, glob, re, time, shutil, subprocess, urllib.request
from pathlib import Path

def sh(cmd, check=True, quiet=False, timeout=None):
    if not quiet:
        print(f"$ {cmd}")
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if p.stdout and not quiet:
        print(p.stdout.strip()[-3000:])
    if p.returncode != 0:
        print(p.stderr.strip()[-2000:])
        if check:
            raise RuntimeError(f"命令失败({p.returncode}): {cmd}")
    return p

DRIVE = Path("/content/drive/MyDrive")
BASE = (DRIVE / "colabkit") if DRIVE.exists() else Path("/content/colabkit")
APPS = BASE / "apps"
OUT = BASE / "outputs" / "blender"
for p in (APPS, OUT):
    p.mkdir(parents=True, exist_ok=True)
print("缓存:", APPS, "\n输出:", OUT)

# %%
# ── 1. 装 Blender（缓存在 Drive，只下一次）──
BL_MIRROR = "https://download.blender.org/release"

def pick_latest(series="Blender4.5"):
    """从官方目录里挑最新的 linux-x64 tar.xz"""
    url = f"{BL_MIRROR}/{series}/"
    try:
        html = urllib.request.urlopen(url, timeout=30).read().decode("utf-8", "ignore")
    except Exception as e:
        print("列目录失败:", e)
        return None
    names = sorted(set(re.findall(rf"(blender-{series.replace('Blender','')}\.\d+-linux-x64\.tar\.xz)", html)))
    return names[-1] if names else None

def ensure_blender(series="Blender4.5", force=False):
    # 已经解压在 /content 里就直接用
    for cand in sorted(glob.glob("/content/blender-*/blender")):
        if not force:
            return cand
    name = pick_latest(series)
    if not name:
        raise RuntimeError("取不到 Blender 下载地址，检查网络或换 series")
    tarball = APPS / name
    if not tarball.exists() or force:
        print("下载", name, "（约 300 MB，只下一次）")
        urllib.request.urlretrieve(f"{BL_MIRROR}/{series}/{name}", tarball)
    print("解压到 /content …")
    sh(f'tar -xf "{tarball}" -C /content')
    cand = sorted(glob.glob("/content/blender-*/blender"))
    if not cand:
        raise RuntimeError("解压后没找到 blender 可执行文件")
    sh(f'chmod +x "{cand[-1]}"')
    print(sh(f'"{cand[-1]}" --version', quiet=True).stdout.split("\n")[0])
    return cand[-1]

BLENDER = ensure_blender()
print("BLENDER =", BLENDER)

# %%
# ── 2. 渲染设置脚本（注入到任意 .blend）──
SETUP_PY = r'''
import bpy, sys, os
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
opts = dict(a.split("=", 1) for a in argv if "=" in a)
samples = int(opts.get("samples", "32"))
rx, ry = opts.get("res", "960x540").split("x")
use_gpu = opts.get("gpu", "1") == "1"

sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.samples = samples
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = int(rx), int(ry)
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = "PNG"

if use_gpu:
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = (d.type == "CUDA")
        sc.cycles.device = "GPU"
        print("DEVICES:", [(d.name, d.type, d.use) for d in prefs.devices])
    except Exception as e:
        print("GPU 设置失败，退回 CPU:", e)
        sc.cycles.device = "CPU"
else:
    sc.cycles.device = "CPU"
print("RENDER:", sc.render.engine, sc.cycles.device, samples, "samples", rx, "x", ry)
'''

def write_setup():
    p = "/content/blender_setup.py"
    Path(p).write_text(SETUP_PY, encoding="utf-8")
    return p

SETUP = write_setup()

# %%
# ── 3. 冒烟测试：不需要任何 .blend，脚本现场建一个场景渲染一帧 ──
SMOKE_PY = r'''
import bpy, os, math, time
OUT = os.environ.get("SMOKE_OUT", "/content/blender_smoke.png")
t0 = time.time()

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# 地面
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
floor = bpy.context.object
mat = bpy.data.materials.new("Floor")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1)
bsdf.inputs["Roughness"].default_value = 0.35
floor.data.materials.append(mat)

# 主体：猴头 + 金属球 + 自发光环
bpy.ops.mesh.primitive_monkey_add(location=(-1.6, 0, 1.1), rotation=(0, 0, math.radians(20)))
monkey = bpy.context.object
for p in monkey.data.polygons:
    p.use_smooth = True
m = bpy.data.materials.new("Chrome")
m.use_nodes = True
b = m.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.9, 0.75, 0.35, 1)
b.inputs["Metallic"].default_value = 1.0
b.inputs["Roughness"].default_value = 0.15
monkey.data.materials.append(m)

bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(1.4, 0.6, 1.0))
ball = bpy.context.object
ball.data.materials.append(m)

bpy.ops.mesh.primitive_torus_add(location=(0, -1.2, 2.2), major_radius=1.4, minor_radius=0.05)
ring = bpy.context.object
em = bpy.data.materials.new("Neon")
em.use_nodes = True
nt = em.node_tree
nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial")
emi = nt.nodes.new("ShaderNodeEmission")
emi.inputs["Color"].default_value = (0.2, 0.8, 1.0, 1)
emi.inputs["Strength"].default_value = 12
nt.links.new(emi.outputs["Emission"], out.inputs["Surface"])
ring.data.materials.append(em)

# 灯光
bpy.ops.object.light_add(type="AREA", location=(3, -3, 6))
key = bpy.context.object
key.data.energy = 1200
key.data.size = 4
bpy.ops.object.light_add(type="POINT", location=(-4, 2, 3))
fill = bpy.context.object
fill.data.energy = 400
fill.data.color = (0.4, 0.7, 1.0)

# 相机
bpy.ops.object.camera_add(location=(6.5, -6.5, 4.2))
cam = bpy.context.object
cam.rotation_euler = (math.radians(66), 0, math.radians(45))
scene.camera = cam

# 世界：淡蓝灰
scene.world = bpy.data.worlds.new("W")
scene.world.use_nodes = True
bg = scene.world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.06, 0.09, 0.12, 1)
bg.inputs["Strength"].default_value = 0.6

scene.render.filepath = OUT
scene.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
print(f"SMOKE_OK {OUT} {time.time()-t0:.1f}s")
'''

def smoke_test(samples=32, res="960x540", use_gpu=True):
    p = Path("/content/blender_smoke.py")
    p.write_text(SMOKE_PY, encoding="utf-8")
    outp = "/content/blender_smoke.png"
    if os.path.exists(outp):
        os.remove(outp)
    cmd = f'"{BLENDER}" -b --factory-startup -P "{p}" -P "{SETUP}" -- samples={samples} res={res} gpu={1 if use_gpu else 0}'
    t0 = time.time()
    sh(cmd, quiet=True)
    ok = os.path.exists(outp)
    info = {"ok": ok, "file": outp if ok else None, "seconds": round(time.time() - t0, 1),
            "size_kb": round(os.path.getsize(outp) / 1024, 1) if ok else 0}
    print(json.dumps(info, ensure_ascii=False))
    return info

# %%
smoke = smoke_test(samples=24)
if smoke["ok"]:
    shutil.copy(smoke["file"], OUT / "smoke.png")
    print("已复制到", OUT / "smoke.png")
    from IPython.display import Image, display
    display(Image(filename=str(OUT / "smoke.png")))

# %% [markdown]
# ## 渲染你自己的 .blend
# 把 `.blend` 传到 Drive（建议 `MyDrive/colabkit/inputs/`），然后：

# %%
def render_blend(blend, out_name=None, frames="1", samples=64, res="1280x720", use_gpu=True, fps=24):
    """渲染一段帧区间；frames 可写 '1'、'1-120'、'1,5,10'。返回输出目录。"""
    blend = Path(blend)
    if not blend.exists():
        raise FileNotFoundError(blend)
    out_dir = OUT / (out_name or blend.stem)
    out_dir.mkdir(parents=True, exist_ok=True)
    pat = str(out_dir / "frame_####")
    cmd = (f'"{BLENDER}" -b "{blend}" -P "{SETUP}" -- samples={samples} res={res} '
           f'gpu={1 if use_gpu else 0} -o "{pat}" -F PNG -f {frames}')
    t0 = time.time()
    sh(cmd, quiet=True)
    pngs = sorted(out_dir.glob("frame_*.png"))
    print(json.dumps({"frames": len(pngs), "dir": str(out_dir), "seconds": round(time.time() - t0, 1)}, ensure_ascii=False))
    return out_dir

def frames_to_mp4(frame_dir, fps=24, name=None):
    frame_dir = Path(frame_dir)
    pngs = sorted(frame_dir.glob("frame_*.png"))
    if not pngs:
        raise RuntimeError("没有帧可合成")
    mp4 = OUT / (name or f"{frame_dir.name}.mp4")
    sh(f'ffmpeg -y -loglevel error -framerate {fps} -pattern_type glob -i "{frame_dir}/frame_*.png" '
       f'-c:v libx264 -pix_fmt yuv420p -crf 18 "{mp4}"')
    print("mp4:", mp4, f"{mp4.stat().st_size/1024**2:.1f} MB")
    return mp4

# 示例（把路径换成你自己的）：
# d = render_blend("/content/drive/MyDrive/colabkit/inputs/my_scene.blend", frames="1-120", samples=64, res="1280x720")
# frames_to_mp4(d, fps=24)

# %% [markdown]
# ## 常见问题
# - **`无法分配后端`**：T4 池子满了。断开再连，等 1–2 分钟。设置已存成 T4，重连会自动申请。
# - **第一次渲染很慢**：Cycles 要编译 CUDA 内核（1–3 分钟），第二次同会话就快。
# - **`CUDA error: out of memory`**：降分辨率（`res="960x540"`）或降 `samples`，或改用 `use_gpu=False` 走 CPU。
# - **EEVEE 报错**：无头环境没有 GL 上下文，用 Cycles；真要 EEVEE 试 `--gpu-backend egl`。
# - **.blend 太大**：Drive 挂载读大文件慢，先 `cp` 到 `/content` 再渲染。
# - **别在 `/content` 存成品**：会话一断就没了，统一落 `OUT`（Drive）。

# %%
print("✅ 50 完成。Blender:", BLENDER)
print("输出目录:", OUT)
