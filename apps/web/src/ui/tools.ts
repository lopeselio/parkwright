import * as THREE from 'three';
import { rotatedSize, entranceFor, sceneryByName, stationEntrance, type Dir } from '@parkwright/sim';
import type { Game } from '../game.ts';
import type { World } from '../render/world.ts';
import { mat } from '../render/models.ts';
import { disposeGhost, pieceGhost } from '../render/coaster-ghost.ts';
import { toast } from './dom.ts';

export type Tool =
  | { kind: 'select' }
  | { kind: 'path'; queue: boolean }
  | { kind: 'ride'; type: string; rot: Dir }
  | { kind: 'scenery'; scenery: string }
  | { kind: 'coaster'; dir: Dir }
  | { kind: 'bin' }
  | { kind: 'bulldoze' };

/** Mouse → tile → action. Every placement goes through game.run, the same path the terminal uses. */
export class Tools {
  tool: Tool = { kind: 'select' };
  private dragFrom: [number, number] | null = null;
  private hover: [number, number] | null = null;
  private ghostOk = mat('#7ccf7a', { transparent: true, opacity: 0.55 });
  private ghostBad = mat('#e85d5d', { transparent: true, opacity: 0.55 });
  /** One shared unit box, scaled per preview — previews run on every mouse move, so nothing is allocated per frame. */
  private static unit = new THREE.BoxGeometry(1, 1, 1);
  onSelect: (rideId: number) => void = () => {};
  onChange: () => void = () => {};
  /** Echo the equivalent terminal command, so players learn `pw`. */
  onCommand: (line: string) => void = () => {};

  constructor(private game: Game, private world: World, canvas: HTMLCanvasElement) {
    // A different park (new game, load, visit, home): drop whatever we were building in the old one.
    game.onReplace(() => { this.lastPiece = 'straight'; if (this.tool.kind !== 'select') this.set({ kind: 'select' }); else this.previewPiece(null); });
    const ndc = (e: PointerEvent) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    let panning: { x: number; y: number } | null = null;
    const panBy = (dx: number, dy: number) => { const k = (world.zoom * 2) / innerHeight; world.pan(-dx * k, -dy * k * 1.4); };

    // ── Touch ──────────────────────────────────────────────────────────────
    // One finger: build tools act as with a mouse (drag paths, tap to place); with Inspect (or a tap tool) a
    // drag pans and a still tap selects. Two fingers: pinch zooms, drag pans, a quarter twist turns the view.
    const touches = new Map<number, { x: number; y: number }>();
    let tap: { id: number; x: number; y: number; tile: [number, number] | null; moved: boolean } | null = null;
    let pinch: { dist: number; zoom: number; mid: { x: number; y: number }; angle: number } | null = null;
    /** After a two-finger gesture, ignore the fingers until all of them lift (no stray tap or path). */
    let gestureLock = false;
    const two = () => { const [a, b] = [...touches.values()]; return { a, b }; };
    const pinchState = () => {
      const { a, b } = two();
      return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    };
    const TAP_SLOP = 10;
    const dragTool = () => this.tool.kind === 'path' || this.tool.kind === 'scenery' || this.tool.kind === 'bulldoze';

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      // Capture so a release outside the canvas (over the HUD or outside the window) still ends the drag here.
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      if (e.pointerType === 'touch') {
        // A primary touch means no other finger is down: forget any touch whose pointerup never came
        // (e.g. the app was backgrounded mid-gesture), so it can't lock out one-finger input.
        if (e.isPrimary) { touches.clear(); pinch = null; gestureLock = false; tap = null; }
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) {
          // A second finger turns whatever the first was doing into a camera gesture.
          tap = null; panning = null; this.dragFrom = null; gestureLock = true; this.hover = null;
          const p = pinchState();
          pinch = { ...p, zoom: world.zoom };
          this.preview();
          return;
        }
        if (gestureLock) return;
        const t = world.pickTile(ndc(e));
        this.hover = t;
        if (dragTool()) { if (t) this.dragFrom = t; this.preview(); return; }
        tap = { id: e.pointerId, x: e.clientX, y: e.clientY, tile: t, moved: false };
        this.preview();
        return;
      }
      if (e.button === 2 || e.button === 1) { panning = { x: e.clientX, y: e.clientY }; return; }
      const t = world.pickTile(ndc(e));
      if (!t) return;
      if (dragTool()) this.dragFrom = t;
      else this.click(t);
    });
    const cancel = () => { panning = null; this.dragFrom = null; tap = null; this.preview(); };
    const liftTouch = (id: number) => {
      touches.delete(id);
      if (touches.size < 2) pinch = null;
      // One of three fingers lifted: measure from the two that are left, so the camera doesn't jump.
      else if (pinch) pinch = { ...pinchState(), zoom: world.zoom };
      if (touches.size === 0) gestureLock = false;
    };
    canvas.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') { liftTouch(e.pointerId); this.hover = null; } cancel(); });
    canvas.addEventListener('lostpointercapture', (e) => { if (e.pointerType === 'touch' && touches.has(e.pointerId)) liftTouch(e.pointerId); panning = null; });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        const wasGesture = gestureLock;
        liftTouch(e.pointerId);
        // A finger has no hover: once it lifts, the ghost goes.
        const clearHover = () => { this.hover = null; this.preview(); };
        if (wasGesture) { this.dragFrom = null; clearHover(); return; }
        if (tap && tap.id === e.pointerId) {
          const t = tap;
          tap = null;
          if (!t.moved && t.tile) this.click(t.tile);
          clearHover();
          return;
        }
        if (this.dragFrom) {
          const t = world.pickTile(ndc(e)) ?? this.hover ?? this.dragFrom;
          this.drag(this.dragFrom, t);
          this.dragFrom = null;
        }
        clearHover();
        return;
      }
      if (panning) { panning = null; return; }
      if (!this.dragFrom) return;
      const t = world.pickTile(ndc(e)) ?? this.hover ?? this.dragFrom;
      this.drag(this.dragFrom, t);
      this.dragFrom = null;
      this.preview();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        const prev = touches.get(e.pointerId);
        if (!prev) return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) {
          const p = pinchState();
          world.setZoom(pinch.zoom * (pinch.dist / p.dist));
          panBy(p.mid.x - pinch.mid.x, p.mid.y - pinch.mid.y);
          pinch.mid = p.mid;
          // Twist: a quarter turn of the view per ~50° of finger rotation.
          let d = p.angle - pinch.angle;
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          if (Math.abs(d) > 0.87) { world.rotate(d > 0 ? -1 : 1); pinch.angle = p.angle; }
          return;
        }
        if (gestureLock) return;
        if (tap && tap.id === e.pointerId) {
          if (!tap.moved && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP) { tap.moved = true; this.hover = null; this.preview(); }
          if (tap.moved) panBy(e.clientX - prev.x, e.clientY - prev.y);
          return;
        }
        this.hover = world.pickTile(ndc(e));
        this.preview();
        return;
      }
      if (e.buttons === 0 && (panning || this.dragFrom)) { cancel(); return; }
      if (panning) {
        panBy(e.clientX - panning.x, e.clientY - panning.y);
        panning = { x: e.clientX, y: e.clientY };
        return;
      }
      this.hover = world.pickTile(ndc(e));
      this.preview();
    });
    canvas.addEventListener('wheel', (e) => { world.setZoom(world.zoom * (e.deltaY > 0 ? 1.1 : 0.9)); e.preventDefault(); }, { passive: false });
  }

  set(t: Tool) {
    this.tool = t;
    this.dragFrom = null;
    this.preview();
    this.onChange();
  }

  rotate() {
    if (this.tool.kind === 'ride') { this.tool = { ...this.tool, rot: ((this.tool.rot + 1) & 3) as Dir }; this.preview(); this.onChange(); }
    if (this.tool.kind === 'coaster') { this.tool = { ...this.tool, dir: ((this.tool.dir + 1) & 3) as Dir }; this.preview(); this.onChange(); }
  }

  /** The coaster currently under construction (untested), if any. */
  building() {
    return [...this.game.s.rides].reverse().find((r) => r.track && !r.ratings);
  }

  private nextPiece = new THREE.Group();
  /** The piece the builder previews when you're not pointing at one: the last one you added. */
  lastPiece = 'straight';

  /** Would this piece fit at the open end of the coaster being built? (Same check the sim runs.) */
  pieceCheck(piece: string) {
    const r = this.building();
    return r ? this.game.park.query('coaster.add', { piece, ride: r.id }) : null;
  }

  /** Show the see-through next piece at the open end (null hides it). */
  previewPiece(piece: string | null) {
    if (!this.nextPiece.parent) this.world.scene.add(this.nextPiece);
    for (const c of [...this.nextPiece.children]) { disposeGhost(c); this.nextPiece.remove(c); }
    const r = this.building();
    if (!piece || !r?.track) return null;
    const res = this.pieceCheck(piece)!;
    if (res.ok || !/already closed/.test(res.error)) this.nextPiece.add(pieceGhost(r.track, piece, res.ok));
    return res;
  }

  /** Run a coaster action from the builder panel. */
  coaster(type: string, params: Record<string, unknown>, cmd: string) {
    const r = this.exec(type, params, cmd);
    if (r.ok && type === 'coaster.start') this.lastPiece = 'straight';
    if (r.ok && r.message) toast(r.message);
    if (r.ok && r.focus) this.world.focus(r.focus.x, r.focus.y);
    this.onChange();
    return r;
  }

  private line(a: [number, number], b: [number, number]): [number, number, number, number] {
    // Paths go straight along the longer axis; scenery and bulldoze fill a rectangle.
    if (this.tool.kind === 'path') {
      if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) return [a[0], a[1], b[0], a[1]];
      return [a[0], a[1], a[0], b[1]];
    }
    return [a[0], a[1], b[0], b[1]];
  }

  private exec(type: string, params: Record<string, unknown>, cmd: string) {
    const r = this.game.run(type, params);
    if (!r.ok) toast(r.error, 'err', r.hint);
    else {
      this.onCommand(cmd);
      if (r.message && (type === 'ride.build' || r.cost === 0)) toast(r.message);
    }
    return r;
  }

  private click([x, y]: [number, number]) {
    const s = this.game.s;
    const t = this.tool;
    if (t.kind === 'select') {
      const id = this.world.rideAt(x, y);
      if (id) this.onSelect(id);
      return;
    }
    if (t.kind === 'ride') {
      const type = this.game.content.rideTypes[t.type];
      const [w, h] = rotatedSize(type.size[0], type.size[1], t.rot);
      const ox = x - Math.floor((w - 1) / 2), oy = y - Math.floor((h - 1) / 2);
      const r = this.exec('ride.build', { type: t.type, x: ox, y: oy, rot: t.rot }, `pw ride build ${t.type} ${ox} ${oy} --rot ${t.rot}`);
      if (r.ok && type.kind === 'flat') {
        const id = (r.data as { id: number }).id;
        this.game.run('ride.open', { ride: id });
        this.onSelect(id);
      }
      return;
    }
    if (t.kind === 'bin') { this.exec('bin.place', { x, y }, `pw bin place ${x} ${y}`); return; }
    if (t.kind === 'coaster') {
      if (this.building()) { toast('finish or test the coaster you are building first', 'err', 'use the track pieces in the panel'); return; }
      this.coaster('coaster.start', { x, y, dir: t.dir }, `pw coaster start ${x} ${y} --dir ${t.dir}`);
      return;
    }
    void s;
  }

  private drag(a: [number, number], b: [number, number]) {
    const [x, y, x2, y2] = this.line(a, b);
    const t = this.tool;
    if (t.kind === 'path') this.exec('path.place', { x, y, x2, y2, queue: t.queue }, `pw ${t.queue ? 'queue' : 'path'} place ${x} ${y} ${x2} ${y2}`);
    else if (t.kind === 'scenery') this.exec('scenery.place', { kind: t.scenery, x, y, x2, y2 }, `pw scenery place ${t.scenery} ${x} ${y} ${x2} ${y2}`);
    else if (t.kind === 'bulldoze') {
      const s = this.game.s;
      const id = this.world.rideAt(a[0], a[1]);
      if (id && a[0] === b[0] && a[1] === b[1]) {
        const ride = s.rides.find((r) => r.id === id)!;
        this.exec('ride.demolish', { ride: id }, `pw ride demolish ${ride.name}`);
        return;
      }
      const hadScenery = this.game.park.query('scenery.remove', { x, y, x2, y2 }).ok;
      if (hadScenery) this.exec('scenery.remove', { x, y, x2, y2 }, `pw scenery remove ${x} ${y} ${x2} ${y2}`);
      else this.exec('path.remove', { x, y, x2, y2 }, `pw path remove ${x} ${y} ${x2} ${y2}`);
    }
  }

  /** Draw the ghost under the cursor, green if the action would succeed. */
  private preview() {
    const g = this.world.ghost;
    g.clear();
    const at = this.hover;
    if (!at) return;
    const t = this.tool;
    const box = (x: number, y: number, w: number, h: number, ok: boolean, ht = 0.12) => {
      const m = new THREE.Mesh(Tools.unit, ok ? this.ghostOk : this.ghostBad);
      m.scale.set(w - 0.06, ht, h - 0.06);
      m.position.set(x + w / 2, ht / 2 + 0.02, y + h / 2);
      g.add(m);
    };
    if (t.kind === 'ride') {
      const type = this.game.content.rideTypes[t.type];
      const [w, h] = rotatedSize(type.size[0], type.size[1], t.rot);
      const ox = at[0] - Math.floor((w - 1) / 2), oy = at[1] - Math.floor((h - 1) / 2);
      const ok = this.game.park.query('ride.build', { type: t.type, x: ox, y: oy, rot: t.rot }).ok;
      box(ox, oy, w, h, ok, 0.5);
      const [ex, ey] = entranceFor(ox, oy, w, h, t.rot);
      box(ex, ey, 1, 1, ok, 0.08);
      return;
    }
    if (t.kind === 'path' || t.kind === 'scenery' || t.kind === 'bulldoze') {
      const [x, y, x2, y2] = this.dragFrom ? this.line(this.dragFrom, at) : [at[0], at[1], at[0], at[1]];
      const type = t.kind === 'path' ? 'path.place' : t.kind === 'scenery' ? 'scenery.place' : 'path.remove';
      const params: Record<string, unknown> = { x, y, x2, y2, queue: t.kind === 'path' && t.queue, kind: t.kind === 'scenery' ? t.scenery : undefined };
      const ok = t.kind === 'bulldoze' ? true : t.kind === 'scenery' ? !!sceneryByName(t.scenery) && this.game.park.query(type, params).ok : this.game.park.query(type, params).ok;
      box(Math.min(x, x2), Math.min(y, y2), Math.abs(x2 - x) + 1, Math.abs(y2 - y) + 1, ok && t.kind !== 'bulldoze', 0.1);
      return;
    }
    if (t.kind === 'bin') box(at[0], at[1], 1, 1, this.game.park.query('bin.place', { x: at[0], y: at[1] }).ok, 0.2);
    if (t.kind === 'coaster' && !this.building()) {
      const ok = this.game.park.query('coaster.start', { x: at[0], y: at[1], dir: t.dir }).ok;
      const dx = [0, 1, 0, -1][t.dir], dy = [-1, 0, 1, 0][t.dir];
      for (let i = 0; i < 3; i++) box(at[0] + dx * i, at[1] + dy * i, 1, 1, ok, 0.15);
      const [ex, ey] = stationEntrance(at[0], at[1], t.dir);
      box(ex, ey, 1, 1, ok, 0.06);
    }
    if (t.kind === 'select') box(at[0], at[1], 1, 1, true, 0.03);
  }
}
