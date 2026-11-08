"""Shared helpers for Parkwright's Blender model scripts.

Conventions (the game's loader relies on them):
  - 1 Blender unit = 1 tile. Origin at the centre of the footprint, ground at z = 0 (glTF export turns Z-up into Y-up).
  - A part that turns while the ride runs is parented to an empty named "spin" (rotates about the vertical axis).
  - Flat-shaded, low-poly, a small shared palette of materials (few draw calls).
Run headless: blender -b --factory-startup -P assets/blender/models/<name>.py -- <out_dir>
"""
import math
import os
import sys

import bpy

PALETTE = {
    "cream": (0.96, 0.92, 0.82),
    "wood": (0.55, 0.38, 0.24),
    "dark": (0.17, 0.16, 0.22),
    "steel": (0.72, 0.74, 0.78),
    "gold": (0.85, 0.66, 0.29),
    "red": (0.87, 0.33, 0.30),
    "orange": (0.93, 0.56, 0.24),
    "yellow": (0.95, 0.76, 0.30),
    "green": (0.45, 0.76, 0.43),
    "teal": (0.30, 0.66, 0.68),
    "blue": (0.37, 0.62, 0.86),
    "purple": (0.55, 0.42, 0.82),
    "pink": (0.94, 0.56, 0.75),
    "glow": (1.0, 0.82, 0.48),
    "stone": (0.80, 0.78, 0.74),
}
_mats = {}


def _lin(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mats.clear()


def mat(name, emissive=0.0, metallic=0.0, roughness=0.7):
    key = (name, emissive, metallic, roughness)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(f"pw_{name}{'_glow' if emissive else ''}")
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
    _mats[key] = m
    return m


def _finish(obj, material, parent=None, bevel=0.0):
    obj.data.materials.append(material)
    for p in obj.data.polygons:
        p.use_smooth = False
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = "ANGLE"
    if parent is not None:
        obj.parent = parent
    return obj


def box(size, loc, material, parent=None, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return _finish(o, material, parent, bevel)


def cyl(r, depth, loc, material, parent=None, verts=16, rot=(0, 0, 0), r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, vertices=verts, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=depth, location=loc, vertices=verts, rotation=rot)
    return _finish(bpy.context.active_object, material, parent)


def cone(r, depth, loc, material, parent=None, verts=16, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=0, depth=depth, location=loc, vertices=verts, rotation=rot)
    return _finish(bpy.context.active_object, material, parent)


def sphere(r, loc, material, parent=None, subdiv=1):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=r, location=loc, subdivisions=subdiv)
    return _finish(bpy.context.active_object, material, parent)


def torus(major, minor, loc, material, parent=None, rot=(0, 0, 0), seg=32):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rot, major_segments=seg, minor_segments=6)
    return _finish(bpy.context.active_object, material, parent)


def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = loc
    bpy.context.scene.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
    return e


def ring(n, radius, z=0.0):
    """Points around a circle: (x, y, angle)."""
    for i in range(n):
        a = 2 * math.pi * i / n
        yield radius * math.cos(a), radius * math.sin(a), a


def export(name):
    out = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"{name}.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_apply=True, export_yup=True, use_selection=False)
    print(f"EXPORTED {path}")
