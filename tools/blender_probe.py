import os, re, glob, time, base64, subprocess, urllib.request

MIRROR = "https://download.blender.org/release"
APPS = "/content/colabkit/apps"
os.makedirs(APPS, exist_ok=True)


def sh(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True)
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


def ensure():
    got = sorted(glob.glob("/content/blender-*/blender"))
    if got:
        return got[-1]
    name = pick("Blender4.5") or pick("Blender4.2")
    if not name:
        return None
    t = os.path.join(APPS, name)
    if not os.path.exists(t):
        print("DOWNLOAD", name)
        urllib.request.urlretrieve(f"{MIRROR}/Blender4.5/{name}", t)
    print("EXTRACT")
    sh(f'tar -xf "{t}" -C /content')
    b = sorted(glob.glob("/content/blender-*/blender"))[-1]
    sh(f'chmod +x "{b}"')
    return b


t0 = time.time()
BL = ensure()
if not BL:
    print("NO_BLENDER")
    raise SystemExit(1)
print("BLENDER", BL)
print(sh(f'"{BL}" --version').stdout.splitlines()[0])

SETUP = '''
import bpy, sys
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.samples = 8
sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 384, 216
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
print("ENGINE", sc.render.engine, sc.cycles.device)
'''

SCENE = '''
import bpy, math, time
t0 = time.time()
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.mesh.primitive_plane_add(size=12)
m = bpy.data.materials.new("Floor"); m.use_nodes = True
b = m.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1)
bpy.context.object.data.materials.append(m)
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
o = nt.nodes.new("ShaderNodeOutputMaterial"); e = nt.nodes.new("ShaderNodeEmission")
e.inputs["Color"].default_value = (0.2, 0.8, 1.0, 1); e.inputs["Strength"].default_value = 12
nt.links.new(e.outputs["Emission"], o.inputs["Surface"])
ring.data.materials.append(em)
bpy.ops.object.light_add(type="AREA", location=(3, -3, 6))
k = bpy.context.object; k.data.energy = 1200; k.data.size = 4
bpy.ops.object.camera_add(location=(6.5, -6.5, 4.2))
c = bpy.context.object; c.rotation_euler = (math.radians(66), 0, math.radians(45)); sc.camera = c
sc.world = bpy.data.worlds.new("W"); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.06, 0.09, 0.12, 1); bg.inputs["Strength"].default_value = 0.6
sc.render.filepath = "/content/smoke.png"
bpy.ops.render.render(write_still=True)
print("SMOKE_OK", round(time.time() - t0, 1))
'''

open("/content/setup.py", "w").write(SETUP)
open("/content/scene.py", "w").write(SCENE)

p = sh(f'"{BL}" -b --factory-startup -P /content/scene.py -P /content/setup.py')
print((p.stdout or "")[-1200:])

if os.path.exists("/content/smoke.png"):
    size = os.path.getsize("/content/smoke.png")
    b64 = base64.b64encode(open("/content/smoke.png", "rb").read()).decode()
    print("SMOKE_PNG_BYTES", size)
    print("SMOKE_PNG_B64", b64)
else:
    print("NO_PNG")
print("TOTAL", round(time.time() - t0, 1), "s")
