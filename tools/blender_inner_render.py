# blender_inner_render.py -- Shared Blender Cycles frame-list worker (local + Colab).
# Configures OptiX -> CUDA -> CPU fallback, persistent data, optional overrides, and renders frame_######.png.
import math
import os
import sys
import time
import bpy


def main():
    t0 = time.time()
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = dict(a.split("=", 1) for a in argv if "=" in a)
    frames = [int(x) for x in o["frames"].split(",") if x.strip()]
    out_dir = o["out_dir"]
    smoke = o.get("smoke", "0") == "1"
    force_cuda = o.get("force_cuda", "0") == "1"

    os.makedirs(out_dir, exist_ok=True)

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
    sc.cycles.use_denoising = o.get("denoise", "1") != "0"

    if o.get("res"):
        rx, ry = [int(v) for v in o["res"].split("x")]
        sc.render.resolution_x, sc.render.resolution_y = rx, ry
    elif smoke:
        sc.render.resolution_x, sc.render.resolution_y = 480, 270

    sc.render.image_settings.file_format = "PNG"
    if o.get("depth"):
        sc.render.image_settings.color_depth = o["depth"]
    sc.render.use_file_extension = True
    sc.render.use_persistent_data = True
    if hasattr(sc.render, "compositor_device"):
        sc.render.compositor_device = "CPU"

    chosen = None
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        candidates = ("CUDA",) if force_cuda else ("OPTIX", "CUDA")
        for backend in candidates:
            try:
                prefs.compute_device_type = backend
                prefs.get_devices()
                devs = [d for d in prefs.devices if d.type == backend]
                if devs:
                    for d in prefs.devices:
                        d.use = (d.type == backend)
                    chosen = backend
                    break
            except Exception:
                continue
        sc.cycles.device = "GPU" if chosen else "CPU"
        print("CYCLE_DEVICE", sc.cycles.device, chosen, [(d.name, d.type, d.use) for d in prefs.devices], flush=True)
    except Exception as e:
        print("GPU_FALLBACK_CPU", e, flush=True)
        sc.cycles.device = "CPU"

    for idx, f in enumerate(frames, 1):
        sc.frame_set(f)
        sc.render.filepath = os.path.join(out_dir, f"frame_{f:06d}.png")
        bpy.ops.render.render(write_still=True)
        if idx == 1 or idx % 10 == 0 or idx == len(frames):
            print(f"FRAME_OK {idx}/{len(frames)} f={f:06d}", flush=True)

    render_s = round(time.time() - t0, 2)
    print(f"RENDER_DONE count={len(frames)} render_s={render_s}", flush=True)


if __name__ == "__main__":
    main()
