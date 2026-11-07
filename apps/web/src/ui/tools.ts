import * as THREE from 'three';
import { rotatedSize, entranceFor, sceneryByName, type Dir } from '@parkwright/sim';
import type { Game } from '../game.ts';
import type { World } from '../render/world.ts';
import { mat } from '../render/models.ts';
import { toast } from './dom.ts';

export type Tool =
  | { kind: 'select' }
  | { kind: 'path'; queue: boolean }
  | { kind: 'ride'; type: string; rot: Dir }
  | { kind: 'scenery'; scenery: string }
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
    const ndc = (e: PointerEvent) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    let panning: { x: number; y: number } | null = null;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 || e.button === 1) { panning = { x: e.clientX, y: e.clientY }; return; }
      const t = world.pickTile(ndc(e));
      if (!t) return;
      if (this.tool.kind === 'path' || this.tool.kind === 'scenery' || this.tool.kind === 'bulldoze') this.dragFrom = t;
      else this.click(t);
    });
    addEventListener('pointerup', (e) => {
      if (panning) { panning = null; return; }
      if (!this.dragFrom) return;
      const t = world.pickTile(ndc(e)) ?? this.hover ?? this.dragFrom;
      this.drag(this.dragFrom, t);
      this.dragFrom = null;
      this.preview();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (panning) {
        const k = (world.zoom * 2) / innerHeight;
        world.pan(-(e.clientX - panning.x) * k, -(e.clientY - panning.y) * k * 1.4);
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
    if (t.kind === 'select') box(at[0], at[1], 1, 1, true, 0.03);
  }
}
