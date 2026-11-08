"""Parkwright ride and stall models, built procedurally in Blender and exported as .glb.

  blender -b --factory-startup -P assets/blender/models.py -- <out_dir> <model>

Footprints match the content pack (tiles): carousel 3x3, teacups 3x3, wheel 3x2, swings 3x3, droptower 2x2,
spookwalk 3x2, stall 1x1, restroom 1x1. Fronts face -Y in Blender (+Z in the game), where entrances are.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import box, cone, cyl, empty, export, mat, reset, ring, sphere, torus  # noqa: E402

HORSE_COLOURS = ["red", "yellow", "blue", "green", "purple", "pink"]


def carousel():
    cyl(1.38, 0.16, (0, 0, 0.08), mat("stone"), verts=24)
    cyl(1.30, 0.08, (0, 0, 0.2), mat("cream"), verts=24)
    spin = empty("spin")
    cyl(0.14, 1.7, (0, 0, 1.0), mat("gold", metallic=0.6, roughness=0.3), spin, verts=12)
    # Roof with a scalloped valance and a gold finial.
    cone(1.5, 0.75, (0, 0, 2.02), mat("red"), spin, verts=12)
    for i, (x, y, a) in enumerate(ring(12, 1.42)):
        sphere(0.1, (x, y, 1.6), mat("cream" if i % 2 else "gold"), spin)
    cone(1.52, 0.2, (0, 0, 1.72), mat("cream"), spin, verts=12)
    sphere(0.1, (0, 0, 2.45), mat("gold", metallic=0.7), spin)
    for i, (x, y, a) in enumerate(ring(8, 1.02)):
        cyl(0.025, 1.45, (x, y, 0.98), mat("gold", metallic=0.6), spin, verts=6)
        horse = empty(f"horse{i}", (x, y, 0.72), spin)
        horse.rotation_euler = (0, 0, a + math.pi / 2)
        c = mat(HORSE_COLOURS[i % len(HORSE_COLOURS)])
        box((0.12, 0.38, 0.16), (0, 0, 0), c, horse, bevel=0.02)
        box((0.10, 0.12, 0.22), (0, 0.2, 0.12), c, horse, bevel=0.02)  # neck + head
        for lx, ly in ((0.04, 0.12), (-0.04, 0.12), (0.04, -0.12), (-0.04, -0.12)):
            box((0.03, 0.03, 0.18), (lx, ly, -0.16), c, horse)


def teacups():
    cyl(1.42, 0.16, (0, 0, 0.08), mat("stone"), verts=24)
    spin = empty("spin")
    cyl(1.3, 0.1, (0, 0, 0.21), mat("pink"), spin, verts=24)
    cyl(0.35, 0.5, (0, 0, 0.5), mat("cream"), spin, verts=12)
    sphere(0.22, (0, 0, 0.82), mat("pink"), spin)
    for i, (x, y, a) in enumerate(ring(5, 0.86)):
        c = mat(HORSE_COLOURS[i % len(HORSE_COLOURS)])
        cup = empty(f"cup{i}", (x, y, 0.27), spin)
        cyl(0.34, 0.36, (0, 0, 0.18), c, cup, verts=14, r2=0.24)
        cyl(0.27, 0.05, (0, 0, 0.34), mat("cream"), cup, verts=14)
        torus(0.11, 0.03, (0.36, 0, 0.2), c, cup, rot=(math.pi / 2, 0, 0), seg=10)


def wheel():
    # 3 wide (x) by 2 deep (y). Two A-frames hold the axle; the wheel turns about the x axis.
    for side in (-0.5, 0.5):
        for lean in (-1, 1):
            box((0.07, 0.07, 2.5), (lean * 0.5, side, 1.15), mat("steel", metallic=0.6), rot=(0, lean * 0.36, 0))
    box((0.1, 1.1, 0.1), (0, 0, 2.2), mat("steel", metallic=0.6))
    hub = empty("wheel", (0, 0, 2.2))
    for side in (-0.12, 0.12):
        torus(1.02, 0.035, (0, side, 0), mat("blue"), hub, rot=(math.pi / 2, 0, 0), seg=40)
    for i in range(10):
        a = 2 * math.pi * i / 10
        box((0.03, 0.26, 1.02), (0.5 * math.cos(a), 0, 0.5 * math.sin(a)), mat("cream"), hub, rot=(0, -a + math.pi / 2, 0))
        gondola = empty(f"g{i}", (1.0 * math.cos(a), 0, 1.0 * math.sin(a) - 0.14), hub)
        box((0.22, 0.24, 0.16), (0, 0, 0), mat(HORSE_COLOURS[i % len(HORSE_COLOURS)]), gondola, bevel=0.02)
        box((0.24, 0.26, 0.03), (0, 0, 0.12), mat("cream"), gondola)
    box((2.6, 1.5, 0.1), (0, 0, 0.05), mat("stone"))


def swings():
    cyl(1.35, 0.16, (0, 0, 0.08), mat("stone"), verts=24)
    cyl(0.16, 2.7, (0, 0, 1.43), mat("cream"), verts=12, r2=0.11)
    spin = empty("spin", (0, 0, 2.6))
    cone(1.15, 0.5, (0, 0, 0.1), mat("green"), spin, verts=16)
    cyl(1.16, 0.12, (0, 0, -0.16), mat("yellow"), spin, verts=16)
    for i, (x, y, a) in enumerate(ring(12, 0.98)):
        # Seats hang flung outward (the ride is shown running).
        arm = empty(f"arm{i}", (x, y, -0.2), spin)
        arm.rotation_euler = (0, 0, a)
        chain = empty(f"chain{i}", (0, 0, 0), arm)
        chain.rotation_euler = (0, 0.55, 0)
        cyl(0.01, 1.1, (0, 0, -0.55), mat("steel", metallic=0.7), chain, verts=4)
        box((0.16, 0.16, 0.05), (0, 0, -1.12), mat(HORSE_COLOURS[i % len(HORSE_COLOURS)]), chain, bevel=0.01)


def droptower():
    box((1.8, 1.8, 0.16), (0, 0, 0.08), mat("stone"), bevel=0.03)
    box((0.36, 0.36, 5.3), (0, 0, 2.75), mat("cream"), bevel=0.02)
    for z in [0.6 + 0.6 * i for i in range(8)]:
        box((0.42, 0.42, 0.04), (0, 0, z), mat("steel", metallic=0.6))
    cone(0.38, 0.6, (0, 0, 5.7), mat("purple"), verts=4, rot=(0, 0, math.pi / 4))
    sphere(0.12, (0, 0, 6.05), mat("glow", emissive=2.0))
    ring_ = empty("carriage", (0, 0, 0.55))
    cyl(0.72, 0.28, (0, 0, 0), mat("purple"), ring_, verts=12)
    for x, y, a in ring(8, 0.62):
        box((0.12, 0.14, 0.28), (x, y, 0.2), mat("yellow"), ring_, rot=(0, 0, a))


def spookwalk():
    # 3 wide x 2 deep haunted house; door and lanterns on the front (-Y).
    box((2.7, 1.7, 1.25), (0, 0.05, 0.62), mat("dark"), bevel=0.03)
    box((2.9, 1.9, 0.1), (0, 0.05, 1.3), mat("purple"))
    bpy_roof = cone(1.9, 0.95, (0, 0.05, 1.8), mat("dark"), verts=4, rot=(0, 0, math.pi / 4))
    bpy_roof.scale = (1.0, 0.68, 1.0)
    box((0.2, 0.2, 0.7), (-0.9, 0.5, 1.9), mat("dark"))  # crooked chimney
    box((0.5, 0.04, 0.8), (0, -0.82, 0.42), mat("wood"))  # door
    for x in (-0.9, 0.9):
        box((0.45, 0.04, 0.35), (x, -0.82, 0.8), mat("glow", emissive=1.5))  # lit windows
    for x in (-0.45, 0.45):
        cyl(0.02, 0.4, (x, -0.95, 1.1), mat("steel"), verts=4)
        sphere(0.09, (x, -0.95, 0.88), mat("glow", emissive=3.0))


def stall():
    box((0.78, 0.6, 0.62), (0, 0.06, 0.31), mat("cream"), bevel=0.02)
    box((0.82, 0.05, 0.08), (0, -0.25, 0.6), mat("wood"))  # counter
    for x in (-0.37, 0.37):
        cyl(0.02, 0.9, (x, -0.38, 0.45), mat("steel"), verts=6)
    # Striped awning, tilted toward the front.
    for i in range(5):
        c = mat("red") if i % 2 == 0 else mat("cream")
        box((0.17, 0.5, 0.04), (-0.34 + i * 0.17, -0.2, 0.92), c, rot=(-0.35, 0, 0))
    box((0.52, 0.04, 0.2), (0, 0.06, 1.12), mat("yellow"), bevel=0.01)  # sign


def restroom():
    box((0.82, 0.76, 0.72), (0, 0.02, 0.36), mat("stone"), bevel=0.02)
    box((0.92, 0.86, 0.08), (0, 0.02, 0.76), mat("teal"))
    box((0.24, 0.03, 0.44), (-0.16, -0.37, 0.24), mat("blue"))
    box((0.24, 0.03, 0.44), (0.16, -0.37, 0.24), mat("pink"))
    for x in (-0.16, 0.16):
        sphere(0.04, (x, -0.39, 0.56), mat("cream"))


MODELS = {f.__name__: f for f in (carousel, teacups, wheel, swings, droptower, spookwalk, stall, restroom)}

if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    name = args[1] if len(args) > 1 else "carousel"
    reset()
    MODELS[name]()
    export(name)
