import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DX, DY, SUB, Tile, queueChain, type ParkState, type Ride } from '@parkwright/sim';
import type { Content } from '@parkwright/content';
import { buildModel, buildScenery, mat, type Animator } from './models.ts';
import { loadModel, loadProps } from './assets.ts';
import { buildCoaster } from './coaster.ts';
import { Crowd } from './people.ts';
import { PropSet } from './props.ts';

/** Tile (x,y) centre in world space. 1 tile = 1 unit. */
export const tileCenter = (x: number, y: number) => new THREE.Vector3(x + 0.5, 0, y + 0.5);

const colours = (list: string[]) => list.map((c) => new THREE.Color(c));
const SHIRTS = colours(['#e85d5d', '#f2b84b', '#5fb6e8', '#7ccf7a', '#b07ae8', '#f08fc0', '#ffffff', '#3d5a80', '#ee964b']);
const TROUSERS = colours(['#3b4a6b', '#2f3440', '#6b5a45', '#4f6d8f', '#c9b48a', '#57534e', '#7a3b3b']);
const SKIN = colours(['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac']);
const HAIR = colours(['#2b2018', '#4a3020', '#7a5230', '#c9a060', '#1c1c1c', '#8a3a20', '#9a9a9a']);
const ROLE = { handyman: '#2f7d4f', mechanic: '#d06a1f', guard: '#2b3f7a', entertainer: '#e04fa0' } as const;
const STAFF_TROUSERS = new THREE.Color('#2b2f38');

const accents = new Map<string, THREE.Material>();
function accent(base: THREE.Material, color: string) {
  const key = base.name + color;
  let m = accents.get(key);
  if (!m) {
    m = base.clone();
    (m as THREE.MeshStandardMaterial).color.set(color);
    accents.set(key, m);
  }
  return m;
}

/** A well-mixed hash of a tile, for picking variants and placing furniture. */
function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
const MAX_PEOPLE = 4000;
const MAX_STAFF = 200;

/** Free the GPU buffers of a model we're throwing away (materials are shared and cached). */
function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    // Instanced meshes also own GPU buffers for their matrices/colours.
    if ((x as THREE.InstancedMesh).isInstancedMesh) (x as THREE.InstancedMesh).dispose();
  });
}

interface RideView { ride: Ride; group: THREE.Group; animate: Animator; key: string; coaster?: (ride: Ride, alpha: number) => void }

export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly ground: THREE.Mesh;
  private pathMesh: THREE.InstancedMesh;
  private queueMesh: THREE.InstancedMesh;
  private litterMesh: THREE.InstancedMesh;
  private crowd: Crowd;
  private staff: Crowd;
  private rides = new Map<number, RideView>();
  /** Prop templates by name: procedural stand-ins until scenery.glb loads. */
  private templates = new Map<string, THREE.Object3D>();
  private props = new Map<string, PropSet>();
  private gate: THREE.Object3D;
  private furnitureVersion = -1;
  private mapVersion = -1;
  private sceneryKey = '';
  readonly ghost = new THREE.Group();
  /** Camera orbit state. */
  target = new THREE.Vector3();
  yaw = Math.PI / 4;
  zoom = 14;
  private yawTo = Math.PI / 4;

  private get c(): Content { return this.content(); }

  constructor(canvas: HTMLCanvasElement, private s: () => ParkState, private content: () => Content) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.background = new THREE.Color('#bfe3f0');
    this.scene.fog = new THREE.Fog('#bfe3f0', 60, 140);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);

    // A soft studio environment (generated once, no download) so metal and gloss have something to reflect.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();
    const hemi = new THREE.HemisphereLight('#fff6e0', '#6a8a5a', 0.65);
    const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
    sun.position.set(-30, 50, -20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.02;
    this.scene.add(hemi, sun, sun.target);
    this.sun = sun;

    const st = s();
    const g = new THREE.PlaneGeometry(st.w, st.h, st.w, st.h);
    g.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(g, this.grassMaterial(st.w, st.h));
    this.ground.position.set(st.w / 2, 0, st.h / 2);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(st.w + 0.4, 1.2, st.h + 0.4), mat('#7a5a3a'));
    skirt.position.set(st.w / 2, -0.61, st.h / 2);
    this.scene.add(skirt);
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), mat('#9cc98a'));
    outside.position.set(st.w / 2, -1.2, st.h / 2);
    this.scene.add(outside);

    const tileGeo = new THREE.BoxGeometry(1, 0.06, 1);
    const n = st.w * st.h;
    const paving = this.pavingTexture();
    this.pathMesh = new THREE.InstancedMesh(tileGeo, new THREE.MeshStandardMaterial({ color: '#d8c9a8', map: paving, roughness: 0.9 }), n);
    this.queueMesh = new THREE.InstancedMesh(tileGeo, new THREE.MeshStandardMaterial({ color: '#9fb6cf', map: paving, roughness: 0.85 }), n);
    for (const m of [this.pathMesh, this.queueMesh]) { m.receiveShadow = true; m.count = 0; this.scene.add(m); }
    this.litterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.02, 0.05), mat('#f4f0e6'), n * 3);
    this.litterMesh.count = 0;
    this.scene.add(this.litterMesh);

    this.crowd = new Crowd(MAX_PEOPLE, this.scene);
    this.staff = new Crowd(MAX_STAFF, this.scene, 1.08);

    this.fallbackProps();
    this.gate = this.buildGate();
    this.scene.add(this.gate);
    // Swap in the Blender-built props (trees, benches, lamps, bins, fences, gate) when they arrive.
    loadProps().then((props) => {
      if (!props.size) return;
      for (const [name, o] of props) this.templates.set(name, o);
      for (const p of this.props.values()) p.dispose();
      this.props.clear();
      this.scene.remove(this.gate);
      this.gate = this.buildGate();
      this.scene.add(this.gate);
      this.sceneryKey = '';
      this.furnitureVersion = -1;
      this.mapVersion = -1;
    });
    this.scene.add(this.ghost);
    this.target.copy(tileCenter(st.gate[0], st.gate[1] - 10));
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private sun: THREE.DirectionalLight;

  private grassMaterial(w: number, h: number) {
    // The tile checker stays (it reads as a grid), with mown stripes and a scatter of darker and lighter tufts.
    const px = 16;
    const cv = document.createElement('canvas');
    cv.width = w * px; cv.height = h * px;
    const ctx = cv.getContext('2d')!;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = hash(x, y);
      const v = r & 7;
      ctx.fillStyle = (x + y) % 2 ? `hsl(100 38% ${52 + v * 0.6}%)` : `hsl(98 40% ${50 + v * 0.6}%)`;
      ctx.fillRect(x * px, y * px, px, px);
      ctx.fillStyle = 'rgba(255,255,240,0.035)';
      ctx.fillRect(x * px, y * px, px / 2, px);
      for (let i = 0; i < 7; i++) {
        const t = hash(r + i, i * 31 + y);
        ctx.fillStyle = t & 1 ? 'rgba(40,70,20,0.13)' : 'rgba(235,245,190,0.12)';
        ctx.fillRect(x * px + (t >>> 4) % (px - 2), y * px + (t >>> 9) % (px - 2), 2, 2);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
  }

  /** Near-white flagstones (the material colour tints them): four slabs a tile, mortar lines, worn edges. */
  private pavingTexture() {
    const s = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#c9c2b4';
    ctx.fillRect(0, 0, s, s);
    const slabs: [number, number, number, number][] = [[0, 0, 36, 28], [36, 0, 28, 28], [0, 28, 24, 36], [24, 28, 40, 36]];
    slabs.forEach(([x, y, w, h], i) => {
      ctx.fillStyle = `hsl(40 18% ${93 - i * 2.5}%)`;
      ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
      for (let k = 0; k < 18; k++) {
        const t = hash(i * 97 + k, k * 13);
        ctx.fillStyle = t & 1 ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 2 + (t >>> 3) % (w - 5), y + 2 + (t >>> 8) % (h - 5), 2, 2);
      }
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  /** Procedural stand-ins for the props, used until (or if) scenery.glb loads. */
  private fallbackProps() {
    for (const [name, id] of [['oak_a', 1], ['oak_b', 1], ['pine_a', 5], ['pine_b', 5], ['flower', 2], ['fountain', 3], ['hedge', 4]] as const) {
      const g = buildScenery(id);
      g.scale.setScalar(1);
      this.templates.set(name, g);
    }
    const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.22, 8), mat('#3e6e4a'));
    bin.position.y = 0.11;
    this.templates.set('bin', new THREE.Group().add(bin));
  }

  private propSet(name: string): PropSet | null {
    let p = this.props.get(name);
    if (!p) {
      const t = this.templates.get(name);
      if (!t) return null;
      // Fences ring the whole park: plenty of them and their shadows add little.
      p = new PropSet(t, name !== 'fence');
      this.scene.add(p.group);
      this.props.set(name, p);
    }
    return p;
  }

  private buildGate() {
    const st = this.s();
    const p = tileCenter(st.gate[0], st.gate[1]);
    const glb = this.templates.get('gate');
    if (glb) {
      const g = glb.clone();
      g.position.copy(p);
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true; });
      return g;
    }
    const g = new THREE.Group();
    for (const sx of [-0.55, 0.55]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.4, 0.18), mat('#c0533a'));
      post.position.set(sx, 0.7, 0);
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.28, 0.24), mat('#f2b84b'));
    beam.position.y = 1.45;
    beam.castShadow = true;
    g.add(beam);
    g.position.copy(p);
    return g;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    const a = w / h;
    this.camera.left = -this.zoom * a; this.camera.right = this.zoom * a;
    this.camera.top = this.zoom; this.camera.bottom = -this.zoom;
    this.camera.updateProjectionMatrix();
  }

  rotate(step: number) { this.yawTo += step * (Math.PI / 2); }
  setZoom(z: number) { this.zoom = Math.max(4, Math.min(40, z)); this.resize(); }
  focus(x: number, y: number) { this.focusTo = tileCenter(x, y); }
  private focusTo: THREE.Vector3 | null = null;

  pan(dx: number, dz: number) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.target.x += dx * c - dz * s;
    this.target.z += dx * s + dz * c;
    const st = this.s();
    this.target.x = Math.max(0, Math.min(st.w, this.target.x));
    this.target.z = Math.max(0, Math.min(st.h, this.target.z));
    this.focusTo = null;
  }

  private placeCamera() {
    this.yaw += (this.yawTo - this.yaw) * 0.18;
    if (this.focusTo) {
      this.target.lerp(this.focusTo, 0.12);
      if (this.target.distanceTo(this.focusTo) < 0.05) this.focusTo = null;
    }
    const d = 60;
    this.camera.position.set(this.target.x - Math.sin(this.yaw) * d * 0.7, d * 0.72, this.target.z + Math.cos(this.yaw) * d * 0.7);
    this.camera.lookAt(this.target);
    this.placeSun();
  }

  private shadowExtent = 0;
  private sunRot = new THREE.Matrix4().lookAt(new THREE.Vector3(-30, 50, -20), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  private sunInv = this.sunRot.clone().transpose();
  private sunAt = new THREE.Vector3();

  /** Fit the shadow map to what the camera shows, and move it in whole texels so shadows don't crawl when panning. */
  private placeSun() {
    const sc = this.sun.shadow.camera;
    const ext = Math.round(Math.min(48, Math.max(10, this.zoom * 2.6)));
    if (ext !== this.shadowExtent) {
      this.shadowExtent = ext;
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.updateProjectionMatrix();
    }
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    const p = this.sunAt.copy(this.target).applyMatrix4(this.sunInv);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(this.sunRot);
    this.sun.position.set(p.x - 30, p.y + 50, p.z - 20);
    this.sun.target.position.copy(p);
  }

  /** Pick the ground tile under a screen point. */
  pickTile(ndc: THREE.Vector2): [number, number] | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.ground)[0];
    if (!hit) return null;
    const st = this.s();
    const x = Math.floor(hit.point.x), y = Math.floor(hit.point.z);
    return x >= 0 && y >= 0 && x < st.w && y < st.h ? [x, y] : null;
  }

  private syncTiles(st: ParkState) {
    const m = new THREE.Matrix4();
    const c = this.tmp.c;
    const bins: THREE.Matrix4[] = [];
    let np = 0, nq = 0;
    for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
      const k = y * st.w + x;
      const t = st.tiles[k];
      // Each slab is turned a quarter at random and a shade lighter or darker, so paths don't look stamped.
      const r = hash(x, y);
      if (t === Tile.Path || t === Tile.Queue) {
        m.makeRotationY((r & 3) * (Math.PI / 2)).setPosition(x + 0.5, t === Tile.Path ? 0.03 : 0.035, y + 0.5);
        c.setScalar(0.94 + ((r >>> 4) & 15) / 150);
        const im = t === Tile.Path ? this.pathMesh : this.queueMesh;
        const i = t === Tile.Path ? np++ : nq++;
        im.setMatrixAt(i, m);
        im.setColorAt(i, c);
      }
      if (st.bins[k]) bins.push(PropSet.at(x + 0.82, y + 0.82));
    }
    this.pathMesh.count = np; this.queueMesh.count = nq;
    for (const im of [this.pathMesh, this.queueMesh]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
    }
    this.propSet('bin')?.set(bins);
  }

  /** Lamps and benches along the path edges, and the fence round the park. Decoration only: the sim never sees them. */
  private syncFurniture(st: ParkState) {
    const lamps: THREE.Matrix4[] = [], benches: THREE.Matrix4[] = [], fences: THREE.Matrix4[] = [];
    const entrances = new Set(st.rides.map((r) => r.ey * st.w + r.ex));
    const open = (x: number, y: number) => x >= 0 && y >= 0 && x < st.w && y < st.h && st.tiles[y * st.w + x] === Tile.Grass && !st.occ[y * st.w + x];
    for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
      const k = y * st.w + x;
      if (st.tiles[k] !== Tile.Path || st.bins[k] || entrances.has(k) || (x === st.gate[0] && y === st.gate[1])) continue;
      const r = hash(x, y);
      const lamp = r % 9 === 0, bench = r % 11 === 4;
      if (!lamp && !bench) continue;
      for (let i = 0; i < 4; i++) {
        const d = (i + (r >>> 8)) & 3;
        if (!open(x + DX[d], y + DY[d])) continue;
        const cx = x + 0.5, cz = y + 0.5;
        if (lamp) lamps.push(PropSet.at(cx + DX[d] * 0.44 - DY[d] * 0.36, cz + DY[d] * 0.44 + DX[d] * 0.36));
        else benches.push(PropSet.at(cx + DX[d] * 0.36, cz + DY[d] * 0.36, Math.atan2(-DX[d], -DY[d])));
        break;
      }
    }
    for (let x = 0; x < st.w; x++) {
      fences.push(PropSet.at(x + 0.5, 0));
      if (x !== st.gate[0]) fences.push(PropSet.at(x + 0.5, st.h, Math.PI));
    }
    for (let y = 0; y < st.h; y++) {
      fences.push(PropSet.at(0, y + 0.5, Math.PI / 2));
      fences.push(PropSet.at(st.w, y + 0.5, -Math.PI / 2));
    }
    this.propSet('lamp')?.set(lamps);
    this.propSet('bench')?.set(benches);
    this.propSet('fence')?.set(fences);
  }

  private syncRides(st: ParkState) {
    const seen = new Set<number>();
    for (const r of st.rides) {
      seen.add(r.id);
      const key = `${r.type},${r.x},${r.y},${r.rot},${r.track?.length ?? 0},${r.trackRev ?? 0}`;
      const have = this.rides.get(r.id);
      if (have && have.key === key) { have.ride = r; continue; }
      if (have) { this.scene.remove(have.group); disposeTree(have.group); }
      const t = this.c.rideTypes[r.type];
      if (r.track) {
        // Coasters are generated from the sim's own track path.
        const cv = buildCoaster(r);
        const root = new THREE.Group();
        root.userData.rideId = r.id;
        root.add(cv.group);
        const entr = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.8), mat('#c76a4a'));
        entr.position.set(r.ex + 0.5, 0.03, r.ey + 0.5);
        root.add(entr);
        this.scene.add(root);
        this.rides.set(r.id, { ride: r, group: root, animate: () => {}, coaster: cv.animate, key });
        continue;
      }
      const { group, animate } = buildModel(t.model, t.color, r.w, r.h);
      const root = new THREE.Group();
      const holder = new THREE.Group();
      holder.add(group);
      holder.position.set(r.x + r.w / 2, 0, r.y + r.h / 2);
      // Stalls and buildings face their entrance; round rides look the same from every side.
      if (t.kind !== 'flat' || t.model === 'spookwalk') holder.rotation.y = [Math.PI, Math.PI / 2, 0, -Math.PI / 2][r.rot];
      root.userData.rideId = r.id;
      root.add(holder);
      if (t.kind === 'flat') {
        const entr = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.8), mat('#c76a4a'));
        entr.position.set(r.ex + 0.5, 0.03, r.ey + 0.5);
        entr.receiveShadow = true;
        root.add(entr);
      }
      this.scene.add(root);
      const view: RideView = { ride: r, group: root, animate, key };
      this.rides.set(r.id, view);
      // Swap in a Blender-built model when one exists.
      loadModel(t.model).then((glb) => {
        if (!glb || this.rides.get(r.id) !== view) return;
        holder.remove(group);
        disposeTree(group);
        // Models are authored wide along x; a ride rotated to a tall footprint turns its model to match.
        if (t.model === 'wheel' && r.w < r.h) glb.rotation.y = Math.PI / 2;
        // Parts painted "accent" in Blender take this ride's colour (each stall's awning and sign).
        glb.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && !Array.isArray(m.material) && m.material.name.startsWith('pw_accent')) m.material = accent(m.material, t.color);
        });
        holder.add(glb);
        view.animate = (tt, run) => glb.userData.animate?.(tt, run);
      });
    }
    for (const [id, v] of this.rides) if (!seen.has(id)) { this.scene.remove(v.group); disposeTree(v.group); this.rides.delete(id); }
  }

  private syncScenery(st: ParkState) {
    let key = '';
    for (let k = 0; k < st.scenery.length; k++) if (st.scenery[k]) key += k + ':' + st.scenery[k] + ',';
    if (key === this.sceneryKey) return;
    this.sceneryKey = key;
    const lists = new Map<string, THREE.Matrix4[]>();
    for (const name of ['oak_a', 'oak_b', 'pine_a', 'pine_b', 'flower', 'fountain', 'hedge']) lists.set(name, []);
    for (let k = 0; k < st.scenery.length; k++) {
      const id = st.scenery[k];
      if (!id) continue;
      const x = k % st.w, y = Math.floor(k / st.w), r = hash(x, y);
      const tree = id === 1 || id === 5;
      const name = id === 1 ? (r & 1 ? 'oak_b' : 'oak_a') : id === 5 ? (r & 1 ? 'pine_b' : 'pine_a') : id === 2 ? 'flower' : id === 3 ? 'fountain' : 'hedge';
      // Trees turn and vary in size; beds, fountains and hedges stay square to the grid.
      const yaw = tree ? (k * 1.7) % (Math.PI * 2) : ((r >>> 3) & 3) * (Math.PI / 2);
      const s = tree ? 0.85 + ((r >>> 5) % 31) / 100 : 1;
      lists.get(name)!.push(PropSet.at(x + 0.5, y + 0.5, yaw, s));
    }
    for (const [name, list] of lists) this.propSet(name)?.set(list);
  }

  private tmp = { m: new THREE.Matrix4(), h: new THREE.Matrix4(), q: new THREE.Quaternion(), sc: new THREE.Vector3(1, 1, 1), p: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), c: new THREE.Color() };
  private chains = new Map<number, [number, number][]>();
  private chainsVersion = -1;

  private syncPeople(st: ParkState, alpha: number) {
    const { p } = this.tmp;
    if (this.chainsVersion !== st.mapVersion) { this.chains.clear(); this.chainsVersion = st.mapVersion; }
    const queueSlots = this.chains;
    const queuePos = new Map<number, [number, number, number]>();
    for (const r of st.rides) {
      if (!r.queue.length) continue;
      let chain = queueSlots.get(r.id);
      if (!chain) { chain = queueChain(st, r); queueSlots.set(r.id, chain); }
      r.queue.forEach((vid, i) => {
        const tile = chain![Math.floor(i / 8)] ?? [r.ex, r.ey];
        const slot = i % 8;
        queuePos.set(vid, [tile[0] + 0.2 + (slot % 4) * 0.2, tile[1] + 0.3 + Math.floor(slot / 4) * 0.4, 0]);
      });
    }
    const crowd = this.crowd;
    crowd.begin();
    for (const v of st.visitors) {
      if (v.mode === 'riding' || v.mode === 'gone') continue;
      const qp = queuePos.get(v.id);
      if (v.mode === 'queuing' && qp) p.set(qp[0], 0, qp[1]);
      else {
        const f = Math.min(1, (v.p + alpha * 2) / SUB);
        const lane = ((v.id * 37) % 7) / 7 - 0.43;
        const ox = v.ny !== v.ty ? lane * 0.5 : 0, oz = v.nx !== v.tx ? lane * 0.5 : 0;
        p.set(v.tx + (v.nx - v.tx) * f + 0.5 + ox, 0, v.ty + (v.ny - v.ty) * f + 0.5 + oz);
      }
      const walking = v.mode !== 'queuing';
      const step = (v.p + alpha * 2 + v.id) * 0.4;
      p.y = walking ? Math.abs(Math.sin(step)) * 0.018 : 0;
      const id = v.id;
      crowd.add(p, Math.atan2(DX[v.dir], DY[v.dir]), walking ? Math.sin(step) * 0.5 : 0,
        SHIRTS[id % SHIRTS.length], TROUSERS[(id * 5) % TROUSERS.length], SKIN[(id * 7) % SKIN.length], HAIR[(id * 3) % HAIR.length]);
    }
    crowd.end();
    const staff = this.staff;
    staff.begin();
    for (const s of st.staff) {
      const f = Math.min(1, s.p / SUB);
      const dx = s.nx - s.tx, dy = s.ny - s.ty, moving = dx !== 0 || dy !== 0;
      p.set(s.tx + dx * f + 0.5, 0, s.ty + dy * f + 0.5);
      const step = (s.p + alpha * 2 + s.id) * 0.4;
      staff.add(p, moving ? Math.atan2(dx, dy) : 0, moving ? Math.sin(step) * 0.5 : 0,
        this.tmp.c.set(ROLE[s.role]), STAFF_TROUSERS, SKIN[(s.id * 7) % SKIN.length], HAIR[(s.id * 3) % HAIR.length]);
    }
    staff.end();
  }

  private syncLitter(st: ParkState) {
    const m = new THREE.Matrix4();
    let n = 0;
    for (let k = 0; k < st.litter.length; k++) {
      const c = Math.min(3, st.litter[k]);
      for (let i = 0; i < c; i++) {
        const x = (k % st.w) + 0.2 + ((k * 13 + i * 31) % 60) / 100, y = Math.floor(k / st.w) + 0.2 + ((k * 7 + i * 17) % 60) / 100;
        m.makeRotationY(k + i).setPosition(x, 0.07, y);
        this.litterMesh.setMatrixAt(n++, m);
      }
    }
    this.litterMesh.count = n;
    this.litterMesh.instanceMatrix.needsUpdate = true;
    this.litterMesh.computeBoundingSphere();
  }

  /** alpha: fraction of the way to the next sim tick, for smooth walking. */
  render(time: number, alpha: number) {
    const st = this.s();
    if (st.mapVersion !== this.mapVersion || (st.tick & 15) === 0) { this.syncTiles(st); this.mapVersion = st.mapVersion; }
    if (st.mapVersion !== this.furnitureVersion) { this.syncFurniture(st); this.furnitureVersion = st.mapVersion; }
    this.syncRides(st);
    this.syncScenery(st);
    this.syncPeople(st, alpha);
    if ((st.tick & 31) === 0) this.syncLitter(st);
    for (const v of this.rides.values()) {
      const kind = this.c.rideTypes[v.ride.type].kind;
      const running = v.ride.status === 'open' && (kind === 'flat' || kind === 'track' ? v.ride.cycle > 0 : true);
      if (v.coaster) v.coaster(v.ride, alpha);
      else v.animate(time, running);
      // A broken ride shudders.
      v.group.rotation.z = v.ride.status === 'broken' ? Math.sin(time * 20) * 0.01 : 0;
    }
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  rideAt(x: number, y: number): number {
    const st = this.s();
    return st.occ[y * st.w + x] ?? 0;
  }
}
