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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    band, bulb, bulbs, bunting, box, brass, ball, canvas, chrome, cone, cyl, empty, export, glass, iron, line_fence, mat,
    hip_roof, paint, prism, reset, ring, ring_fence, rod, sign, sphere, steps, stone, text, torus, valance, wood,
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


def carousel():
    round_plinth(1.42)
    ring_fence(1.38, 0.18, brass(), posts=22, h=0.15, gap=0.75)
    spin = empty("spin")
    cyl(1.28, 0.05, (0, 0, 0.205), wood(), spin, verts=40)
    torus(1.28, 0.018, (0, 0, 0.23), brass(), spin, seg=40, minor_seg=4)
    # Centre drum with mirrored panels, brass bands and the pole up through the roof.
    cyl(0.34, 1.3, (0, 0, 0.88), paint("cream"), spin, verts=16)
    band(0.35, 0.7, (0, 0, 0.9), (paint("red"), mat("glass", metallic=1.0, roughness=0.1, tag="mirror")), spin, verts=16)
    for z in (0.52, 1.27):
        torus(0.355, 0.022, (0, 0, z), brass(), spin, seg=16, minor_seg=4)
    # Canopy: ceiling, striped valance ringed with bulbs, striped tent roof, finial and pennant.
    cyl(1.5, 0.03, (0, 0, 1.53), paint("cream"), spin, verts=32, bevel=0)
    band(1.52, 0.18, (0, 0, 1.62), (canvas("red"), canvas("cream")), spin, verts=24)
    torus(1.52, 0.018, (0, 0, 1.71), brass(), spin, seg=32, minor_seg=4)
    bulbs(24, 1.535, 1.6, spin, offset=TAU / 48)
    cone(1.54, 0.62, (0, 0, 2.02), None, spin, verts=16, stripes=(canvas("red"), canvas("cream")))
    cyl(0.05, 0.16, (0, 0, 2.37), brass(), spin, verts=8)
    ball(0.07, (0, 0, 2.47), brass(), spin, seg=8, rings=6)
    flag((0, 0, 2.5), "yellow", spin)
    # Eight horses on brass poles, alternately raised.
    for i, (x, y, a) in enumerate(ring(8, 1.0)):
        rod((x, y, 0.23), (x, y, 1.53), 0.016, brass(), spin, verts=8)
        z = 0.66 if i % 2 else 0.8
        horse = empty(f"horse{i}", (x, y, z), spin)
        horse.rotation_euler = (0, 0, a + math.pi / 2)
        hide = paint(["white", "cream", "wood", "white"][i % 4])
        tack = paint(COLOURS[i % len(COLOURS)])
        box((0.11, 0.34, 0.15), (0, 0, 0), hide, horse, bevel=0.04, segments=2)
        box((0.08, 0.1, 0.2), (0, 0.16, 0.11), hide, horse, rot=(-0.5, 0, 0), bevel=0.025)
        box((0.075, 0.16, 0.075), (0, 0.24, 0.23), hide, horse, rot=(0.35, 0, 0), bevel=0.025)
        box((0.025, 0.14, 0.1), (0, 0.13, 0.2), tack, horse, rot=(-0.5, 0, 0), bevel=0.01)  # mane
        box((0.125, 0.11, 0.035), (0, -0.02, 0.085), tack, horse, bevel=0.012)  # saddle
        for sx in (-0.035, 0.035):
            rod((sx, 0.12, -0.04), (sx, 0.24, -0.19), 0.016, hide, horse)
            rod((sx, -0.12, -0.04), (sx, -0.23, -0.17), 0.016, hide, horse)
        rod((0, -0.17, 0.03), (0, -0.25, -0.1), 0.018, tack, horse)


def teacups():
    round_plinth(1.44)
    ring_fence(1.4, 0.18, paint("white"), posts=22, h=0.15, gap=0.75)
    spin = empty("spin")
    cyl(1.28, 0.06, (0, 0, 0.21), paint("pink"), spin, verts=40)
    torus(1.28, 0.02, (0, 0, 0.24), paint("cream"), spin, seg=40, minor_seg=4)
    torus(0.62, 0.012, (0, 0, 0.24), paint("cream"), spin, seg=24, minor_seg=4)
    bulbs(20, 1.24, 0.26, spin)
    # The teapot in the middle.
    sphere(0.32, (0, 0, 0.5), paint("pink"), spin, subdiv=2, scale=(1, 1, 0.78))
    torus(0.31, 0.025, (0, 0, 0.5), paint("cream"), spin, seg=20, minor_seg=4)
    cyl(0.17, 0.06, (0, 0, 0.76), paint("cream"), spin, verts=16)
    ball(0.055, (0, 0, 0.82), brass(), spin, seg=8, rings=5)
    rod((0.24, 0, 0.42), (0.47, 0, 0.7), 0.045, paint("pink"), spin, verts=8)
    torus(0.13, 0.03, (-0.32, 0, 0.52), paint("pink"), spin, rot=(math.pi / 2, 0, 0), seg=12)
    for i, (x, y, a) in enumerate(ring(5, 0.9)):
        c = paint(COLOURS[i % len(COLOURS)])
        cup = empty(f"cup{i}", (x, y, 0.24), spin)
        cup.rotation_euler = (0, 0, a)
        cyl(0.36, 0.035, (0, 0, 0.02), paint("cream"), cup, verts=20)
        cyl(0.24, 0.32, (0, 0, 0.2), c, cup, verts=20, r2=0.32)
        torus(0.32, 0.02, (0, 0, 0.36), paint("cream"), cup, seg=20, minor_seg=4)
        cyl(0.29, 0.01, (0, 0, 0.362), paint("cream"), cup, verts=20, bevel=0)
        rod((0, 0, 0.36), (0, 0, 0.46), 0.015, chrome(), cup)
        torus(0.08, 0.012, (0, 0, 0.46), chrome(), cup, seg=10, minor_seg=4)
        torus(0.1, 0.028, (0.34, 0, 0.22), c, cup, rot=(math.pi / 2, 0, 0), seg=10)
        for d in (-0.5, 0, 0.5):
            ball(0.03, (0.3 * math.cos(math.pi + d), 0.3 * math.sin(math.pi + d), 0.24), paint("cream"), cup)


def wheel():
    # 3 wide (x) by 2 deep (y). Two A-frames hold the axle (along y); the wheel turns in the xz plane.
    box((2.8, 1.8, 0.1), (0, 0, 0.05), stone("concrete"))
    box((0.9, 0.55, 0.12), (0, -0.4, 0.16), wood(), bevel=0.015)  # loading deck
    box((0.5, 0.08, 0.08), (0, -0.71, 0.04), stone(), bevel=0.01)
    line_fence((-0.45, -0.66), (-0.14, -0.66), 0.22, paint("white"), posts=3, h=0.15)
    line_fence((0.14, -0.66), (0.45, -0.66), 0.22, paint("white"), posts=3, h=0.15)
    frame = paint("white")
    for side in (-0.42, 0.42):
        for lean in (-1, 1):
            box((0.08, 0.08, 2.46), (lean * 0.5, side, 1.17), frame, rot=(0, lean * 0.36, 0), bevel=0.02)
            box((0.2, 0.2, 0.1), (lean * 0.92, side, 0.15), stone(), bevel=0.02)  # footing
        for z, half in ((0.75, 0.66), (1.45, 0.4)):
            rod((-half, side, z), (half, side, z), 0.02, frame, verts=6)
        rod((-0.66, side, 0.75), (0.4, side, 1.45), 0.014, frame, verts=6)
        rod((0.66, side, 0.75), (-0.4, side, 1.45), 0.014, frame, verts=6)
    cyl(0.05, 1.0, (0, 0, 2.2), chrome(), verts=12, rot=(math.pi / 2, 0, 0))
    for side in (-0.47, 0.47):
        cyl(0.09, 0.08, (0, side, 2.2), paint("blue"), verts=12, rot=(math.pi / 2, 0, 0))
    hub = empty("wheel", (0, 0, 2.2))
    cyl(0.13, 0.32, (0, 0, 0), paint("blue"), hub, verts=16, rot=(math.pi / 2, 0, 0))
    for side in (-0.13, 0.13):
        torus(1.02, 0.028, (0, side, 0), paint("blue"), hub, rot=(math.pi / 2, 0, 0), seg=48)
        torus(0.6, 0.016, (0, side, 0), paint("white"), hub, rot=(math.pi / 2, 0, 0), seg=32, minor_seg=4)
        for x, z, a in ring(16, 1.0):
            rod((0.1 * math.cos(a), side * 0.9, 0.1 * math.sin(a)), (x, side, z), 0.009, chrome(), hub, verts=4)
        for x, z, a in ring(24, 1.06, offset=TAU / 48):
            ball(0.022, (x, side, z), bulb(), hub, seg=6, rings=3)
    for i in range(10):
        a = TAU * i / 10
        cx, cz = 1.02 * math.cos(a), 1.02 * math.sin(a)
        rod((cx, -0.13, cz), (cx, 0.13, cz), 0.014, chrome(), hub, verts=6)
        # Gondolas hang from their pins and stay level while the wheel turns (the loader counter-rotates hang*).
        g = empty(f"hang{i}", (cx, 0, cz), hub)
        c = paint(COLOURS[i % len(COLOURS)])
        rod((0, 0, 0), (0, 0, -0.08), 0.012, chrome(), g)
        cone(0.18, 0.06, (0, 0, -0.1), c, g, verts=4, rot=(0, 0, math.pi / 4))
        for sx in (-0.09, 0.09):
            for sy in (-0.08, 0.08):
                rod((sx, sy, -0.12), (sx, sy, -0.24), 0.008, chrome(), g, verts=4)
        box((0.24, 0.22, 0.1), (0, 0, -0.28), c, g, bevel=0.03, segments=2)
        box((0.2, 0.05, 0.04), (0, 0.06, -0.22), wood(), g, bevel=0.01)
    # Name board out front on two posts.
    for x in (-0.42, 0.42):
        rod((x, -0.78, 0.1), (x, -0.78, 0.6), 0.016, iron())
    sign("SKY WHEEL", (0, -0.8, 0.6), 0.96, 0.17, paint("navy"), paint("yellow"))


def swings():
    round_plinth(1.38)
    ring_fence(1.34, 0.18, paint("white"), posts=22, h=0.15, gap=0.75)
    cyl(0.34, 0.32, (0, 0, 0.34), paint("green"), verts=16)
    torus(0.34, 0.02, (0, 0, 0.5), brass(), seg=16, minor_seg=4)
    cyl(0.17, 2.3, (0, 0, 1.6), paint("cream"), verts=16, r2=0.12)
    for z in (0.9, 1.4, 1.9, 2.3):
        torus(0.16 - (z - 0.5) * 0.02, 0.02, (0, 0, z), paint("green"), seg=16, minor_seg=4)
    spin = empty("spin", (0, 0, 2.6))
    cyl(1.16, 0.02, (0, 0, -0.28), paint("cream"), spin, verts=32, bevel=0)
    band(1.18, 0.16, (0, 0, -0.2), (canvas("yellow"), canvas("cream")), spin, verts=24)
    torus(1.18, 0.016, (0, 0, -0.12), brass(), spin, seg=32, minor_seg=4)
    bulbs(24, 1.195, -0.21, spin, offset=TAU / 48)
    cone(1.2, 0.48, (0, 0, 0.12), None, spin, verts=16, stripes=(canvas("green"), canvas("cream")))
    cyl(0.04, 0.14, (0, 0, 0.42), brass(), spin, verts=8)
    ball(0.06, (0, 0, 0.5), brass(), spin, seg=8, rings=6)
    flag((0, 0, 0.53), "red", spin)
    for i, (x, y, a) in enumerate(ring(12, 0.9)):
        # Seats hang flung outward (the ride is shown running).
        arm = empty(f"arm{i}", (x, y, -0.28), spin)
        arm.rotation_euler = (0, 0, a)
        chain = empty(f"chain{i}", (0, 0, 0), arm)
        chain.rotation_euler = (0, -0.55, 0)
        for sy in (-0.055, 0.055):
            rod((0, sy, 0), (0, sy, -1.0), 0.006, chrome(), chain, verts=4)
        c = paint(COLOURS[i % len(COLOURS)])
        box((0.15, 0.14, 0.035), (0, 0, -1.02), c, chain, bevel=0.012)
        box((0.03, 0.14, 0.15), (-0.07, 0, -0.95), c, chain, bevel=0.012)
        rod((0.07, -0.055, -0.97), (0.07, 0.055, -0.97), 0.008, chrome(), chain, verts=4)


def droptower():
    box((1.84, 1.84, 0.14), (0, 0, 0.07), stone("concrete"), bevel=0.03)
    box((1.72, 1.72, 0.05), (0, 0, 0.165), stone(), bevel=0.015)
    box((0.5, 0.08, 0.09), (0, -0.96, 0.045), stone(), bevel=0.012)
    rail = paint("white")
    line_fence((-0.82, -0.82), (-0.25, -0.82), 0.19, rail, posts=4, h=0.16)
    line_fence((0.25, -0.82), (0.82, -0.82), 0.19, rail, posts=4, h=0.16)
    line_fence((-0.82, 0.82), (0.82, 0.82), 0.19, rail, posts=8, h=0.16)
    for x in (-0.82, 0.82):
        line_fence((x, -0.82), (x, 0.82), 0.19, rail, posts=8, h=0.16)
    # The tower: column, guide rails on the corners, banding, running lights.
    box((0.36, 0.36, 5.3), (0, 0, 2.75), paint("cream"), bevel=0.02)
    for sx in (-0.19, 0.19):
        for sy in (-0.19, 0.19):
            box((0.045, 0.045, 5.2), (sx, sy, 2.75), paint("steel"), bevel=0.01)
    for z in [0.6 + 0.6 * i for i in range(8)]:
        box((0.44, 0.44, 0.04), (0, 0, z), paint("purple"), bevel=0.01)
    for z in [0.9 + 0.6 * i for i in range(7)]:
        for x, y, _a in ring(4, 0.186, offset=-math.pi / 2):
            ball(0.022, (x, y, z), bulb(), seg=6, rings=3)
    box((0.62, 0.62, 0.36), (0, 0, 5.52), paint("purple"), bevel=0.03)
    box((0.66, 0.66, 0.04), (0, 0, 5.34), brass(), bevel=0.01)
    text("PLUMMET", (0, -0.315, 5.52), 0.1, paint("yellow"))
    cone(0.47, 0.5, (0, 0, 5.95), paint("purple"), verts=4, rot=(0, 0, math.pi / 4))
    rod((0, 0, 6.15), (0, 0, 6.32), 0.015, iron())
    ball(0.07, (0, 0, 6.34), bulb("beacon", 4.0), seg=8, rings=5)
    carriage = empty("carriage", (0, 0, 0.55))
    cyl(0.72, 0.18, (0, 0, 0), paint("purple"), carriage, verts=24)
    torus(0.72, 0.02, (0, 0, 0.09), chrome(), carriage, seg=24, minor_seg=4)
    cyl(0.3, 0.3, (0, 0, 0.05), paint("purple"), carriage, verts=16)
    for i, (x, y, a) in enumerate(ring(8, 0.6, offset=TAU / 16)):
        seat = empty(f"seat{i}", (x, y, 0.09), carriage)
        seat.rotation_euler = (0, 0, a)
        box((0.15, 0.15, 0.05), (0, 0, 0.03), paint("yellow"), seat, bevel=0.015)
        box((0.04, 0.15, 0.28), (-0.08, 0, 0.17), paint("yellow"), seat, bevel=0.015)
        torus(0.06, 0.012, (-0.02, 0, 0.26), chrome(), seat, rot=(math.pi / 2, 0, 0), seg=10, minor_seg=4)


def spookwalk():
    # 3 wide x 2 deep haunted house with a corner tower; porch, door and lanterns on the front (-Y).
    dark, trim, roof = paint("plum"), paint("purple"), mat("slate", roughness=0.85, tag="shingle")
    box((2.9, 1.9, 0.05), (0, 0, 0.025), stone("soil"), bevel=0.01)
    box((2.3, 1.24, 0.12), (0, 0.25, 0.11), stone("grave"), bevel=0.015)  # foundation
    box((2.2, 1.2, 1.05), (0, 0.25, 0.69), dark, bevel=0.02)
    for x in (-1.1, 1.1):
        for y in (-0.35, 0.85):
            box((0.08, 0.08, 1.06), (x, y, 0.69), trim, bevel=0.015)
    box((2.36, 1.36, 0.08), (0, 0.25, 1.25), trim, bevel=0.02)
    hip_roof(2.36, 1.36, 0.8, (0, 0.25, 1.29), roof)
    box((0.2, 0.2, 0.62), (-0.7, 0.5, 1.8), stone("brick"), rot=(0, 0.12, 0), bevel=0.015)  # crooked chimney
    # Corner tower with a spire and a lit window.
    cyl(0.27, 1.75, (0.95, -0.28, 0.93), dark, verts=8)
    torus(0.28, 0.03, (0.95, -0.28, 1.8), trim, seg=8, minor_seg=4)
    cone(0.36, 0.75, (0.95, -0.28, 2.18), roof, verts=8, smooth=False)
    rod((0.95, -0.28, 2.5), (0.95, -0.28, 2.75), 0.012, iron())
    ball(0.035, (0.95, -0.28, 2.75), iron())
    box((0.13, 0.03, 0.2), (0.95, -0.55, 1.45), bulb("glow", 1.5), bevel=0.005)
    # Porch: deck, posts, sloped roof, door.
    box((0.9, 0.34, 0.08), (-0.2, -0.52, 0.13), wood(dark=True), bevel=0.012)
    box((0.5, 0.1, 0.06), (-0.2, -0.74, 0.03), stone("grave"), bevel=0.01)
    for x in (-0.6, 0.2):
        rod((x, -0.65, 0.17), (x, -0.65, 0.78), 0.022, trim, verts=8)
    box((1.0, 0.42, 0.04), (-0.2, -0.52, 0.82), roof, rot=(-0.25, 0, 0), bevel=0.01)
    box((0.36, 0.04, 0.58), (-0.2, -0.36, 0.46), wood(dark=True), bevel=0.012)
    ball(0.025, (-0.06, -0.39, 0.45), brass())
    # Lit windows with frames and mullions.
    for x, z in ((-0.85, 0.66), (0.45, 0.66), (-0.2, 1.04), (-0.75, 1.04)):
        box((0.34, 0.03, 0.32), (x, -0.355, z), trim, bevel=0.008)
        box((0.28, 0.03, 0.26), (x, -0.365, z), bulb("glow", 1.5), bevel=0.004)
        box((0.02, 0.03, 0.26), (x, -0.375, z), dark, bevel=0)
        box((0.28, 0.03, 0.02), (x, -0.375, z), dark, bevel=0)
    # Wrought-iron fence along the front, open at the path, with lanterns on the gate posts.
    line_fence((-1.38, -0.88), (-0.48, -0.88), 0.05, iron(), posts=7, h=0.24)
    line_fence((0.08, -0.88), (1.38, -0.88), 0.05, iron(), posts=9, h=0.24)
    for x in (-0.44, 0.04):
        box((0.07, 0.07, 0.5), (x, -0.88, 0.3), stone("grave"), bevel=0.012)
        rod((x, -0.88, 0.55), (x, -0.88, 0.62), 0.01, iron())
        ball(0.06, (x, -0.88, 0.67), bulb("glow", 3.0), seg=8, rings=5)
        cone(0.07, 0.06, (x, -0.88, 0.74), iron(), verts=6)
    # Graves and a dead tree in the yard.
    for x, y, tilt in ((0.75, -0.66, 0.1), (1.18, -0.6, -0.15), (-1.2, -0.62, 0.08)):
        box((0.15, 0.05, 0.2), (x, y, 0.12), stone("grave"), rot=(0, tilt, 0), bevel=0.035, segments=2)
    t = wood(dark=True)
    rod((-1.28, 0.7, 0.05), (-1.25, 0.72, 0.85), 0.04, t, verts=6)
    for dx, dy, z0, z1 in ((0.2, 0.05, 0.6, 0.85), (-0.18, -0.06, 0.5, 0.75), (0.1, -0.12, 0.75, 1.0)):
        rod((-1.26, 0.71, z0), (-1.26 + dx, 0.71 + dy, z1), 0.015, t, verts=4)
    sign("LANTERN WALK", (-0.2, -0.96, 1.02), 0.78, 0.13, trim, paint("glow"))
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
