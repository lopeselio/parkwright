"""Parkwright ride, stall and scenery models, built procedurally in Blender and exported as .glb.

  blender -b --factory-startup -P assets/blender/models.py -- <out_dir> <model>

Footprints match the content pack (tiles): carousel 3x3, teacups 3x3, wheel 3x2, swings 3x3, droptower 2x2,
spookwalk 3x2, stall 1x1, restroom 1x1. Fronts face -Y in Blender (+Z in the game), where entrances are.
"scenery" is one file of props (trees, benches, lamps, bins, fences, the park gate), each under a "prop_<name>" empty.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    band, bulb, bulbs, bunting, box, brass, ball, canvas, chrome, cone, cyl, empty, export, glass, iron, line_fence, mat,
    hip_roof, paint, prism, reset, ring, ring_fence, rod, sign, sphere, steps, stone, text, torus, valance, wood,
    festoon, finial, lamp_post, rider, round_valance,
)

COLOURS = ["red", "yellow", "blue", "green", "purple", "pink"]
TAU = 2 * math.pi


def squash(o, sx=1.0, sy=1.0, sz=1.0):
    """Scale the object just made along the world axes (rotation is baked in first)."""
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return o


def round_plinth(r, front_steps=True):
    """Two-tier stone base (top at z = 0.18) with steps to the entrance."""
    cyl(r, 0.12, (0, 0, 0.06), stone("concrete"), verts=40)
    cyl(r - 0.05, 0.06, (0, 0, 0.15), stone(), verts=40)
    if front_steps:
        box((0.56, 0.08, 0.09), (0, -r - 0.03, 0.045), stone(), bevel=0.012)


def flag(loc, colour, parent=None, h=0.22):
    x, y, z = loc
    rod((x, y, z), (x, y, z + h), 0.008, chrome(), parent, verts=4)
    box((0.1, 0.008, 0.06), (x + 0.05, y, z + h - 0.035), canvas(colour), parent, bevel=0)


def ride_sign(body, loc, width, board, rot_z=0.0, posts=True, h=0.17):
    """A ride's name board on two iron posts, lettered in a glowing cream so it lights up at dusk."""
    x, y, z = loc
    if posts:
        c, s_ = math.cos(rot_z), math.sin(rot_z)
        for d in (-width / 2 + 0.04, width / 2 - 0.04):
            px, py = x + d * c, y + d * s_
            rod((px, py, 0.02), (px, py, z), 0.016, iron())
    sign(body, (x, y, z), width, h, board, bulb("lamp", 1.2), rot_z=rot_z)
    for i in range(5):
        t = (i + 0.5) / 5 - 0.5
        ball(0.014, (x + t * width * math.cos(rot_z), y + t * width * math.sin(rot_z) - 0.035, z + h / 2 + 0.03), bulb(), seg=6, rings=3)


def horse(parent, loc, a, hide, tack, z_up):
    """A carousel horse on its pole, facing along the turn: arched neck, ears, a flowing mane and tail,
    a painted saddle with a blanket and bent legs mid-gallop."""
    h = empty("horsepivot", loc, parent)
    h.rotation_euler = (0, 0, a)
    box((0.11, 0.34, 0.14), (0, 0, 0), hide, h, bevel=0.04)  # barrel
    box((0.085, 0.11, 0.2), (0, 0.16, 0.11), hide, h, rot=(-0.55, 0, 0), bevel=0.03)  # neck
    box((0.075, 0.17, 0.08), (0, 0.25, 0.22), hide, h, rot=(0.4, 0, 0), bevel=0.03)  # head
    for sx in (-0.022, 0.022):
        cone(0.016, 0.05, (sx, 0.2, 0.29), hide, h, verts=4)  # ears
    box((0.028, 0.16, 0.12), (0, 0.13, 0.2), tack, h, rot=(-0.5, 0, 0), bevel=0.012)  # mane
    rod((0, -0.16, 0.03), (0, -0.25, -0.12), 0.022, tack, h, verts=6)  # tail
    box((0.13, 0.12, 0.03), (0, -0.02, 0.085), brass(), h, bevel=0.01)  # saddle
    box((0.135, 0.15, 0.06), (0, -0.02, 0.045), tack, h, bevel=0.012)  # blanket
    for sx in (-0.035, 0.035):
        rod((sx, 0.12, -0.04), (sx, 0.22, -0.13), 0.016, hide, h, verts=5)
        rod((sx, 0.22, -0.13), (sx, 0.26, -0.21), 0.014, hide, h, verts=5)
        rod((sx, -0.12, -0.04), (sx, -0.2, -0.13), 0.016, hide, h, verts=5)
        rod((sx, -0.2, -0.13), (sx, -0.21, -0.22), 0.014, hide, h, verts=5)
    return h


def carousel():
    round_plinth(1.42)
    # A painted skirt round the plinth, and lamps and a ticket box on the free corners of the 3x3.
    band(1.425, 0.1, (0, 0, 0.065), (paint("red"), paint("cream")), verts=40)
    torus(1.425, 0.014, (0, 0, 0.12), brass(), seg=40, minor_seg=4)
    ring_fence(1.36, 0.18, brass(), posts=22, h=0.16, gap=0.75)
    for x, y in ((-1.3, 1.3), (1.3, 1.3), (1.3, -1.3)):
        lamp_post((x, y, 0), h=0.62, post=paint("navy"))
    box((0.3, 0.26, 0.04), (-1.24, -1.24, 0.02), stone(), bevel=0.01)
    box((0.24, 0.2, 0.34), (-1.24, -1.22, 0.21), paint("cream"), bevel=0.015)
    box((0.16, 0.02, 0.12), (-1.24, -1.33, 0.27), paint("dark"), bevel=0.004)
    box((0.3, 0.26, 0.03), (-1.24, -1.24, 0.39), paint("red"), bevel=0.01)
    hip_roof(0.3, 0.26, 0.12, (-1.24, -1.24, 0.405), paint("red"))
    ball(0.02, (-1.24, -1.24, 0.54), brass(), seg=6, rings=4)
    ride_sign("CAROUSEL", (-1.24, -1.36, 0.47), 0.32, paint("navy"), posts=False, h=0.08)

    spin = empty("spin")
    # The turning floor: boards with a brass edge and an inlaid ring.
    cyl(1.28, 0.05, (0, 0, 0.205), wood(), spin, verts=40)
    torus(1.28, 0.018, (0, 0, 0.23), brass(), spin, seg=40, minor_seg=4)
    torus(0.62, 0.01, (0, 0, 0.232), brass(), spin, seg=24, minor_seg=4)
    # Centre drum: mirrored panels between brass bands, a band of bulbs round its crown.
    cyl(0.34, 1.3, (0, 0, 0.88), paint("cream"), spin, verts=16)
    band(0.35, 0.7, (0, 0, 0.9), (paint("red"), mat("glass", metallic=1.0, roughness=0.1, tag="mirror")), spin, verts=16)
    for z in (0.52, 1.27):
        torus(0.355, 0.022, (0, 0, z), brass(), spin, seg=16, minor_seg=4)
    bulbs(12, 0.36, 1.36, spin, offset=TAU / 24)
    # Canopy: a ceiling with a sunburst of lit rays, a deep rounding board of gold and red panels, a
    # scalloped fringe, bulbs top and bottom, then a two-stage striped roof (a flared skirt and a steep cap).
    cyl(1.5, 0.03, (0, 0, 1.53), paint("cream"), spin, verts=32, bevel=0)
    for x, y, a in ring(12, 1.0):
        rod((0.36 * math.cos(a), 0.36 * math.sin(a), 1.51), (1.42 * math.cos(a), 1.42 * math.sin(a), 1.51), 0.012, brass(), spin, verts=4)
        for t in (0.62, 0.96, 1.3):
            ball(0.018, (t * math.cos(a), t * math.sin(a), 1.49), bulb(), spin, seg=6, rings=3)
    band(1.53, 0.26, (0, 0, 1.67), (paint("accent"), paint("red")), spin, verts=24)
    for x, y, a in ring(24, 1.545):
        o = ball(0.05, (x, y, 1.67), mat("glass", metallic=1.0, roughness=0.1, tag="mirror"), spin, seg=6, rings=4)
        o.rotation_euler = (0, 0, a + math.pi / 2)
        o.scale = (0.9, 0.2, 1.3)
    torus(1.535, 0.02, (0, 0, 1.8), brass(), spin, seg=32, minor_seg=4)
    torus(1.535, 0.02, (0, 0, 1.54), brass(), spin, seg=32, minor_seg=4)
    round_valance(1.53, 1.5, 0.05, (canvas("cream"), canvas("red")), spin, n=32)
    bulbs(24, 1.56, 1.6, spin, offset=TAU / 48)
    bulbs(24, 1.56, 1.76, spin, offset=TAU / 48)
    cone(1.58, 0.5, (0, 0, 2.06), None, spin, verts=24, stripes=(canvas("red"), canvas("cream")))
    cyl(0.6, 0.14, (0, 0, 2.2), paint("cream"), spin, verts=24)
    torus(0.6, 0.016, (0, 0, 2.27), brass(), spin, seg=24, minor_seg=4)
    bulbs(12, 0.615, 2.2, spin)
    cone(0.7, 0.62, (0, 0, 2.58), None, spin, verts=24, stripes=(canvas("red"), canvas("cream")))
    finial((0, 0, 2.86), spin, h=0.3, flag_colour="yellow")
    # Pennants round the roof's edge.
    for x, y, a in ring(8, 1.2, offset=TAU / 16):
        finial((x, y, 1.94), spin, h=0.2, flag_colour=COLOURS[int(round(a / TAU * 8)) % len(COLOURS)])
    # Two rings of horses on brass poles, alternately raised, with riders on some; two chariots.
    hides = ["white", "cream", "wood", "white", "darkwood"]
    for i, (x, y, a) in enumerate(ring(8, 1.02)):
        rod((x, y, 0.23), (x, y, 1.53), 0.016, brass(), spin, verts=8)
        ball(0.026, (x, y, 1.49), brass(), spin, seg=6, rings=4)
        z = 0.66 if i % 2 else 0.8
        horse(spin, (x, y, z), a, paint(hides[i % len(hides)]), paint(COLOURS[i % len(COLOURS)]), z)
        if i % 3 != 1:
            rider((x, y, z + 0.1), spin, rot_z=a + math.pi, shirt=COLOURS[(i + 2) % len(COLOURS)], skin=["cream", "terracotta", "wood"][i % 3])
    for i, (x, y, a) in enumerate(ring(6, 0.66, offset=TAU / 12)):
        if i % 3 == 0:
            # A swan chariot: a bench with a curled neck at the front.
            ch = empty("chariot", (x, y, 0.23), spin)
            ch.rotation_euler = (0, 0, a)
            box((0.16, 0.3, 0.12), (0, 0, 0.08), paint("white"), ch, bevel=0.04, segments=2)
            box((0.16, 0.06, 0.2), (0, -0.13, 0.17), paint("white"), ch, bevel=0.025)
            rod((0, 0.14, 0.12), (0, 0.2, 0.32), 0.03, paint("white"), ch, verts=6)
            ball(0.04, (0, 0.18, 0.34), paint("white"), ch, seg=8, rings=5)
            cone(0.02, 0.06, (0, 0.13, 0.34), paint("orange"), ch, verts=6, rot=(math.pi / 2, 0, 0))
            box((0.17, 0.25, 0.025), (0, -0.02, 0.15), paint("gold"), ch, bevel=0.008)
            rider((0, -0.04, 0.16), ch, rot_z=math.pi, shirt="pink", skin="terracotta", legs=False)
            continue
        rod((x, y, 0.23), (x, y, 1.53), 0.014, brass(), spin, verts=8)
        z = 0.72 if i % 2 else 0.6
        horse(spin, (x, y, z), a, paint(hides[(i + 2) % len(hides)]), paint(COLOURS[(i + 3) % len(COLOURS)]), z)


def teacups():
    round_plinth(1.44)
    band(1.445, 0.1, (0, 0, 0.065), (paint("pink"), paint("cream")), verts=40)
    torus(1.445, 0.014, (0, 0, 0.12), paint("cream"), seg=40, minor_seg=4)
    ring_fence(1.4, 0.18, paint("white"), posts=22, h=0.15, gap=0.75)
    # A festoon canopy: a mast up through the teapot carries a crown, with strings of bulbs swung out to
    # six lamp posts round the edge (the cups whirl underneath).
    mast = paint("cream")
    cyl(0.035, 1.8, (0, 0, 0.9), mast, verts=8)
    cyl(0.14, 0.06, (0, 0, 1.78), paint("accent"), verts=12)
    cone(0.16, 0.18, (0, 0, 1.9), paint("accent"), verts=12)
    finial((0, 0, 1.98), h=0.24, flag_colour="yellow")
    bulbs(8, 0.145, 1.78)
    for i, (x, y, a) in enumerate(ring(6, 1.42, offset=TAU / 12)):
        cyl(0.05, 0.06, (x, y, 0.03), stone(), verts=8)
        cyl(0.025, 1.1, (x, y, 0.6), mast, verts=8)
        torus(0.03, 0.01, (x, y, 0.4), paint("pink"), seg=8, minor_seg=4)
        ball(0.05, (x, y, 1.18), bulb("lamp", 3.0), seg=8, rings=5)
        cone(0.06, 0.06, (x, y, 1.24), paint("pink"), verts=8)
        festoon((0.1 * math.cos(a), 0.1 * math.sin(a), 1.74), (x, y, 1.12), 0.12, n=7, c=["lamp", "glow", "pink"][i % 3])

    spin = empty("spin")
    # The turning floor: pink and cream sectors with a cream rim and a ring of bulbs.
    cyl(1.28, 0.05, (0, 0, 0.205), paint("cream"), spin, verts=40)
    cone(1.26, 0.012, (0, 0, 0.236), None, spin, verts=24, stripes=(paint("accent"), paint("cream")))
    torus(1.28, 0.02, (0, 0, 0.235), paint("cream"), spin, seg=40, minor_seg=4)
    torus(0.62, 0.012, (0, 0, 0.245), paint("cream"), spin, seg=24, minor_seg=4)
    bulbs(20, 1.25, 0.255, spin)
    # The teapot in the middle: a round body with a lid, a knob, a spout and a handle.
    sphere(0.34, (0, 0, 0.52), paint("pink"), spin, subdiv=2, scale=(1, 1, 0.8))
    torus(0.33, 0.025, (0, 0, 0.52), paint("cream"), spin, seg=20, minor_seg=4)
    for x, y, _a in ring(8, 0.325, offset=TAU / 16):
        ball(0.03, (x, y, 0.58), paint("cream"), spin, seg=6, rings=4)
    cyl(0.18, 0.06, (0, 0, 0.78), paint("cream"), spin, verts=16)
    sphere(0.15, (0, 0, 0.82), paint("pink"), spin, subdiv=1, scale=(1, 1, 0.5))
    ball(0.055, (0, 0, 0.9), brass(), spin, seg=8, rings=5)
    rod((0.26, 0, 0.44), (0.5, 0, 0.74), 0.045, paint("pink"), spin, verts=8)
    cyl(0.05, 0.05, (0.51, 0, 0.76), paint("cream"), spin, verts=8, r2=0.06)
    torus(0.14, 0.03, (-0.34, 0, 0.54), paint("pink"), spin, rot=(math.pi / 2, 0, 0), seg=12)
    shirts = ["blue", "yellow", "green", "purple", "red", "orange", "teal"]
    for i, (x, y, a) in enumerate(ring(5, 0.9)):
        c = paint(COLOURS[i % len(COLOURS)])
        cup = empty(f"cup{i}", (x, y, 0.24), spin)
        cup.rotation_euler = (0, 0, a)
        # Saucer, a flared cup with a cream lip and a band of dots, a handle, a wheel in the middle.
        cyl(0.36, 0.035, (0, 0, 0.02), paint("cream"), cup, verts=20)
        torus(0.36, 0.012, (0, 0, 0.04), c, cup, seg=20, minor_seg=4)
        cyl(0.22, 0.34, (0, 0, 0.21), c, cup, verts=20, r2=0.33)
        torus(0.33, 0.022, (0, 0, 0.38), paint("cream"), cup, seg=20, minor_seg=4)
        cyl(0.3, 0.01, (0, 0, 0.37), paint("cream"), cup, verts=20, bevel=0)
        for dx, dy, da in ring(10, 0.28):
            o = ball(0.026, (dx, dy, 0.25), paint("white"), cup, seg=6, rings=4)
            o.rotation_euler = (0, 0, da)
            o.scale = (0.4, 1, 1)
        rod((0, 0, 0.37), (0, 0, 0.47), 0.015, chrome(), cup)
        torus(0.08, 0.012, (0, 0, 0.47), chrome(), cup, seg=10, minor_seg=4)
        torus(0.1, 0.028, (0.36, 0, 0.24), c, cup, rot=(math.pi / 2, 0, 0), seg=10)
        # Two riders facing each other across the wheel.
        for k, (rx, ry, rz) in enumerate(((0.0, 0.17, math.pi), (0.0, -0.17, 0.0))):
            if (i + k) % 4 == 3:
                continue
            rider((rx, ry, 0.31), cup, rot_z=rz, shirt=shirts[(i * 2 + k) % len(shirts)],
                  skin=["cream", "terracotta", "wood"][(i + k) % 3], arms_up=(i + k) % 3 == 0, legs=False)


def wheel():
    # 3 wide (x) by 2 deep (y). Two trussed A-frames hold the axle (along y); the wheel turns in the xz plane.
    box((2.8, 1.8, 0.1), (0, 0, 0.05), stone("concrete"))
    box((2.7, 1.7, 0.03), (0, 0, 0.11), stone(), bevel=0.01)
    # A raised boarding deck in front of the lowest car, with steps, rails and a little striped canopy.
    box((0.9, 0.36, 0.5), (0, -0.4, 0.37), paint("cream"), bevel=0.015)
    box((0.96, 0.4, 0.04), (0, -0.4, 0.64), wood(), bevel=0.01)
    for i in range(4):
        h = 0.62 * (4 - i) / 5
        box((0.4, 0.09, h), (0, -0.62 - 0.09 * i, h / 2 + 0.1), stone(), bevel=0.01)
    for x in (-0.46, 0.46):
        line_fence((x, -0.58), (x, -0.22), 0.66, paint("white"), posts=3, h=0.15)
    line_fence((-0.46, -0.58), (-0.22, -0.58), 0.66, paint("white"), posts=2, h=0.15)
    line_fence((0.22, -0.58), (0.46, -0.58), 0.66, paint("white"), posts=2, h=0.15)
    for x in (-0.44, 0.44):
        rod((x, -0.56, 0.66), (x, -0.56, 1.0), 0.016, paint("white"), verts=6)
    for i in range(6):
        c = canvas("accent") if i % 2 == 0 else canvas("white")
        box((0.16, 0.24, 0.016), (-0.4 + i * 0.16, -0.56, 1.02), c, rot=(-0.3, 0, 0), bevel=0.004)
    valance(0.96, (0, -0.68, 0.97), 0.05, (canvas("accent"), canvas("white")), n=6)
    # Ticket booth on the front left corner and lamps on the others.
    box((0.28, 0.24, 0.36), (-1.15, -0.62, 0.29), paint("cream"), bevel=0.015)
    box((0.18, 0.02, 0.12), (-1.15, -0.745, 0.33), bulb("glow", 1.0), bevel=0.004)
    box((0.34, 0.3, 0.03), (-1.15, -0.62, 0.48), paint("accent"), bevel=0.01)
    hip_roof(0.34, 0.3, 0.12, (-1.15, -0.62, 0.495), paint("accent"))
    ball(0.02, (-1.15, -0.62, 0.63), brass(), seg=6, rings=4)
    for x, y in ((1.25, -0.72), (1.25, 0.72), (-1.25, 0.72)):
        lamp_post((x, y, 0.12), h=0.6, post=paint("navy"))
    frame = paint("white")
    for side in (-0.42, 0.42):
        for lean in (-1, 1):
            # Each leg is a pair of tubes laced with braces: a lighter, truss-like silhouette.
            for dy in (-0.05, 0.05):
                rod((lean * 0.94, side + dy, 0.15), (lean * 0.06, side + dy, 2.2), 0.026, frame, verts=8)
            for k in range(6):
                t0, t1 = k / 6, (k + 1) / 6
                p0 = (lean * (0.94 - 0.88 * t0), side - 0.05, 0.15 + 2.05 * t0)
                p1 = (lean * (0.94 - 0.88 * t1), side + 0.05, 0.15 + 2.05 * t1)
                rod(p0, p1, 0.01, frame, verts=4)
            box((0.22, 0.22, 0.12), (lean * 0.94, side, 0.17), stone(), bevel=0.02)  # footing
        for z, half in ((0.8, 0.6), (1.5, 0.3)):
            rod((-half, side, z), (half, side, z), 0.02, frame, verts=6)
        rod((-0.6, side, 0.8), (0.3, side, 1.5), 0.014, frame, verts=6)
        rod((0.6, side, 0.8), (-0.3, side, 1.5), 0.014, frame, verts=6)
        for z in (0.95, 1.3, 1.65, 1.95):
            t = (z - 0.15) / 2.05
            for lean in (-1, 1):
                ball(0.02, (lean * (0.94 - 0.88 * t), side - 0.08, z), bulb(), seg=6, rings=3)
    cyl(0.05, 1.04, (0, 0, 2.2), chrome(), verts=12, rot=(math.pi / 2, 0, 0))
    for side in (-0.47, 0.47):
        cyl(0.1, 0.08, (0, side, 2.2), paint("accent"), verts=12, rot=(math.pi / 2, 0, 0))
    hub = empty("wheel", (0, 0, 2.2))
    cyl(0.14, 0.32, (0, 0, 0), paint("accent"), hub, verts=16, rot=(math.pi / 2, 0, 0))
    for side in (-0.17, 0.17):
        cyl(0.2, 0.02, (0, side, 0), brass(), hub, verts=8, rot=(math.pi / 2, 0, 0))  # a star plate
    for side in (-0.13, 0.13):
        torus(1.02, 0.03, (0, side, 0), paint("accent"), hub, rot=(math.pi / 2, 0, 0), seg=48)
        torus(0.82, 0.014, (0, side, 0), paint("white"), hub, rot=(math.pi / 2, 0, 0), seg=40, minor_seg=4)
        torus(0.5, 0.014, (0, side, 0), paint("white"), hub, rot=(math.pi / 2, 0, 0), seg=32, minor_seg=4)
        for x, z, a in ring(20, 1.0):
            rod((0.12 * math.cos(a), side * 0.9, 0.12 * math.sin(a)), (x, side, z), 0.009, chrome(), hub, verts=4)
        # A star of lacing between the rims, and bulbs on every other spoke and round the rim.
        for k, (x, z, a) in enumerate(ring(20, 1.0)):
            b = a + TAU / 20
            rod((0.82 * math.cos(a), side, 0.82 * math.sin(a)), (1.02 * math.cos(b), side, 1.02 * math.sin(b)), 0.008, paint("white"), hub, verts=4)
            if k % 2 == 0:
                for rr in (0.4, 0.64):
                    ball(0.018, (rr * math.cos(a), side * 1.08, rr * math.sin(a)), bulb("glow" if k % 4 else "lamp"), hub, seg=6, rings=3)
        for x, z, a in ring(30, 1.065, offset=TAU / 60):
            ball(0.022, (x, side, z), bulb(), hub, seg=6, rings=3)
    shirts = ["blue", "yellow", "green", "purple", "red", "orange", "teal"]
    for i in range(10):
        a = TAU * i / 10
        cx, cz = 1.02 * math.cos(a), 1.02 * math.sin(a)
        rod((cx, -0.15, cz), (cx, 0.15, cz), 0.014, chrome(), hub, verts=6)
        # Gondolas hang from their pins and stay level while the wheel turns (the loader counter-rotates hang*):
        # a rounded tub with a domed, scalloped roof on four posts, and riders looking out.
        g = empty(f"hang{i}", (cx, 0, cz), hub)
        c = paint(COLOURS[i % len(COLOURS)])
        rod((0, 0, 0), (0, 0, -0.07), 0.012, chrome(), g)
        sphere(0.15, (0, 0, -0.1), c, g, subdiv=2, scale=(1.0, 0.85, 0.32))
        ball(0.025, (0, 0, -0.04), chrome(), g, seg=6, rings=4)
        for k, (x, y, _a) in enumerate(ring(10, 0.145)):
            ball(0.022, (x, y * 0.85, -0.13), paint("cream"), g, seg=6, rings=3)
        for sx in (-0.1, 0.1):
            for sy in (-0.08, 0.08):
                rod((sx, sy, -0.12), (sx, sy, -0.24), 0.008, chrome(), g, verts=4)
        box((0.26, 0.22, 0.1), (0, 0, -0.29), c, g, bevel=0.04, segments=2)
        box((0.27, 0.23, 0.02), (0, 0, -0.235), paint("cream"), g, bevel=0.008)
        if i % 3 != 2:
            for k, sx in enumerate((-0.055, 0.055)):
                rider((sx, 0.02, -0.29), g, shirt="white", skin="cream", hair=None, legs=False, s=0.9)
    # Name board out front on two posts.
    ride_sign("SKY WHEEL", (0, -0.98, 0.5), 0.96, paint("navy"))


def swings():
    round_plinth(1.38)
    band(1.385, 0.1, (0, 0, 0.065), (paint("accent"), paint("cream")), verts=40)
    torus(1.385, 0.014, (0, 0, 0.12), brass(), seg=40, minor_seg=4)
    ring_fence(1.34, 0.18, paint("white"), posts=22, h=0.15, gap=0.75)
    # An operator's booth on one corner, lamps on the others.
    box((0.26, 0.26, 0.04), (1.22, -1.22, 0.02), stone(), bevel=0.01)
    box((0.22, 0.22, 0.3), (1.22, -1.22, 0.19), paint("cream"), bevel=0.015)
    box((0.14, 0.02, 0.1), (1.22, -1.335, 0.24), bulb("glow", 1.0), bevel=0.004)
    box((0.3, 0.3, 0.03), (1.22, -1.22, 0.355), paint("accent"), bevel=0.01)
    hip_roof(0.3, 0.3, 0.12, (1.22, -1.22, 0.37), paint("accent"))
    for x, y in ((-1.3, 1.3), (1.3, 1.3), (-1.3, -1.3)):
        lamp_post((x, y, 0), h=0.62, post=paint("navy"))
    # The tower: a fluted base drum, a lattice of four tubes laced with braces, lights running up it.
    cyl(0.36, 0.34, (0, 0, 0.35), paint("accent"), verts=16)
    band(0.365, 0.22, (0, 0, 0.35), (paint("accent"), paint("cream")), verts=16)
    torus(0.36, 0.02, (0, 0, 0.52), brass(), seg=16, minor_seg=4)
    cyl(0.1, 2.3, (0, 0, 1.65), paint("cream"), verts=12)
    corners = [(0.17 * math.cos(a), 0.17 * math.sin(a)) for _x, _y, a in ring(4, 1.0, offset=TAU / 8)]
    for k, (x, y) in enumerate(corners):
        rod((x, y, 0.52), (x * 0.7, y * 0.7, 2.6), 0.018, paint("white"), verts=6)
        nx, ny = corners[(k + 1) % 4]
        for j in range(6):
            z0, z1 = 0.6 + j * 0.33, 0.6 + (j + 1) * 0.33
            f0, f1 = 1 - (z0 - 0.52) / 2.08 * 0.3, 1 - (z1 - 0.52) / 2.08 * 0.3
            a0, a1 = (x * f0, y * f0, z0), (nx * f1, ny * f1, z1)
            if j % 2:
                a0, a1 = (nx * f0, ny * f0, z0), (x * f1, y * f1, z1)
            rod(a0, a1, 0.008, paint("white"), verts=4)
        for j in range(7):
            z = 0.75 + j * 0.28
            f = 1 - (z - 0.52) / 2.08 * 0.3
            ball(0.02, (x * f * 1.12, y * f * 1.12, z), bulb("glow" if j % 2 else "lamp"), seg=6, rings=3)
    spin = empty("spin", (0, 0, 2.6))
    # The turning top: a ceiling, a rounding board with a scalloped fringe and two rows of bulbs, a flared
    # striped roof with a cupola, and pennants round the edge.
    cyl(1.16, 0.02, (0, 0, -0.28), paint("cream"), spin, verts=32, bevel=0)
    band(1.18, 0.2, (0, 0, -0.18), (paint("accent"), paint("cream")), spin, verts=24)
    torus(1.18, 0.018, (0, 0, -0.08), brass(), spin, seg=32, minor_seg=4)
    torus(1.18, 0.018, (0, 0, -0.28), brass(), spin, seg=32, minor_seg=4)
    round_valance(1.18, -0.31, 0.04, (canvas("cream"), canvas("accent")), spin, n=24)
    bulbs(24, 1.2, -0.13, spin, offset=TAU / 48)
    bulbs(24, 1.2, -0.23, spin)
    cone(1.22, 0.42, (0, 0, 0.13), None, spin, verts=24, stripes=(canvas("accent"), canvas("cream")))
    cyl(0.4, 0.12, (0, 0, 0.36), paint("cream"), spin, verts=16)
    bulbs(10, 0.41, 0.36, spin)
    cone(0.48, 0.44, (0, 0, 0.64), None, spin, verts=16, stripes=(canvas("accent"), canvas("cream")))
    finial((0, 0, 0.84), spin, h=0.3, flag_colour="red")
    for x, y, a in ring(6, 0.95, offset=TAU / 12):
        finial((x, y, 0.0), spin, h=0.2, flag_colour=COLOURS[int(round(a / TAU * 6)) % len(COLOURS)])
    shirts = ["blue", "yellow", "green", "purple", "red", "orange", "teal"]
    for i, (x, y, a) in enumerate(ring(12, 0.9)):
        # Chairs hang flung outward (the ride is shown running), each with a footrest and a bar.
        arm = empty(f"arm{i}", (x, y, -0.28), spin)
        arm.rotation_euler = (0, 0, a)
        chain = empty(f"chain{i}", (0, 0, 0), arm)
        chain.rotation_euler = (0, -0.55, 0)
        for sy in (-0.055, 0.055):
            rod((0, sy, 0), (0, sy, -1.0), 0.006, chrome(), chain, verts=4)
        c = paint(COLOURS[i % len(COLOURS)])
        box((0.15, 0.14, 0.035), (0, 0, -1.02), c, chain, bevel=0.012)
        box((0.03, 0.14, 0.17), (-0.07, 0, -0.94), c, chain, bevel=0.012)
        box((0.05, 0.12, 0.012), (0.12, 0, -1.1), chrome(), chain, bevel=0)
        rod((0.07, -0.055, -0.95), (0.07, 0.055, -0.95), 0.008, chrome(), chain, verts=4)
        if i % 4 != 3:
            rider((0, 0, -1.0), chain, rot_z=math.pi / 2, shirt=shirts[i % len(shirts)],
                  skin=["cream", "terracotta", "wood"][i % 3], arms_up=i % 3 == 0)


def droptower():
    box((1.84, 1.84, 0.14), (0, 0, 0.07), stone("concrete"), bevel=0.03)
    box((1.72, 1.72, 0.05), (0, 0, 0.165), stone(), bevel=0.015)
    box((0.5, 0.08, 0.09), (0, -0.96, 0.045), stone(), bevel=0.012)
    # The loading floor: a painted ring with a yellow safety line round where the gondola lands.
    cyl(0.86, 0.02, (0, 0, 0.195), paint("slate"), verts=32, bevel=0)
    torus(0.84, 0.012, (0, 0, 0.205), paint("yellow"), seg=32, minor_seg=4)
    rail = paint("white")
    line_fence((-0.82, -0.82), (-0.25, -0.82), 0.19, rail, posts=4, h=0.16)
    line_fence((0.25, -0.82), (0.82, -0.82), 0.19, rail, posts=4, h=0.16)
    line_fence((-0.82, 0.82), (0.82, 0.82), 0.19, rail, posts=8, h=0.16)
    for x in (-0.82, 0.82):
        line_fence((x, -0.82), (x, 0.82), 0.19, rail, posts=8, h=0.16)
    # A control booth on the back corner and lamps on the front ones.
    box((0.22, 0.22, 0.32), (0.66, 0.66, 0.35), paint("cream"), bevel=0.015)
    box((0.02, 0.14, 0.1), (0.545, 0.66, 0.4), bulb("glow", 1.0), bevel=0.004)
    box((0.27, 0.27, 0.03), (0.66, 0.66, 0.52), paint("accent"), bevel=0.01)
    for x in (-0.86, 0.86):
        lamp_post((x, -0.86, 0.19), h=0.55, post=paint("navy"))
    # The tower: a cream core inside a steel lattice (four rails laced on every face), bands in the ride's
    # colour, and strips of lights running up the front and back.
    box((0.3, 0.3, 5.3), (0, 0, 2.75), paint("cream"), bevel=0.02)
    for sx in (-0.19, 0.19):
        for sy in (-0.19, 0.19):
            box((0.05, 0.05, 5.2), (sx, sy, 2.75), paint("steel"), bevel=0.01)
    corners = [(-0.19, -0.19), (0.19, -0.19), (0.19, 0.19), (-0.19, 0.19)]
    for k in range(4):
        (x0, y0), (x1, y1) = corners[k], corners[(k + 1) % 4]
        for j in range(9):
            z0, z1 = 0.4 + j * 0.55, 0.4 + (j + 1) * 0.55
            if j % 2:
                rod((x0, y0, z0), (x1, y1, z1), 0.01, paint("steel"), verts=4)
            else:
                rod((x1, y1, z0), (x0, y0, z1), 0.01, paint("steel"), verts=4)
    for z in [0.6 + 0.6 * i for i in range(8)]:
        box((0.46, 0.46, 0.04), (0, 0, z), paint("accent"), bevel=0.01)
    for j in range(20):
        z = 0.8 + j * 0.22
        for y in (-0.2, 0.2):
            ball(0.02, (0, y * 1.08, z), bulb("lamp" if j % 2 else "glow"), seg=6, rings=3)
            ball(0.02, (y * 1.08, 0, z + 0.11), bulb("glow" if j % 2 else "lamp"), seg=6, rings=3)
    # The crown: a lit drum with the name on all four sides, a gallery with a rail, a pyramid roof,
    # a mast with the beacon, and pennants at the corners.
    box((0.7, 0.7, 0.06), (0, 0, 5.3), paint("steel"), bevel=0.015)
    for k in range(4):
        (x0, y0), (x1, y1) = corners[k], corners[(k + 1) % 4]
        rod((x0 * 1.8, y0 * 1.8, 5.42), (x1 * 1.8, y1 * 1.8, 5.42), 0.01, paint("white"), verts=4)
        cyl(0.012, 0.12, (x0 * 1.8, y0 * 1.8, 5.37), paint("white"), verts=4)
    box((0.56, 0.56, 0.4), (0, 0, 5.56), paint("accent"), bevel=0.03)
    for k in range(4):
        g = empty("crownface", (0, 0, 5.56))
        g.rotation_euler = (0, 0, k * math.pi / 2)
        box((0.46, 0.02, 0.17), (0, -0.282, 0), paint("dark"), g, bevel=0.006)
        text("PLUMMET", (0, -0.295, 0), 0.085, bulb("lamp", 1.4), g)
        for t in range(5):
            ball(0.016, (-0.2 + t * 0.1, -0.29, 0.15), bulb(), g, seg=6, rings=3)
    box((0.62, 0.62, 0.04), (0, 0, 5.77), brass(), bevel=0.01)
    cone(0.47, 0.5, (0, 0, 6.03), paint("accent"), verts=4, rot=(0, 0, math.pi / 4))
    for x, y in corners:
        finial((x * 1.6, y * 1.6, 5.79), h=0.2, flag_colour="yellow")
    rod((0, 0, 6.2), (0, 0, 6.4), 0.015, iron())
    ball(0.07, (0, 0, 6.42), bulb("beacon", 4.0), seg=8, rings=5)
    # The gondola ring that rides up and drops: seats with shoulder bars and riders with dangling legs,
    # a lit skirt underneath.
    carriage = empty("carriage", (0, 0, 0.55))
    cyl(0.72, 0.18, (0, 0, 0), paint("accent"), carriage, verts=24)
    torus(0.72, 0.02, (0, 0, 0.09), chrome(), carriage, seg=24, minor_seg=4)
    torus(0.72, 0.02, (0, 0, -0.09), chrome(), carriage, seg=24, minor_seg=4)
    bulbs(24, 0.735, 0.0, carriage)
    cyl(0.3, 0.34, (0, 0, 0.06), paint("accent"), carriage, verts=16)
    shirts = ["blue", "yellow", "green", "red", "orange", "teal", "pink", "white"]
    for i, (x, y, a) in enumerate(ring(8, 0.6, offset=TAU / 16)):
        seat = empty(f"seat{i}", (x, y, 0.09), carriage)
        seat.rotation_euler = (0, 0, a)
        box((0.15, 0.15, 0.05), (0, 0, 0.03), paint("yellow"), seat, bevel=0.015)
        box((0.04, 0.15, 0.3), (-0.08, 0, 0.18), paint("yellow"), seat, bevel=0.015)
        torus(0.07, 0.013, (0.0, 0, 0.27), chrome(), seat, rot=(0, math.pi / 2, 0), seg=10, minor_seg=4)
        if i % 3 != 2:
            rider((0.0, 0, 0.06), seat, rot_z=math.pi / 2, shirt=shirts[i], skin=["cream", "terracotta", "wood"][i % 3],
                  arms_up=i % 2 == 0)


def paper_lantern(loc, colour, parent=None, r=0.05):
    """A glowing paper lantern: a squashed ball with dark caps top and bottom."""
    x, y, z = loc
    o = ball(r, (x, y, z), bulb(colour, 2.2), parent, seg=8, rings=5)
    o.scale = (1, 1, 1.25)
    cyl(r * 0.55, 0.014, (x, y, z + r * 1.2), iron(), parent, verts=6, bevel=0)
    cyl(r * 0.55, 0.014, (x, y, z - r * 1.2), iron(), parent, verts=6, bevel=0)


def spookwalk():
    # 3 wide x 2 deep haunted house with a corner tower; a porch with a glowing doorway, dormers, iron
    # cresting, and the lantern-hung yard the walk is named for, on the front (-Y).
    dark, trim, roof = paint("plum"), paint("purple"), mat("slate", roughness=0.85, tag="shingle")
    box((2.9, 1.9, 0.05), (0, 0, 0.025), stone("soil"), bevel=0.01)
    box((0.5, 0.86, 0.012), (-0.2, -0.5, 0.055), stone("grave"), bevel=0)  # the path to the door
    box((2.3, 1.24, 0.12), (0, 0.25, 0.11), stone("grave"), bevel=0.015)  # foundation
    box((2.2, 1.2, 1.05), (0, 0.25, 0.69), dark, bevel=0.02)
    # Clapboard lines along the front.
    for z in (0.32, 0.47, 0.62, 0.77, 0.92, 1.07):
        box((2.2, 0.012, 0.012), (0, -0.352, z), trim, bevel=0)
    for x in (-1.1, 1.1):
        for y in (-0.35, 0.85):
            box((0.08, 0.08, 1.06), (x, y, 0.69), trim, bevel=0.015)
    box((2.36, 1.36, 0.08), (0, 0.25, 1.25), trim, bevel=0.02)
    hip_roof(2.36, 1.36, 0.8, (0, 0.25, 1.29), roof)
    # Iron cresting along the ridge with spiked finials.
    rod((-0.5, 0.25, 2.1), (0.5, 0.25, 2.1), 0.01, iron(), verts=4)
    for i in range(9):
        x = -0.5 + i * 0.125
        rod((x, 0.25, 2.08), (x, 0.25, 2.17 if i % 2 else 2.21), 0.007, iron(), verts=4)
    for x in (-0.52, 0.52):
        ball(0.03, (x, 0.25, 2.12), iron(), seg=6, rings=4)
    # A dormer on the front slope with a lit round window and its own little hipped roof.
    box((0.3, 0.3, 0.32), (-0.45, -0.12, 1.56), dark, bevel=0.01)
    box((0.36, 0.36, 0.03), (-0.45, -0.12, 1.73), trim, bevel=0.008)
    hip_roof(0.36, 0.36, 0.2, (-0.45, -0.12, 1.745), roof)
    torus(0.07, 0.014, (-0.45, -0.275, 1.58), trim, rot=(math.pi / 2, 0, 0), seg=12, minor_seg=4)
    cyl(0.06, 0.02, (-0.45, -0.27, 1.58), bulb("glow", 1.6), verts=12, rot=(math.pi / 2, 0, 0), bevel=0)
    box((0.2, 0.2, 0.62), (-0.85, 0.5, 1.8), stone("brick"), rot=(0, 0.12, 0), bevel=0.015)  # crooked chimney
    box((0.25, 0.25, 0.05), (-0.81, 0.5, 2.1), stone("grave"), rot=(0, 0.12, 0), bevel=0.01)
    # Corner tower: lit windows all round, a balcony, a tall spire with a weathervane and a bat or two.
    cyl(0.27, 1.75, (0.95, -0.28, 0.93), dark, verts=8)
    torus(0.28, 0.03, (0.95, -0.28, 1.8), trim, seg=8, minor_seg=4)
    torus(0.28, 0.025, (0.95, -0.28, 1.15), trim, seg=8, minor_seg=4)
    for k, (x, y, a) in enumerate(ring(4, 0.26, offset=-math.pi / 2)):
        g = empty("towerwin", (0.95 + x, -0.28 + y, 1.45))
        g.rotation_euler = (0, 0, a + math.pi / 2)
        box((0.14, 0.03, 0.22), (0, 0, 0), trim, g, bevel=0.006)
        box((0.1, 0.03, 0.17), (0, -0.008, 0), bulb("glow", 1.5), g, bevel=0.004)
        box((0.1, 0.035, 0.012), (0, -0.01, 0.0), dark, g, bevel=0)
    cone(0.4, 0.95, (0.95, -0.28, 2.3), roof, verts=8, smooth=False)
    torus(0.33, 0.012, (0.95, -0.28, 1.92), iron(), seg=8, minor_seg=4)
    for x, y, _a in ring(8, 0.33):
        rod((0.95 + x, -0.28 + y, 1.84), (0.95 + x, -0.28 + y, 1.93), 0.007, iron(), verts=4)
    rod((0.95, -0.28, 2.7), (0.95, -0.28, 3.0), 0.012, iron())
    ball(0.035, (0.95, -0.28, 2.82), iron())
    box((0.16, 0.012, 0.05), (0.98, -0.28, 2.93), iron(), bevel=0)
    cone(0.03, 0.06, (1.07, -0.28, 2.93), iron(), verts=3, rot=(0, math.pi / 2, 0))
    for bx, bz in ((0.72, 2.55), (1.2, 2.4)):
        for side in (-1, 1):
            box((0.07, 0.012, 0.03), (bx + side * 0.04, -0.4, bz), paint("dark"), rot=(0, side * 0.4, 0), bevel=0)
        ball(0.018, (bx, -0.4, bz), paint("dark"), seg=6, rings=4)
    # Porch: deck, turned posts, sloped roof edged with gingerbread trim, a glowing doorway and a ghost.
    box((0.9, 0.34, 0.08), (-0.2, -0.52, 0.13), wood(dark=True), bevel=0.012)
    box((0.5, 0.1, 0.06), (-0.2, -0.74, 0.03), stone("grave"), bevel=0.01)
    for x in (-0.6, 0.2):
        rod((x, -0.65, 0.17), (x, -0.65, 0.78), 0.022, trim, verts=8)
        ball(0.03, (x, -0.65, 0.5), trim, seg=6, rings=4)
    box((1.0, 0.42, 0.04), (-0.2, -0.52, 0.82), roof, rot=(-0.25, 0, 0), bevel=0.01)
    for i in range(9):
        o = cone(0.05, 0.06, (-0.64 + i * 0.11, -0.73, 0.74), trim, verts=3, rot=(math.pi, 0, 0))
        o.scale = (1, 0.3, 1)
    # A pointed doorway lit from inside (the ride's way in), with the door swung open.
    box((0.4, 0.05, 0.6), (-0.2, -0.355, 0.47), trim, bevel=0.012)
    box((0.3, 0.05, 0.5), (-0.2, -0.36, 0.43), bulb("glow", 1.8), bevel=0.006)
    prism([(-0.15, 0.0), (0.15, 0.0), (0.0, 0.14)], 0.05, (-0.2, -0.36, 0.68), trim, bevel=0.004)
    box((0.04, 0.2, 0.5), (-0.03, -0.46, 0.43), wood(dark=True), rot=(0, 0, 0.2), bevel=0.008)
    sphere(0.06, (-0.24, -0.4, 0.52), paint("white"), subdiv=2, scale=(1, 0.7, 1.2))  # a ghost in the door
    cone(0.07, 0.16, (-0.24, -0.4, 0.4), paint("white"), verts=8, rot=(math.pi, 0, 0))
    for dx in (-0.02, 0.02):
        ball(0.01, (-0.24 + dx, -0.445, 0.54), paint("dark"), seg=6, rings=3)
    # Lit windows with frames, mullions and crooked shutters.
    for x, z in ((-0.85, 0.66), (0.45, 0.66), (0.35, 1.04), (-0.85, 1.04)):
        box((0.34, 0.03, 0.32), (x, -0.355, z), trim, bevel=0.008)
        box((0.28, 0.03, 0.26), (x, -0.365, z), bulb("glow", 1.5), bevel=0.004)
        box((0.02, 0.03, 0.26), (x, -0.375, z), dark, bevel=0)
        box((0.28, 0.03, 0.02), (x, -0.375, z), dark, bevel=0)
        box((0.07, 0.02, 0.3), (x - 0.21, -0.37, z), wood(dark=True), rot=(0, 0.12, 0), bevel=0.006)
        box((0.07, 0.02, 0.3), (x + 0.21, -0.37, z - 0.02), wood(dark=True), rot=(0, -0.2, 0), bevel=0.006)
    # Wrought-iron fence along the front, open at the path, with lanterns on the gate posts.
    line_fence((-1.38, -0.88), (-0.48, -0.88), 0.05, iron(), posts=7, h=0.24)
    line_fence((0.08, -0.88), (1.38, -0.88), 0.05, iron(), posts=9, h=0.24)
    for x in (-0.44, 0.04):
        box((0.07, 0.07, 0.5), (x, -0.88, 0.3), stone("grave"), bevel=0.012)
        rod((x, -0.88, 0.55), (x, -0.88, 0.62), 0.01, iron())
        ball(0.06, (x, -0.88, 0.67), bulb("glow", 3.0), seg=8, rings=5)
        cone(0.07, 0.06, (x, -0.88, 0.74), iron(), verts=6)
    # The lantern walk: crooked poles across the yard hung with strings of paper lanterns.
    poles = [(-1.3, -0.7, 1.0), (-0.75, -0.62, 0.95), (0.35, -0.66, 1.0), (1.3, -0.72, 0.9)]
    for x, y, h in poles:
        rod((x, y, 0.05), (x + 0.03, y, h), 0.016, wood(dark=True), verts=5)
        rod((x + 0.03, y, h - 0.04), (x + 0.12, y, h - 0.04), 0.01, wood(dark=True), verts=4)
    hues = ["orange", "glow", "red", "yellow"]
    for k in range(len(poles) - 1):
        (x0, y0, h0), (x1, y1, h1) = poles[k], poles[k + 1]
        a, b = Vector((x0 + 0.03, y0, h0)), Vector((x1 + 0.03, y1, h1))
        n = 4 if k != 1 else 6
        pts = []
        for i in range(n + 1):
            t = i / n
            p = a.lerp(b, t)
            p.z -= 0.12 * 4 * t * (1 - t)
            pts.append(p)
        for i in range(n):
            rod(pts[i], pts[i + 1], 0.004, iron(), verts=3)
        for i, p in enumerate(pts[1:-1]):
            paper_lantern((p.x, p.y, p.z - 0.08), hues[(i + k) % len(hues)], r=0.05)
    # Graves, a pumpkin patch and a dead tree in the yard.
    for x, y, tilt in ((0.75, -0.66, 0.1), (1.12, -0.5, -0.15), (-1.2, -0.42, 0.08)):
        box((0.15, 0.05, 0.2), (x, y, 0.12), stone("grave"), rot=(0, tilt, 0), bevel=0.035, segments=2)
    for x, y in ((0.6, -0.42), (-0.95, -0.66), (1.25, -0.3)):
        sphere(0.06, (x, y, 0.09), bulb("orange", 0.8), subdiv=1, scale=(1, 1, 0.75))
        rod((x, y, 0.13), (x, y, 0.16), 0.01, mat("leaf3", roughness=0.85), verts=4)
    t = wood(dark=True)
    rod((-1.28, 0.7, 0.05), (-1.25, 0.72, 0.85), 0.04, t, verts=6)
    for dx, dy, z0, z1 in ((0.2, 0.05, 0.6, 0.85), (-0.18, -0.06, 0.5, 0.75), (0.1, -0.12, 0.75, 1.0)):
        rod((-1.26, 0.71, z0), (-1.26 + dx, 0.71 + dy, z1), 0.015, t, verts=4)
    sign("LANTERN WALK", (-0.2, -0.96, 1.02), 0.78, 0.13, trim, bulb("glow", 1.4))
    for x in (-0.55, 0.15):
        rod((x, -0.9, 0.62), (x, -0.9, 0.96), 0.012, iron())


def stall():
    # A kiosk with a hipped roof, a striped awning over the service window and a lit name board.
    # "accent" parts take the stall's colour in the game.
    accent, cream, trim = paint("accent"), paint("cream"), wood()
    box((0.94, 0.86, 0.05), (0, 0.03, 0.025), wood(dark=True), bevel=0.01)  # deck
    box((0.8, 0.56, 0.12), (0, 0.12, 0.11), accent, bevel=0.015)  # plinth
    box((0.76, 0.52, 0.66), (0, 0.12, 0.5), cream, bevel=0.018)  # body
    for x in (-0.38, 0.38):
        for y in (-0.14, 0.38):
            box((0.05, 0.05, 0.74), (x, y, 0.47), trim, bevel=0.01)  # corner posts
    # Service window: a dark opening, a counter, goods on it.
    box((0.56, 0.02, 0.26), (0, -0.15, 0.64), paint("dark"), bevel=0.004)
    box((0.7, 0.16, 0.035), (0, -0.2, 0.5), trim, bevel=0.01)
    for i, c in enumerate(("yellow", "red", "green")):
        cyl(0.035, 0.08, (-0.22 + i * 0.09, -0.21, 0.56), glass(), verts=8)
        ball(0.026, (-0.22 + i * 0.09, -0.21, 0.55), paint(c), seg=6, rings=4)
    box((0.12, 0.08, 0.07), (0.2, -0.2, 0.555), iron(), bevel=0.012)
    # Menu board on the side.
    box((0.02, 0.24, 0.28), (0.395, 0.14, 0.52), paint("dark"), bevel=0.006)
    for z in (0.58, 0.53, 0.48):
        box((0.01, 0.16, 0.012), (0.407, 0.14, z), paint("cream"), bevel=0)
    # Striped awning sloping out over the counter, with a scalloped fringe.
    for i in range(6):
        c = canvas("accent") if i % 2 == 0 else canvas("white")
        box((0.135, 0.3, 0.018), (-0.3375 + i * 0.135, -0.27, 0.86), c, rot=(-0.42, 0, 0), bevel=0.004)
    valance(0.81, (0, -0.41, 0.79), 0.05, (canvas("accent"), canvas("white")), n=6)
    # Gabled roof in the stall's colour over cream gable ends, a brass ridge, a finial and a pennant.
    box((0.84, 0.6, 0.03), (0, 0.12, 0.85), trim, bevel=0.01)
    prism([(-0.27, 0.86), (0.27, 0.86), (0.0, 1.03)], 0.76, (0, 0.12, 0), cream, bevel=0)
    for side in (-1, 1):
        box((0.9, 0.36, 0.028), (0, 0.12 + side * 0.155, 0.95), accent, rot=(-side * 0.55, 0, 0), bevel=0.01)
    rod((-0.46, 0.12, 1.045), (0.46, 0.12, 1.045), 0.016, brass(), verts=6)
    ball(0.035, (0.0, 0.12, 1.08), brass(), seg=8, rings=5)
    flag((0, 0.12, 1.08), "accent", h=0.16)
    # Name board across the front of the roof, lit along its bottom edge.
    box((0.6, 0.04, 0.17), (0, -0.16, 1.0), trim, bevel=0.012)
    box((0.53, 0.05, 0.11), (0, -0.165, 1.0), cream, bevel=0.01)
    box((0.4, 0.055, 0.035), (0, -0.17, 1.0), accent, bevel=0.006)
    for i in range(6):
        ball(0.014, (-0.25 + i * 0.1, -0.19, 0.905), bulb(), seg=6, rings=3)
    # A little planter by the door.
    cyl(0.06, 0.08, (-0.36, -0.3, 0.09), stone("terracotta"), verts=8)
    sphere(0.06, (-0.36, -0.3, 0.16), mat("leaf2", roughness=0.85), subdiv=1)


def restroom():
    box((0.92, 0.88, 0.05), (0, 0.02, 0.025), stone("concrete"), bevel=0.01)
    box((0.82, 0.74, 0.14), (0, 0.04, 0.12), stone("brick"), bevel=0.012)
    box((0.8, 0.72, 0.56), (0, 0.04, 0.46), paint("cream"), bevel=0.015)
    box((0.94, 0.88, 0.05), (0, 0.04, 0.76), paint("teal"), bevel=0.012)
    hip_roof(0.94, 0.88, 0.26, (0, 0.04, 0.78), paint("teal"))
    cyl(0.03, 0.14, (0.2, 0.2, 1.0), chrome(), verts=8)
    for x, c in ((-0.17, "blue"), (0.17, "pink")):
        box((0.26, 0.03, 0.46), (x, -0.33, 0.31), paint("white"), bevel=0.008)
        box((0.22, 0.03, 0.42), (x, -0.34, 0.29), paint(c), bevel=0.008)
        ball(0.022, (x, -0.36, 0.42), paint("white"), seg=8, rings=5)
        box((0.03 if c == "blue" else 0.05, 0.01, 0.06), (x, -0.36, 0.36), paint("white"), bevel=0)
        ball(0.014, (x + 0.07, -0.36, 0.28), brass())
    box((0.26, 0.03, 0.1), (0, -0.335, 0.62), paint("navy"), bevel=0.008)
    text("WC", (0, -0.355, 0.62), 0.075, paint("white"))
    for x in (-0.36, 0.36):
        ball(0.025, (x, -0.35, 0.58), bulb(), seg=8, rings=5)


# ---- Scenery props ------------------------------------------------------------------------------------------
# Each placed scenery kind has a few looks; the game picks one per tile from a hash, so a planted area isn't
# a row of clones. Props are drawn instanced and can be placed by the hundred, so each stays a few hundred
# triangles: blob crowns from low icospheres, few-sided trunks, block blooms.

def _leaf(c):
    return mat(c, roughness=0.85)


def _crown(p, blobs, colours):
    for (x, y, z, r, sz), c in zip(blobs, colours):
        sphere(r, (x, y, z), _leaf(c), p, scale=(1, 1, sz))


def _trunk(p, h, r=0.05, bark=None, forks=((0.1, 0.04), (-0.09, -0.05))):
    bark = bark or wood(dark=True)
    cyl(r * 1.25, 0.05, (0, 0, 0.025), bark, p, verts=7, r2=r)  # root flare
    cyl(r, h, (0, 0, h / 2), bark, p, verts=7, r2=r * 0.65)
    for dx, dy in forks:
        rod((0, 0, h * 0.7), (dx, dy, h * 1.08), r * 0.38, bark, p, verts=5)


def _oak(p, leaves, tall=1.0):
    _trunk(p, 0.42 * tall)
    blobs = ((0, 0, 0.66, 0.27, 0.9), (0.15, 0.06, 0.54, 0.19, 0.9), (-0.13, -0.08, 0.56, 0.2, 0.9),
             (0.03, -0.14, 0.72, 0.16, 1.0), (-0.06, 0.13, 0.62, 0.17, 0.9), (0.08, 0.04, 0.84, 0.14, 1.0))
    _crown(p, [(x, y, z * tall, r, sz) for x, y, z, r, sz in blobs], leaves)


def _round(p, leaves):
    """A clipped, round-crowned tree: a ball on a straight stem."""
    _trunk(p, 0.4, r=0.04, forks=())
    _crown(p, ((0, 0, 0.6, 0.25, 1.0), (0.08, -0.06, 0.7, 0.14, 1.0), (-0.09, 0.05, 0.5, 0.15, 1.0)), leaves)


def _birch(p):
    bark = mat("birch", roughness=0.7)
    for dx, dy, lean, h in ((0, 0, 0.0, 0.62), (0.08, 0.05, 0.12, 0.5)):
        rod((dx, dy, 0), (dx + lean, dy + lean * 0.4, h), 0.026, bark, p, verts=6)
        for z in (0.18, 0.32, 0.46):
            if z < h:
                t = z / h
                box((0.03, 0.03, 0.012), (dx + lean * t + 0.012, dy + lean * 0.4 * t - 0.012, z), paint("dark"), p, bevel=0)
    _crown(p, ((0.02, 0.01, 0.66, 0.17, 1.35), (0.12, 0.06, 0.56, 0.13, 1.3), (-0.06, -0.05, 0.52, 0.12, 1.3),
               (0.04, 0.03, 0.82, 0.11, 1.3)), ("leaf4", "leaf2", "leaf4", "leaf2"))


def _blossom(p):
    _trunk(p, 0.36, r=0.045, forks=((0.13, 0.03), (-0.1, -0.07), (0.0, 0.12)))
    _crown(p, ((0, 0, 0.58, 0.24, 0.75), (0.17, 0.04, 0.5, 0.16, 0.8), (-0.15, -0.08, 0.5, 0.16, 0.8),
               (0.02, 0.15, 0.53, 0.15, 0.8), (0.05, -0.04, 0.7, 0.15, 0.8)), ("blossom", "blossom2", "blossom", "blossom2", "blossom2"))


def _pine(p, tiers, colours, height=1.0, r0=0.32):
    cyl(0.045, 0.24, (0, 0, 0.12), wood(dark=True), p, verts=6)
    for i in range(tiers):
        t = i / tiers
        r = r0 * (1 - t * 0.62)
        o = cone(r, 0.42 * height, (0, 0, 0.36 * height + i * 0.2 * height), _leaf(colours[i % 2]), p, verts=9)
        o.rotation_euler = (0, 0, i * 0.35)


def _cypress(p):
    cyl(0.035, 0.12, (0, 0, 0.06), wood(dark=True), p, verts=6)
    sphere(0.13, (0, 0, 0.42), _leaf("pine2"), p, scale=(1, 1, 3.0))
    sphere(0.1, (0.03, 0.02, 0.6), _leaf("pine"), p, scale=(1, 1, 2.6))


def _bed_frame(p, material):
    box((0.86, 0.86, 0.1), (0, 0, 0.05), material, p, bevel=0.01)
    box((0.74, 0.74, 0.02), (0, 0, 0.1), stone("soil"), p, bevel=0)


def scenery():
    _oak(empty("prop_oak_a"), ("leaf", "leaf2", "leaf", "leaf3", "leaf2", "leaf4"))
    _oak(empty("prop_oak_b"), ("leaf3", "leaf", "leaf3", "leaf", "leaf2", "leaf"), tall=1.15)
    _round(empty("prop_oak_c"), ("leaf2", "leaf4", "leaf"))
    _birch(empty("prop_oak_d"))
    _blossom(empty("prop_oak_e"))
    _pine(empty("prop_pine_a"), 3, ("pine", "pine2"))
    _pine(empty("prop_pine_b"), 4, ("pine2", "pine"), height=0.92)
    _cypress(empty("prop_pine_c"))

    # Flower beds are placed by the dozen, so they stay cheap (a few hundred triangles each).
    p = empty("prop_flower")
    _bed_frame(p, stone("brick"))
    for i in range(9):
        x, y = ((i % 3) - 1) * 0.24, (i // 3 - 1) * 0.24
        cone(0.1, 0.1, (x, y, 0.16), _leaf("leaf2"), p, verts=6)
        c = mat(["red", "yellow", "pink", "purple"][i % 4], roughness=0.6)
        for dx, dy in ((0.035, 0.02), (-0.03, -0.03), (0.0, 0.045)):
            box((0.045, 0.045, 0.03), (x + dx, y + dy, 0.2), c, p, bevel=0)
    # Rows of tulips in a timber-edged bed.
    p = empty("prop_flower_b")
    _bed_frame(p, wood())
    for row in range(4):
        y = -0.27 + row * 0.18
        c = mat(["red", "yellow", "pink", "orange"][row], roughness=0.6)
        box((0.66, 0.05, 0.05), (0, y, 0.13), _leaf("leaf"), p, bevel=0)
        for k in range(6):
            x = -0.28 + k * 0.112
            rod((x, y, 0.11), (x, y, 0.2), 0.006, _leaf("leaf2"), p, verts=3)
            cyl(0.026, 0.045, (x, y, 0.22), c, p, verts=5, r2=0.034, bevel=0)
    # A round stone planter with a clipped shrub and a skirt of blooms.
    p = empty("prop_flower_c")
    cyl(0.4, 0.14, (0, 0, 0.07), stone(), p, verts=14)
    cyl(0.36, 0.02, (0, 0, 0.14), stone("soil"), p, verts=14, bevel=0)
    sphere(0.17, (0, 0, 0.27), _leaf("leaf3"), p, scale=(1, 1, 0.9))
    for x, y, a in ring(10, 0.27):
        c = mat(["pink", "white", "purple", "yellow", "red"][int(round(a * 10 / TAU)) % 5], roughness=0.6)
        box((0.05, 0.05, 0.04), (x, y, 0.17), c, p, rot=(0, 0, a), bevel=0)

    # A two-tier fountain: a basin with a rim and a coping, a column, a bowl, spray and a spout.
    p = empty("prop_fountain")
    water = mat("water", roughness=0.06, metallic=0.1)
    foam = mat("foam", roughness=0.3, alpha=0.75)
    cyl(0.45, 0.14, (0, 0, 0.07), stone(), p, verts=8)
    torus(0.43, 0.035, (0, 0, 0.15), stone("concrete"), p, seg=8, minor_seg=4, rot=(0, 0, math.pi / 8))  # coping
    cyl(0.41, 0.02, (0, 0, 0.145), water, p, verts=16, bevel=0)
    torus(0.2, 0.018, (0, 0, 0.158), foam, p, seg=16, minor_seg=4)  # ripples where the sheet lands
    cyl(0.07, 0.36, (0, 0, 0.32), stone(), p, verts=8)
    cyl(0.12, 0.06, (0, 0, 0.5), stone(), p, verts=12, r2=0.2)
    cyl(0.17, 0.012, (0, 0, 0.528), water, p, verts=12, bevel=0)
    cyl(0.04, 0.12, (0, 0, 0.58), stone(), p, verts=8)
    ball(0.045, (0, 0, 0.65), stone(), p, seg=8, rings=5)
    for x, y, _a in ring(8, 0.19, offset=TAU / 16):  # streams falling off the bowl's lip
        rod((x, y, 0.53), (x * 1.18, y * 1.18, 0.16), 0.012, foam, p, verts=4)
    sphere(0.06, (0, 0, 0.74), foam, p, scale=(1, 1, 1.6))

    p = empty("prop_hedge")
    box((0.92, 0.4, 0.07), (0, 0, 0.035), wood(dark=True), p, bevel=0.01)
    box((0.88, 0.34, 0.3), (0, 0, 0.21), _leaf("leaf3"), p, bevel=0.1, segments=2)
    for x in (-0.3, 0.0, 0.3):
        sphere(0.07, (x, -0.12, 0.33), _leaf("leaf"), p)
    # Clipped topiary balls in a trough.
    p = empty("prop_hedge_b")
    box((0.92, 0.36, 0.12), (0, 0, 0.06), stone(), p, bevel=0.015)
    for x in (-0.3, 0.0, 0.3):
        ball(0.15 if x else 0.17, (x, 0, 0.26 if x else 0.28), _leaf("leaf3" if x else "leaf"), p, seg=10, rings=7)

    p = empty("prop_bench")
    for y in (-0.045, 0.0, 0.045):
        box((0.52, 0.036, 0.014), (0, y, 0.11), wood(), p, bevel=0.005)
    for z in (0.17, 0.215):
        box((0.52, 0.012, 0.032), (0, 0.072, z), wood(), p, rot=(0.2, 0, 0), bevel=0.005)
    for x in (-0.22, 0.22):
        box((0.025, 0.14, 0.02), (x, 0, 0.1), iron(), p, bevel=0.005)
        rod((x, -0.05, 0), (x, -0.05, 0.1), 0.01, iron(), p, verts=5)
        rod((x, 0.05, 0), (x, 0.075, 0.24), 0.01, iron(), p, verts=5)
        rod((x, -0.06, 0.16), (x, 0.06, 0.16), 0.009, iron(), p, verts=5)  # armrest
        rod((x, -0.06, 0.1), (x, -0.06, 0.16), 0.008, iron(), p, verts=4)

    # A lantern on a fluted post: glass panes round a bright bulb, a cap and a finial.
    p = empty("prop_lamp")
    cyl(0.055, 0.07, (0, 0, 0.035), iron(), p, verts=8)
    cyl(0.02, 0.82, (0, 0, 0.47), iron(), p, verts=8, r2=0.014)
    torus(0.028, 0.008, (0, 0, 0.84), iron(), p, seg=8, minor_seg=4)
    cyl(0.04, 0.02, (0, 0, 0.87), iron(), p, verts=6)
    cyl(0.05, 0.13, (0, 0, 0.945), glass(), p, verts=6, r2=0.06, cap=False, bevel=0)
    ball(0.035, (0, 0, 0.94), bulb("lamp", 4.0), p, seg=8, rings=5)
    cone(0.075, 0.06, (0, 0, 1.04), iron(), p, verts=6)
    ball(0.012, (0, 0, 1.08), iron(), p)

    p = empty("prop_bin")
    cyl(0.075, 0.2, (0, 0, 0.1), paint("green"), p, verts=12, r2=0.068)
    torus(0.072, 0.012, (0, 0, 0.2), iron(), p, seg=12, minor_seg=4)
    torus(0.074, 0.008, (0, 0, 0.04), iron(), p, seg=12, minor_seg=4)
    sphere(0.072, (0, 0, 0.205), paint("green"), p, subdiv=1, scale=(1, 1, 0.4))

    # The fence rings the whole park (hundreds of segments), so it stays plain boxes: about 170 triangles.
    p = empty("prop_fence")
    white = paint("white")
    for x in (-0.5, 0.5):
        box((0.05, 0.05, 0.34), (x, 0, 0.17), white, p, bevel=0)
        box((0.07, 0.07, 0.025), (x, 0, 0.35), white, p, bevel=0)
    for z in (0.1, 0.24):
        box((1.0, 0.02, 0.035), (0, 0.015, z), white, p, bevel=0)
    for i in range(8):
        box((0.04, 0.015, 0.27), (-0.39 + i * 0.111, -0.008, 0.155), white, p, bevel=0)

    # The gate fits its own tile (±0.5): brick pillars with lanterns and flags, an arched sign with the
    # park's name, bunting, and turnstiles. Nothing spills onto the neighbouring tiles, where stalls go.
    p = empty("prop_gate")
    for x in (-0.4, 0.4):
        box((0.2, 0.2, 0.07), (x, 0, 0.035), stone(), p, bevel=0.012)
        box((0.16, 0.16, 1.3), (x, 0, 0.7), stone("brick"), p, bevel=0.015)
        for z in (0.45, 0.9):
            box((0.175, 0.175, 0.03), (x, 0, z), stone(), p, bevel=0.006)
        box((0.21, 0.21, 0.05), (x, 0, 1.375), stone(), p, bevel=0.01)
        cyl(0.04, 0.05, (x, 0, 1.42), iron(), p, verts=6)
        ball(0.055, (x, 0, 1.49), bulb("lamp", 3.0), p, seg=10, rings=6)
        cone(0.07, 0.06, (x, 0, 1.57), iron(), p, verts=6)
        flag((x, 0, 1.6), "red" if x < 0 else "yellow", p, h=0.26)
    # The arch: a curved red band riding over a straight sign board.
    for i in range(9):
        a0, a1 = math.pi * i / 9, math.pi * (i + 1) / 9
        x0, z0 = -0.4 * math.cos(a0), 1.16 + 0.16 * math.sin(a0)
        x1, z1 = -0.4 * math.cos(a1), 1.16 + 0.16 * math.sin(a1)
        rod((x0, 0, z0), (x1, 0, z1), 0.03, paint("red"), p, verts=6)
    box((0.66, 0.1, 0.2), (0, 0, 1.12), paint("navy"), p, bevel=0.02)
    box((0.7, 0.12, 0.03), (0, 0, 1.235), brass(), p, bevel=0.008)
    box((0.7, 0.12, 0.03), (0, 0, 1.005), brass(), p, bevel=0.008)
    text("PARKWRIGHT", (0, -0.055, 1.12), 0.085, paint("cream"), p)
    ball(0.045, (0, 0, 1.36), brass(), p, seg=8, rings=5)
    for i in range(6):
        ball(0.014, (-0.27 + i * 0.108, -0.06, 0.98), bulb(), p, seg=6, rings=3)
    bunting((-0.32, -0.07, 0.94), (0.32, -0.07, 0.94), 0.1, ("red", "yellow", "blue", "green"), p, n=7, size=0.055)
    # Turnstiles either side of the way in.
    for x in (-0.24, 0.24):
        cyl(0.03, 0.22, (x, 0, 0.11), chrome(), p, verts=8)
        for a in (0, TAU / 3, 2 * TAU / 3):
            rod((x, 0, 0.2), (x + 0.09 * math.cos(a), 0.09 * math.sin(a), 0.2), 0.008, chrome(), p, verts=4)

    # A ride entrance on its own tile: two posts with a name board in the ride's colour (accent), lamps,
    # and rope-and-post rails along the sides to guide the line. Faces -Y, the side visitors arrive from.
    p = empty("prop_entrance")
    accent = paint("accent")
    box((0.86, 0.86, 0.03), (0, 0, 0.015), stone(), p, bevel=0.008)
    for y in (-0.3, 0.3):
        box((0.6, 0.06, 0.012), (0, y, 0.034), canvas("accent"), p, bevel=0)  # a stripe at each threshold
    for x in (-0.38, 0.38):
        box((0.08, 0.08, 0.06), (x, 0.0, 0.06), stone(), p, bevel=0.01)
        box((0.055, 0.055, 0.78), (x, 0.0, 0.47), accent, p, bevel=0.012)
        ball(0.04, (x, 0.0, 0.9), bulb("lamp", 3.0), p, seg=8, rings=5)
        cone(0.05, 0.05, (x, 0.0, 0.955), iron(), p, verts=6)
        # Rope rails along the sides, from front to back.
        for y in (-0.36, 0.36):
            cyl(0.016, 0.24, (x, y, 0.12), chrome(), p, verts=6)
            ball(0.022, (x, y, 0.245), chrome(), p, seg=6, rings=3)
        rod((x, -0.36, 0.22), (x, -0.04, 0.22), 0.009, paint("red"), p, verts=4)
        rod((x, 0.04, 0.22), (x, 0.36, 0.22), 0.009, paint("red"), p, verts=4)
    box((0.84, 0.05, 0.18), (0, 0, 0.78), accent, p, bevel=0.02)
    box((0.7, 0.06, 0.1), (0, 0, 0.78), paint("cream"), p, bevel=0.012)
    for i in range(4):
        box((0.1, 0.065, 0.025), (-0.24 + i * 0.16, 0, 0.78), accent, p, bevel=0.004)  # a stripe of "lettering"
    box((0.88, 0.07, 0.025), (0, 0, 0.88), brass(), p, bevel=0.006)
    for i in range(5):
        ball(0.013, (-0.3 + i * 0.15, -0.035, 0.685), bulb(), p, seg=6, rings=3)

    # A coaster car: front is -Y here (+Z in the game, where the track runs). Two benches with riders'
    # heads, a rounded nose, a chrome lap bar and wheels. Painted accent, so each car takes its own colour.
    p = empty("prop_car")
    body = paint("accent")
    box((0.2, 0.28, 0.06), (0, 0, 0.04), iron(), p, bevel=0.012)  # chassis
    box((0.21, 0.27, 0.08), (0, 0, 0.1), body, p, bevel=0.025, segments=2)
    sphere(0.105, (0, -0.13, 0.1), body, p, scale=(1, 0.55, 0.7))
    for y in (-0.05, 0.07):
        box((0.17, 0.03, 0.09), (0, y + 0.04, 0.17), paint("dark"), p, bevel=0.012)  # seat back
        box((0.17, 0.008, 0.012), (0, y - 0.035, 0.17), chrome(), p, bevel=0)  # lap bar
        for x in (-0.045, 0.045):
            ball(0.028, (x, y, 0.2), paint(["cream", "brick"][int(x > 0)]), p, seg=6, rings=4)
    for x in (-0.11, 0.11):
        for y in (-0.09, 0.09):
            cyl(0.025, 0.02, (x, y, 0.025), iron(), p, verts=8, rot=(0, math.pi / 2, 0))

MODELS = {f.__name__: f for f in (carousel, teacups, wheel, swings, droptower, spookwalk, stall, restroom, scenery)}

if __name__ == "__main__":
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    name = args[1] if len(args) > 1 else "carousel"
    reset()
    MODELS[name]()
    export(name)
