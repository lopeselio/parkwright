"""Shared helpers for Parkwright's Blender model scripts.

Conventions (the game's loader relies on them):
  - 1 Blender unit = 1 tile. Origin at the centre of the footprint, ground at z = 0 (glTF export turns Z-up into Y-up).
  - A part that moves is parented to an empty the loader animates: "spin" (turns about the vertical axis),
    "wheel" (turns on its x axle), "carriage" (rides up and down), and "hang*" children of "wheel" (stay level).
    Scenery props sit under one empty each, named "prop_<name>".
  - Bevelled, smooth-shaded parts with weighted normals: a "detailed miniature" look, not facets.
  - A small shared set of materials. At export every part under the same animated empty and material is
    joined into one mesh, so a ride is a handful of draw calls however many parts it has.
Run headless: blender -b --factory-startup -P assets/blender/models.py -- <out_dir> <model>
"""
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

PALETTE = {
    "cream": (0.96, 0.92, 0.82),
    "white": (0.97, 0.96, 0.93),
    "wood": (0.55, 0.38, 0.24),
    "darkwood": (0.36, 0.24, 0.16),
    "dark": (0.17, 0.16, 0.22),
    "iron": (0.20, 0.22, 0.24),
    "steel": (0.72, 0.74, 0.78),
    "gold": (0.85, 0.66, 0.29),
    "red": (0.87, 0.33, 0.30),
    "orange": (0.93, 0.56, 0.24),
    "yellow": (0.95, 0.76, 0.30),
    "green": (0.45, 0.76, 0.43),
    "teal": (0.30, 0.66, 0.68),
    "blue": (0.37, 0.62, 0.86),
    "navy": (0.21, 0.29, 0.47),
    "purple": (0.55, 0.42, 0.82),
    "pink": (0.94, 0.56, 0.75),
    "glow": (1.0, 0.82, 0.48),
    "lamp": (1.0, 0.93, 0.74),
    "beacon": (1.0, 0.30, 0.25),
    "stone": (0.80, 0.78, 0.74),
    "concrete": (0.70, 0.69, 0.66),
    "brick": (0.70, 0.40, 0.31),
    "glass": (0.70, 0.86, 0.95),
    "water": (0.38, 0.72, 0.88),
    "leaf": (0.37, 0.62, 0.29),
    "leaf2": (0.47, 0.70, 0.33),
    "leaf3": (0.30, 0.52, 0.30),
    "pine": (0.22, 0.46, 0.30),
    "pine2": (0.28, 0.54, 0.34),
    "soil": (0.38, 0.27, 0.19),
    "grave": (0.62, 0.63, 0.66),
    # Recoloured per ride by the client (a stall's awning takes the stall's colour).
    "accent": (0.87, 0.33, 0.30),
}
_mats = {}


def _lin(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()


def mat(name, emissive=0.0, metallic=0.0, roughness=0.7, alpha=1.0, tag=""):
    key = (name, emissive, metallic, roughness, alpha, tag)
    if key in _mats:
        return _mats[key]
    label = tag or ("glow" if emissive else "")
    m = bpy.data.materials.new(f"pw_{name}{'_' + label if label else ''}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    # The palette is written in sRGB (as picked by eye); glTF base colours are linear.
    c = tuple(_lin(v) for v in PALETTE[name])
    bsdf.inputs["Base Color"].default_value = (*c, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emissive:
        bsdf.inputs["Emission Color"].default_value = (*c, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emissive
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    _mats[key] = m
    return m


# The shared material set. Everything a model uses comes from these few.
def paint(c):
    """Painted metal or enamel: a little sheen, no metal reflection."""
    return mat(c, metallic=0.1, roughness=0.42, tag="paint")


def chrome():
    return mat("steel", metallic=0.9, roughness=0.3, tag="chrome")


def brass():
    return mat("gold", metallic=1.0, roughness=0.32, tag="brass")


def iron():
    return mat("iron", metallic=0.6, roughness=0.5, tag="iron")


def wood(dark=False):
    return mat("darkwood" if dark else "wood", roughness=0.78)


def canvas(c):
    return mat(c, roughness=0.92, tag="canvas")


def glass():
    return mat("glass", metallic=0.0, roughness=0.06, alpha=0.45)


def stone(c="stone"):
    return mat(c, roughness=0.9)


def bulb(c="lamp", strength=3.0):
    return mat(c, emissive=strength)


def _finish(obj, material, parent=None, bevel=0.0, smooth=True, segments=1):
    if isinstance(material, (list, tuple)):
        for m in material:
            obj.data.materials.append(m)
    else:
        obj.data.materials.append(material)
    for p in obj.data.polygons:
        p.use_smooth = smooth
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(40)
        mod.harden_normals = True
    if smooth:
        # Big faces stay flat, curved surfaces stay smooth, bevels catch the light.
        wn = obj.modifiers.new("normals", "WEIGHTED_NORMAL")
        wn.keep_sharp = True
        wn.weight = 50
    if parent is not None:
        obj.parent = parent
    return obj


def _auto_bevel(dims):
    return min(0.03, min(dims) * 0.14)


def box(size, loc, material, parent=None, rot=(0, 0, 0), bevel=None, segments=1):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return _finish(o, material, parent, _auto_bevel(size) if bevel is None else bevel, segments=segments)


def cyl(r, depth, loc, material, parent=None, verts=16, rot=(0, 0, 0), r2=None, bevel=None, cap=True):
    fill = "NGON" if cap else "NOTHING"
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, vertices=verts, rotation=rot, end_fill_type=fill)
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=depth, location=loc, vertices=verts, rotation=rot, end_fill_type=fill)
    if bevel is None:
        bevel = 0.0 if r < 0.05 or not cap else min(0.025, r * 0.12, depth * 0.3)
    return _finish(bpy.context.active_object, material, parent, bevel)


def cone(r, depth, loc, material, parent=None, verts=16, rot=(0, 0, 0), stripes=None):
    """A cone; `stripes` = (mat_a, mat_b) paints alternate segments, like a tent roof."""
    bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=0, depth=depth, location=loc, vertices=verts, rotation=rot)
    o = bpy.context.active_object
    if stripes:
        _finish(o, list(stripes), parent)
        _stripe(o)
        return o
    return _finish(o, material, parent)


def band(r, depth, loc, stripes, parent=None, verts=24, r2=None):
    """An open cylinder (valance, drum) with alternating stripes."""
    o = cyl(r, depth, loc, list(stripes), parent, verts=verts, r2=r2, cap=False, bevel=0)
    _stripe(o)
    return o


def _stripe(o):
    # Side faces alternate materials; caps (more than 4 sides) stay on the first.
    i = 0
    for p in o.data.polygons:
        if len(p.vertices) <= 4:
            p.material_index = i % 2
            i += 1


def sphere(r, loc, material, parent=None, subdiv=1, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=r, location=loc, subdivisions=subdiv)
    o = bpy.context.active_object
    if tuple(scale) != (1, 1, 1):
        o.scale = scale
        bpy.ops.object.transform_apply(scale=True)
    return _finish(o, material, parent)


def ball(r, loc, material, parent=None, seg=6, rings=4):
    """A cheap UV sphere: light bulbs, knobs, finials."""
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=seg, ring_count=rings)
    return _finish(bpy.context.active_object, material, parent)


def torus(major, minor, loc, material, parent=None, rot=(0, 0, 0), seg=32, minor_seg=6):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rot, major_segments=seg, minor_segments=minor_seg)
    return _finish(bpy.context.active_object, material, parent)


def rod(p0, p1, r, material, parent=None, verts=6):
    """A thin cylinder from p0 to p1 (poles, braces, chains)."""
    a, b = Vector(p0), Vector(p1)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d.length, location=(a + b) / 2, vertices=verts)
    o = bpy.context.active_object
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return _finish(o, material, parent)


def text(body, loc, size, material, parent=None, depth=0.008, rot=(math.pi / 2, 0, 0)):
    """Extruded lettering for signs, centred on loc, facing -Y by default."""
    bpy.ops.object.text_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.data.body = body
    o.data.size = size
    o.data.extrude = depth
    o.data.align_x = "CENTER"
    o.data.align_y = "CENTER"
    o.data.resolution_u = 2
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.active_object
    return _finish(o, material, parent, smooth=False)


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = loc
    bpy.context.scene.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
    return e


def ring(n, radius, z=0.0, offset=0.0):
    """Points around a circle: (x, y, angle)."""
    for i in range(n):
        a = 2 * math.pi * i / n + offset
        yield radius * math.cos(a), radius * math.sin(a), a


# ---- Shared ride furniture -------------------------------------------------------------------------------

FRONT = -math.pi / 2  # the entrance side (-Y)


def ring_fence(r, z, material, posts=20, h=0.2, gap=0.6, parent=None):
    """A railing round a circular platform, open for `gap` radians at the front."""
    pts = []
    for x, y, a in ring(posts, r, offset=math.pi / posts):
        d = (a - FRONT + math.pi) % (2 * math.pi) - math.pi
        pts.append((x, y, abs(d) < gap / 2))
    for i, (x, y, skip) in enumerate(pts):
        if skip:
            continue
        cyl(0.014, h, (x, y, z + h / 2), material, parent, verts=5)
        ball(0.022, (x, y, z + h), material, parent, seg=5, rings=3)
        nx, ny, nskip = pts[(i + 1) % len(pts)]
        if not nskip:
            rod((x, y, z + h * 0.92), (nx, ny, z + h * 0.92), 0.011, material, parent, verts=4)
            rod((x, y, z + h * 0.45), (nx, ny, z + h * 0.45), 0.009, material, parent, verts=4)


def line_fence(p0, p1, z, material, posts=4, h=0.2, parent=None):
    """A straight railing from p0 to p1 (x, y)."""
    for i in range(posts):
        t = i / (posts - 1)
        x, y = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
        cyl(0.014, h, (x, y, z + h / 2), material, parent, verts=5)
        ball(0.022, (x, y, z + h), material, parent, seg=5, rings=3)
    rod((p0[0], p0[1], z + h * 0.92), (p1[0], p1[1], z + h * 0.92), 0.011, material, parent, verts=4)
    rod((p0[0], p0[1], z + h * 0.45), (p1[0], p1[1], z + h * 0.45), 0.009, material, parent, verts=4)


def bulbs(n, r, z, parent=None, c="lamp", size=0.028, offset=0.0):
    for x, y, _a in ring(n, r, offset=offset):
        ball(size, (x, y, z), bulb(c), parent, seg=6, rings=3)


def steps(width, y_edge, top, n=2, depth=0.1, material=None, x=0.0):
    """Steps down from a platform edge at y_edge (front, -Y) to the ground."""
    material = material or stone()
    for i in range(n):
        h = top * (n - i) / (n + 1)
        box((width, depth, h), (x, y_edge - depth * (i + 0.5), h / 2), material, bevel=0.012)


def sign(body, loc, width, height, board, letters, parent=None, rot_z=0.0, size=None):
    """A painted board with raised lettering, facing -Y (rot_z turns it about its centre)."""
    g = empty("signpivot", loc, parent)
    g.rotation_euler = (0, 0, rot_z)
    box((width, 0.04, height), (0, 0, 0), board, g, bevel=0.012)
    box((width + 0.04, 0.03, 0.025), (0, 0, height / 2 + 0.006), brass(), g, bevel=0.006)
    box((width + 0.04, 0.03, 0.025), (0, 0, -height / 2 - 0.006), brass(), g, bevel=0.006)
    text(body, (0, -0.025, 0), size or height * 0.62, letters, g)
    return g


# ---- Export -------------------------------------------------------------------------------------------------

KEEP = ("spin", "wheel", "carriage", "hang", "prop_")


def _keep(o):
    return o is not None and o.type == "EMPTY" and o.name.startswith(KEEP)


def _owner(o):
    p = o.parent
    while p is not None and not _keep(p):
        p = p.parent
    return p


def consolidate():
    """Apply modifiers, then join every mesh into one per (animated empty, material)."""
    scene = bpy.context.scene
    bpy.context.view_layer.update()
    meshes = [o for o in scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.convert(target="MESH")  # applies bevel + weighted normals
    groups = {}
    for o in list(scene.objects):
        if o.type != "MESH":
            continue
        owner = _owner(o)
        if len(o.data.materials) > 1:
            # Split striped parts so each piece lands in its material's group.
            bpy.ops.object.select_all(action="DESELECT")
            o.select_set(True)
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.separate(type="MATERIAL")
            bpy.ops.object.mode_set(mode="OBJECT")
            parts = list(bpy.context.selected_objects)
        else:
            parts = [o]
        for p in parts:
            m = p.active_material
            groups.setdefault((owner.name if owner else "", m.name if m else ""), (owner, []))[1].append(p)
    for (oname, mname), (owner, objs) in groups.items():
        # Join into a fresh object that sits exactly on the owner, so the mesh ends up in the owner's space.
        label = f"{oname or 'base'}_{mname}"
        target = bpy.data.objects.new(label, bpy.data.meshes.new(label))
        scene.collection.objects.link(target)
        target.matrix_world = owner.matrix_world.copy() if owner else Matrix.Identity(4)
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        target.select_set(True)
        bpy.context.view_layer.objects.active = target
        bpy.ops.object.join()
        if owner is not None:
            target.parent = owner
            target.matrix_parent_inverse = Matrix.Identity(4)
            target.matrix_basis = Matrix.Identity(4)
    # Helper empties (pivots) are baked in now; drop them, keeping the animated ones.
    for o in list(scene.objects):
        if o.type == "EMPTY" and not _keep(o):
            for c in list(o.children):
                mw = c.matrix_world.copy()
                c.parent = o.parent
                c.matrix_world = mw
            bpy.data.objects.remove(o)


def export(name):
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"{name}.glb")
    consolidate()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_selection=False, export_texcoords=False)
    print(f"EXPORTED {path} tris={tris} meshes={len(objs)}")
