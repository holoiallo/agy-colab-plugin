# blender_job.py —— 交给 agent 用 execute_code 提交的 Blender 渲染任务
# 自包含：装 Blender（缓存在 Drive 时复用）→ 冒烟场景渲染一帧 → 打印机器可读标记
# agent 只需要读 stdout 里的 BLENDER_OK / SMOKE_OK 判断成败
import os, re, sys, glob, time, shutil, subprocess, urllib.request

MIRROR = "https://download.blender.org/release"
# 有 Drive 就复用缓存/落产物；API 起的 runtime 没有 Drive，就退回 /content
DRIVE = "/content/drive/MyDrive"
if os.path.isdir(DRIVE):
    APPS = os.path.join(DRIVE, "colabkit/apps")
    OUTD = os.path.join(DRIVE, "colabkit/outputs/blender")
else:
    APPS = "/content/colabkit/apps"
    OUTD = "/content/colabkit/outputs/blender"
print("CACHE_DIR", APPS)
print("OUT_DIR", OUTD)


def sh(cmd, check=True):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if p.returncode != 0 and check:
        print("STDERR:", (p.stderr or "")[-1200:])
        raise RuntimeError(f"失败: {cmd[:70]}")
    return p


def pick(series="Blender4.5"):
    try:
        html = urllib.request.urlopen(f"{MIRROR}/{series}/", timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        print("LIST_FAIL", e)
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
    name = pick(series) or pick("Blender4.2")
    if not name:
        print("FALLBACK_APT")
        sh("apt-get -qq update >/dev/null 2>&1; apt-get -qq install -y blender >/dev/null 2>&1", check=False)
        return shutil.which("blender"), "apt"
    tarball = os.path.join(APPS, name)
    if not os.path.exists(tarball):
        print("DOWNLOAD", name, flush=True)
        urllib.request.urlretrieve(f"{MIRROR}/{series}/{name}", tarball)
    sh(f'tar -xf "{tarball}" -C /content')
    b = sorted(glob.glob("/content/blender-*/blender"))[-1]
    sh(f'chmod +x "{b}"')
    return b, "downloaded"


SETUP = r'''
import bpy, sys
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
o = dict(a.split("=", 1) for a in argv if "=" in a)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.samples = int(o.get("samples", "24"))
sc.cycles.use_denoising = True
rx, ry = o.get("res", "960x540").split("x")
sc.render.resolution_x, sc.render.resolution_y = int(rx), int(ry)
sc.render.image_settings.file_format = "PNG"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = (d.type == "CUDA")
    sc.cycles.device = "GPU"
    print("DEVICES", [(d.name, d.type, d.use) for d in prefs.devices])
except Exception as e:
    print("GPU_FAIL", e)
    sc.cycles.device = "CPU"
'''

SMOKE = r'''
import bpy, os, math, time
OUT = os.environ.get("SMOKE_OUT", "/content/blender_smoke.png")
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.mesh.primitive_plane_add(size=12)
fl = bpy.context.object
m = bpy.data.materials.new("Floor"); m.use_nodes = True
b = m.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1)
b.inputs["Roughness"].default_value = 0.35
fl.data.materials.append(m)
bpy.ops.mesh.primitive_monkey_add(location=(-1.6, 0, 1.1), rotation=(0, 0, math.radians(20)))
mo = bpy.context.object
for p in mo.data.polygons: p.use_smooth = True
mm = bpy.data.materials.new("Chrome"); mm.use_nodes = True
mb = mm.node_tree.nodes["Principled BSDF"]
mb.inputs["Base Color"].default_value = (0.9, 0.75, 0.35, 1)
mb.inputs["Metallic"].default_value = 1.0
mb.inputs["Roughness"].default_value = 0.15
mo.data.materials.append(mm)
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(1.4, 0.6, 1.0))
bpy.context.object.data.materials.append(mm)
bpy.ops.mesh.primitive_torus_add(location=(0, -1.2, 2.2), major_radius=1.4, minor_radius=0.05)
ring = bpy.context.object
em = bpy.data.materials.new("Neon"); em.use_nodes = True
nt = em.node_tree; nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial"); ei = nt.nodes.new("ShaderNodeEmission")
ei.inputs["Color"].default_value = (0.2, 0.8, 1.0, 1); ei.inputs["Strength"].default_value = 12
nt.links.new(ei.outputs["Emission"], out.inputs["Surface"])
ring.data.materials.append(em)
bpy.ops.object.light_add(type="AREA", location=(3, -3, 6))
k = bpy.context.object; k.data.energy = 1200; k.data.size = 4
bpy.ops.object.camera_add(location=(6.5, -6.5, 4.2))
c = bpy.context.object; c.rotation_euler = (math.radians(66), 0, math.radians(45)); sc.camera = c
sc.world = bpy.data.worlds.new("W"); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.06, 0.09, 0.12, 1); bg.inputs["Strength"].default_value = 0.6
sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("SMOKE_OK", OUT, round(time.time() - t0, 1))
'''

t0 = time.time()
BL, how = ensure_blender()
print("BLENDER", BL, how)
print(sh(f'"{BL}" --version').stdout.splitlines()[0])
print("GPU_QUERY", sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", check=False).stdout.strip())

with open("/content/blender_setup.py", "w") as f:
    f.write(SETUP)
with open("/content/blender_smoke.py", "w") as f:
    f.write(SMOKE)

t1 = time.time()
p = sh(f'"{BL}" -b --factory-startup -P /content/blender_smoke.py -P /content/blender_setup.py -- samples=24 res=960x540', check=False)
tail = (p.stdout or "")[-1600:]
print("---- blender ----")
print(tail)

ok = os.path.exists("/content/blender_smoke.png")
print("SMOKE_EXISTS", ok, os.path.getsize("/content/blender_smoke.png") if ok else 0, "bytes", round(time.time() - t1, 1), "s")
if ok:
    os.makedirs(OUTD, exist_ok=True)
    shutil.copy("/content/blender_smoke.png", os.path.join(OUTD, "smoke.png"))
    print("COPIED", os.path.join(OUTD, "smoke.png"))
print("BLENDER_OK" if ok else "BLENDER_FAIL", "total", round(time.time() - t0, 1), "s")
