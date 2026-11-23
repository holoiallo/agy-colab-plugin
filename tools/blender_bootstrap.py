import os, re, sys, glob, time, shutil, subprocess, urllib.request
from pathlib import Path

MIRROR = "https://download.blender.org/release"
CACHE = Path("/content/drive/MyDrive/colabkit/apps")
CACHE.mkdir(parents=True, exist_ok=True)

def sh(c, check=True):
    p = subprocess.run(c, shell=True, capture_output=True, text=True)
    if p.returncode != 0:
        print((p.stderr or p.stdout)[-1200:])
        if check:
            raise RuntimeError(c[:80])
    return p

def pick(series):
    try:
        html = urllib.request.urlopen(f"{MIRROR}/{series}/", timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        print("list fail", series, e)
        return None
    ver = series.replace("Blender", "")
    names = sorted(set(re.findall(rf"blender-{re.escape(ver)}\.\d+-linux-x64\.tar\.xz", html)))
    return names[-1] if names else None

def ensure():
    got = sorted(glob.glob("/content/blender-*/blender"))
    if got:
        return got[-1], "cached-extract"
    series = "Blender4.5"
    name = pick(series) or pick("Blender4.2")
    if not name:
        print("回退到 apt")
        sh("apt-get -qq update >/dev/null 2>&1; apt-get -qq install -y blender >/dev/null 2>&1", check=False)
        return shutil.which("blender"), "apt"
    real_series = series if ver_in(name, "4.5") else "Blender4.2"
    t = CACHE / name
    if not t.exists():
        print("downloading", name, flush=True)
        urllib.request.urlretrieve(f"{MIRROR}/{real_series}/{name}", t)
    print("extracting…", flush=True)
    sh(f'tar -xf "{t}" -C /content')
    b = sorted(glob.glob("/content/blender-*/blender"))[-1]
    sh(f'chmod +x "{b}"')
    return b, "downloaded"

def ver_in(name, v):
    return f"-{v}." in name

t0 = time.time()
BL, how = ensure()
print("BLENDER:", BL, "|", how, "|", round(time.time() - t0, 1), "s")
print(sh(f'"{BL}" --version').stdout.splitlines()[0])
print("nvidia:", sh("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", check=False).stdout.strip())

SETUP = r'''
import bpy, sys
argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
o = dict(a.split("=",1) for a in argv if "=" in a)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.samples = int(o.get("samples","24"))
sc.cycles.use_denoising = True
rx, ry = o.get("res","960x540").split("x")
sc.render.resolution_x, sc.render.resolution_y = int(rx), int(ry)
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "CUDA"
    prefs.get_devices()
    for d in prefs.devices: d.use = (d.type == "CUDA")
    sc.cycles.device = "GPU"
    print("DEVICES:", [(d.name, d.type, d.use) for d in prefs.devices])
except Exception as e:
    print("GPU fail, CPU:", e); sc.cycles.device = "CPU"
print("ENGINE:", sc.render.engine, sc.cycles.device, sc.cycles.samples)
'''

SMOKE = r'''
import bpy, os, math, time
OUT = "/content/blender_smoke.png"
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.mesh.primitive_plane_add(size=12)
fl = bpy.context.object
m = bpy.data.materials.new("Floor"); m.use_nodes = True
b = m.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.05,0.06,0.08,1); b.inputs["Roughness"].default_value = 0.35
fl.data.materials.append(m)
bpy.ops.mesh.primitive_monkey_add(location=(-1.6,0,1.1), rotation=(0,0,math.radians(20)))
mo = bpy.context.object
for p in mo.data.polygons: p.use_smooth = True
mm = bpy.data.materials.new("Chrome"); mm.use_nodes = True
mb = mm.node_tree.nodes["Principled BSDF"]
mb.inputs["Base Color"].default_value = (0.9,0.75,0.35,1)
mb.inputs["Metallic"].default_value = 1.0; mb.inputs["Roughness"].default_value = 0.15
mo.data.materials.append(mm)
bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=(1.4,0.6,1.0))
bpy.context.object.data.materials.append(mm)
bpy.ops.mesh.primitive_torus_add(location=(0,-1.2,2.2), major_radius=1.4, minor_radius=0.05)
ring = bpy.context.object
em = bpy.data.materials.new("Neon"); em.use_nodes = True
nt = em.node_tree; nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial"); ei = nt.nodes.new("ShaderNodeEmission")
ei.inputs["Color"].default_value = (0.2,0.8,1.0,1); ei.inputs["Strength"].default_value = 12
nt.links.new(ei.outputs["Emission"], out.inputs["Surface"])
ring.data.materials.append(em)
bpy.ops.object.light_add(type="AREA", location=(3,-3,6))
k = bpy.context.object; k.data.energy = 1200; k.data.size = 4
bpy.ops.object.camera_add(location=(6.5,-6.5,4.2))
c = bpy.context.object; c.rotation_euler = (math.radians(66),0,math.radians(45)); sc.camera = c
sc.world = bpy.data.worlds.new("W"); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.06,0.09,0.12,1); bg.inputs["Strength"].default_value = 0.6
sc.render.filepath = OUT; sc.render.image_settings.file_format = "PNG"
bpy.ops.render.render(write_still=True)
print("SMOKE_OK", OUT, round(time.time()-t0,1), "s")
'''

Path("/content/blender_setup.py").write_text(SETUP)
Path("/content/blender_smoke.py").write_text(SMOKE)

t1 = time.time()
p = sh(f'"{BL}" -b --factory-startup -P /content/blender_smoke.py -P /content/blender_setup.py -- samples=24 res=960x540', check=False)
tail = (p.stdout or "")[-2500:]
print("---- blender stdout tail ----")
print(tail)
print("SMOKE_EXISTS", os.path.exists("/content/blender_smoke.png"),
      os.path.getsize("/content/blender_smoke.png") if os.path.exists("/content/blender_smoke.png") else 0,
      "bytes", round(time.time()-t1,1), "s")
out_dir = Path("/content/drive/MyDrive/colabkit/outputs/blender"); out_dir.mkdir(parents=True, exist_ok=True)
if os.path.exists("/content/blender_smoke.png"):
    shutil.copy("/content/blender_smoke.png", out_dir / "smoke.png")
    print("COPIED", out_dir / "smoke.png")
