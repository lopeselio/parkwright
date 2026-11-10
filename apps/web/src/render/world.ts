import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DX, DY, SUB, TICKS_PER_DAY, Tile, queueChain, type ParkState, type Ride } from '@parkwright/sim';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Content } from '@parkwright/content';
import { buildModel, buildScenery, mat, type Animator } from './models.ts';
import { glows, loadModel, loadProps } from './assets.ts';
import { buildCoaster, CAR_COLOURS } from './coaster.ts';
import { Crowd } from './people.ts';
import { PropSet } from './props.ts';

/** Tile (x,y) centre in world space. 1 tile = 1 unit. */
export const tileCenter = (x: number, y: number) => new THREE.Vector3(x + 0.5, 0, y + 0.5);

const colours = (list: string[]) => list.map((c) => new THREE.Color(c));
const SHIRTS = colours(['#e85d5d', '#f2b84b', '#5fb6e8', '#7ccf7a', '#b07ae8', '#f08fc0', '#ffffff', '#3d5a80', '#ee964b']);
const TROUSERS = colours(['#3b4a6b', '#2f3440', '#6b5a45', '#4f6d8f', '#c9b48a', '#57534e', '#7a3b3b']);
const SKIN = colours(['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac']);
const HAIR = colours(['#2b2018', '#4a3020', '#7a5230', '#c9a060', '#1c1c1c', '#8a3a20', '#9a9a9a']);
const ROLE: Record<string, THREE.Color> = { handyman: new THREE.Color('#2f7d4f'), mechanic: new THREE.Color('#d06a1f'), guard: new THREE.Color('#2b3f7a'), entertainer: new THREE.Color('#e04fa0') };
/** Phones and small windows: smaller shadow map, and people don't cast shadows. */
const SMALL_SCREEN = typeof matchMedia === 'function' && matchMedia('(max-width: 760px), (pointer: coarse)').matches;
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
/** Scenery kind (sim id) → the prop names that can stand for it. Oaks mix in round, birch and blossom trees. */
const VARIANTS: Record<number, string[]> = {
  1: ['oak_a', 'oak_b', 'oak_c', 'oak_a', 'oak_d', 'oak_b', 'oak_e'],
  2: ['flower', 'flower_b', 'flower_c'],
  3: ['fountain'],
  4: ['hedge', 'hedge', 'hedge_b'],
  5: ['pine_a', 'pine_b', 'pine_c', 'pine_a'],
};
/** A queue-line rail along one tile edge: two posts and a bar, centred on the edge, 1 unit long along x. */
function railGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-0.45, 0.45]) parts.push(new THREE.CylinderGeometry(0.02, 0.022, 0.26, 6).translate(x, 0.13, 0));
  parts.push(new THREE.CylinderGeometry(0.013, 0.013, 0.94, 5).rotateZ(Math.PI / 2).translate(0, 0.24, 0));
  parts.push(new THREE.CylinderGeometry(0.01, 0.01, 0.94, 5).rotateZ(Math.PI / 2).translate(0, 0.13, 0));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

let glowTex: THREE.Texture | null = null;
/** A soft round spot, white in the middle: lamp light on the ground. */
function glowTexture() {
  if (glowTex) return glowTex;
  const s = 64, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Light through the day, as [phase, sun colour, sun strength, sky, ground bounce, bounce strength, backdrop, night]. */
const DAY: [number, string, number, string, string, number, string, number][] = [
  [0.0, '#ffc49a', 1.2, '#9fb0e0', '#5d6b52', 0.6, '#b8c3e2', 0.6],
  [0.07, '#ffe2bf', 2.1, '#dbe9fb', '#7d8f58', 0.8, '#c2e1ef', 0.0],
  [0.16, '#fff1d6', 2.4, '#e6f2ff', '#7d8f58', 0.8, '#bfe3f0', 0.0],
  [0.7, '#fff1d6', 2.4, '#e6f2ff', '#7d8f58', 0.8, '#bfe3f0', 0.0],
  [0.82, '#ffd59a', 2.1, '#f3e2cf', '#8a8350', 0.8, '#f0d9bd', 0.15],
  [0.93, '#ff9472', 0.85, '#7f8fd0', '#4f5a4a', 0.55, '#9c9cc8', 0.9],
  [1.0, '#ffc49a', 1.2, '#9fb0e0', '#5d6b52', 0.6, '#b8c3e2', 0.6],
];

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
  ground!: THREE.Mesh;
  private pathMesh!: THREE.InstancedMesh;
  private queueMesh!: THREE.InstancedMesh;
  private litterMesh!: THREE.InstancedMesh;
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
    this.scene.fog = new THREE.Fog('#bfe3f0', 70, 160);
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);

    // A soft studio environment (generated once, no download) so metal and gloss have something to reflect.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    this.scene.environmentIntensity = 0.4;
    pmrem.dispose();
    // Sky and bounce light; the sun casts soft shadows. Both are re-tinted through the day (see daylight()).
    const hemi = new THREE.HemisphereLight('#e6f2ff', '#7d8f58', 0.8);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight('#fff1d6', 2.3);
    sun.position.set(-30, 50, -20);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(SMALL_SCREEN ? 1024 : 2048);
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    this.scene.add(hemi, sun, sun.target);
    this.sun = sun;

    const st = s();
    this.buildGround(st);

    this.crowd = new Crowd(MAX_PEOPLE, this.scene, 1.1, !SMALL_SCREEN);
    this.staff = new Crowd(MAX_STAFF, this.scene, 1.18, !SMALL_SCREEN);
    this.scene.add(this.selection);

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
      this.outsideKey = '';
      // Entrances and coaster cars come from scenery.glb too: rebuild the rides that used stand-ins.
      for (const v of this.rides.values()) v.key = '';
    });
    this.scene.add(this.ghost);
    this.target.copy(tileCenter(st.gate[0], st.gate[1] - 10));
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  /** 0 by day, up to 1 at dusk: lamps glow and pool light on the paths. */
  night = 0;
  /** Pin the light to a time of day (0–1, e.g. 0.93 for dusk) instead of the park's clock; for screenshots and checks. */
  timeOfDay: number | null = null;
  /** Which ride to outline (the inspect panel's), read every frame. */
  selected: () => number | null = () => null;
  private selection = new THREE.Group();
  private selectionKey = '';
  private outsideKey = '';
  private outside: PropSet[] = [];
  private groundParts: THREE.Object3D[] = [];
  private groundSize = '';
  private lastState: ParkState | null = null;
  private lastTileTick = -1;

  /** Ground, edges and the per-tile meshes, sized for this park (rebuilt when a park of another size loads). */
  private buildGround(st: ParkState) {
    for (const o of this.groundParts) {
      this.scene.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m === this.ground) (m.material as THREE.Material).dispose();
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    }
    const g = new THREE.PlaneGeometry(st.w, st.h, st.w, st.h);
    g.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(g, this.grassMaterial(st.w, st.h));
    this.ground.position.set(st.w / 2, 0, st.h / 2);
    this.ground.receiveShadow = true;
    // The park is a raised diorama board: a turf lip over layered earth, on a meadow.
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(st.w + 0.4, 1.2, st.h + 0.4), [mat('#8a6440'), mat('#8a6440'), mat('#6fa452'), mat('#8a6440'), mat('#8a6440'), mat('#8a6440')]);
    skirt.position.set(st.w / 2, -0.61, st.h / 2);
    skirt.receiveShadow = true;
    const lip = new THREE.Mesh(new THREE.BoxGeometry(st.w + 0.44, 0.12, st.h + 0.44), mat('#6fa452'));
    lip.position.set(st.w / 2, -0.07, st.h / 2);
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), mat('#8dbd78'));
    outside.receiveShadow = true;
    outside.position.set(st.w / 2, -1.2, st.h / 2);
    const tileGeo = new THREE.BoxGeometry(1, 0.06, 1);
    const n = st.w * st.h;
    this.paving ??= this.pavingTexture();
    this.pathMesh = new THREE.InstancedMesh(tileGeo, this.pathMat ??= new THREE.MeshStandardMaterial({ color: '#d8c9a8', map: this.paving, roughness: 0.9 }), n);
    this.queueMesh = new THREE.InstancedMesh(tileGeo, this.queueMat ??= new THREE.MeshStandardMaterial({ color: '#9fb6cf', map: this.paving, roughness: 0.85 }), n);
    for (const m of [this.pathMesh, this.queueMesh]) { m.receiveShadow = true; m.count = 0; }
    this.litterMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.02, 0.05), mat('#f4f0e6'), n * 3);
    this.litterMesh.count = 0;
    // Kerbs where a path meets grass, and rails along the sides of queue lines.
    this.kerbMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 0.07), mat('#cfc6b4', { flatShading: false, roughness: 0.9 }), n * 4);
    this.railMesh = new THREE.InstancedMesh(railGeometry(), mat('#5b6b7a', { flatShading: false, metalness: 0.5, roughness: 0.45 }), n * 4);
    for (const m of [this.kerbMesh, this.railMesh]) { m.receiveShadow = true; m.castShadow = !SMALL_SCREEN; m.count = 0; }
    // Pools of lamplight on the paths at dusk (additive, no lights: cheap at any count).
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.8, 1.8).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glowTexture(), color: '#ffcf80', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), Math.max(64, n >> 2));
    this.pools.count = 0;
    this.pools.renderOrder = 2;
    this.groundParts = [this.ground, skirt, lip, outside, this.pathMesh, this.queueMesh, this.litterMesh, this.kerbMesh, this.railMesh, this.pools];
    this.scene.add(...this.groundParts);
    this.groundSize = `${st.w}x${st.h}`;
  }
  private kerbMesh!: THREE.InstancedMesh;
  private railMesh!: THREE.InstancedMesh;
  private pools!: THREE.InstancedMesh;
  private paving: THREE.Texture | undefined;
  private pathMat: THREE.Material | undefined;
  private queueMat: THREE.Material | undefined;

  /** A different park was loaded (new game, visit, home): resize the ground if needed and rebuild everything keyed on the map. */
  private onNewPark(st: ParkState) {
    if (`${st.w}x${st.h}` !== this.groundSize) this.buildGround(st);
    if (this.gate) { this.scene.remove(this.gate); this.gate = this.buildGate(); this.scene.add(this.gate); }
    this.mapVersion = -1;
    this.furnitureVersion = -1;
    this.sceneryKey = '';
    this.lastTileTick = -1;
    this.outsideKey = '';
    this.selectionKey = '';
  }

  private grassMaterial(w: number, h: number) {
    // The tile checker stays (it reads as a grid), with mown stripes and a scatter of darker and lighter tufts.
    const px = 16;
    const cv = document.createElement('canvas');
    cv.width = w * px; cv.height = h * px;
    const ctx = cv.getContext('2d')!;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = hash(x, y);
      const v = r & 7;
      // A soft checker (it reads as a grid) over broad, lighter and darker patches of meadow.
      const patch = (hash(x >> 3, y >> 3) & 15) * 0.25 + (hash((x + 4) >> 3, (y + 4) >> 3) & 15) * 0.15;
      ctx.fillStyle = (x + y) % 2 ? `hsl(${97 + (r & 3)} 40% ${48 + patch + v * 0.5}%)` : `hsl(${95 + (r & 3)} 41% ${46.6 + patch + v * 0.5}%)`;
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
      // Only big props cast shadows; benches, lamps, bins, flower beds and fences are many and small.
      p = new PropSet(t, /^(oak|pine|fountain|hedge|tree)/.test(name));
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
    let np = 0, nq = 0, nk = 0, nr = 0;
    const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < st.w && y < st.h && (st.tiles[y * st.w + x] === Tile.Path || st.tiles[y * st.w + x] === Tile.Queue);
    const entrances = new Set(st.rides.map((r) => r.ey * st.w + r.ex));
    const gate = st.gate[1] * st.w + st.gate[0];
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
        // Each open side gets a kerb (paths) or a rail (queues); never across an entrance or the gate.
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (walk(nx, ny) || entrances.has(ny * st.w + nx) || (k === gate && d === 2)) continue;
          const queue = t === Tile.Queue;
          if (queue && st.occ[ny * st.w + nx]) continue; // the ride's own side
          m.makeRotationY(DX[d] ? Math.PI / 2 : 0).setPosition(x + 0.5 + DX[d] * (queue ? 0.44 : 0.475), queue ? 0.06 : 0.04, y + 0.5 + DY[d] * (queue ? 0.44 : 0.475));
          if (queue) this.railMesh.setMatrixAt(nr++, m);
          else this.kerbMesh.setMatrixAt(nk++, m);
        }
      }
      if (st.bins[k]) bins.push(PropSet.at(x + 0.82, y + 0.82));
    }
    this.pathMesh.count = np; this.queueMesh.count = nq; this.kerbMesh.count = nk; this.railMesh.count = nr;
    for (const im of [this.pathMesh, this.queueMesh, this.kerbMesh, this.railMesh]) {
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
    const pool = new THREE.Matrix4(), at = new THREE.Vector3();
    const gp = tileCenter(st.gate[0], st.gate[1]);
    const spots = [...lamps.map((l) => at.setFromMatrixPosition(l).clone()), gp.clone().setX(gp.x - 0.4), gp.clone().setX(gp.x + 0.4)];
    this.pools.count = Math.min(spots.length, this.pools.instanceMatrix.count);
    spots.slice(0, this.pools.count).forEach((p, i) => this.pools.setMatrixAt(i, pool.makeTranslation(p.x, 0.075, p.z)));
    this.pools.instanceMatrix.needsUpdate = true;
    this.pools.computeBoundingSphere();
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
        const carModel = this.templates.get('car');
        const cv = buildCoaster(r, carModel ? (i) => this.tinted(carModel, CAR_COLOURS[i % CAR_COLOURS.length]) : undefined);
        const root = new THREE.Group();
        root.userData.rideId = r.id;
        root.add(cv.group);
        const st0 = r.track[0] ?? { x: r.x, y: r.y };
        root.add(this.entrance(r.ex, r.ey, st0.x + 0.5, st0.y + 0.5, t.color));
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
      if (t.kind === 'flat') root.add(this.entrance(r.ex, r.ey, r.x + r.w / 2, r.y + r.h / 2, t.color));
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

  /** A clone of a prop with its "accent" parts painted `color` (a ride's colour). */
  private tinted(template: THREE.Object3D, color: string) {
    const o = template.clone();
    o.position.set(0, 0, 0);
    o.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = m.receiveShadow = true;
      if (!Array.isArray(m.material) && m.material.name.startsWith('pw_accent')) m.material = accent(m.material, color);
    });
    return o;
  }

  /** A ride's entrance tile: an arch in the ride's colour facing away from the ride (cx, cz), toward the path. */
  private entrance(ex: number, ey: number, cx: number, cz: number, color: string): THREE.Object3D {
    const t = this.templates.get('entrance');
    const dx = ex + 0.5 - cx, dz = ey + 0.5 - cz;
    if (!t) {
      const entr = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.8), mat('#c76a4a'));
      entr.position.set(ex + 0.5, 0.03, ey + 0.5);
      entr.receiveShadow = true;
      return entr;
    }
    const o = this.tinted(t, color);
    o.position.set(ex + 0.5, 0, ey + 0.5);
    // The arch's front (+z) points along the larger offset, so it opens onto the path, not the ride.
    o.rotation.y = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : (dz > 0 ? 0 : Math.PI);
    return o;
  }

  private syncScenery(st: ParkState) {
    let key = '';
    for (let k = 0; k < st.scenery.length; k++) if (st.scenery[k]) key += k + ':' + st.scenery[k] + ',';
    if (key === this.sceneryKey) return;
    this.sceneryKey = key;
    const lists = new Map<string, THREE.Matrix4[]>();
    for (const list of Object.values(VARIANTS)) for (const name of list) lists.set(name, []);
    for (let k = 0; k < st.scenery.length; k++) {
      const id = st.scenery[k];
      if (!id) continue;
      const x = k % st.w, y = Math.floor(k / st.w), r = hash(x, y);
      const tree = id === 1 || id === 5;
      // Each kind has a few looks (scenery.glb); a hash of the tile picks one, falling back to the first.
      const looks = (VARIANTS[id] ?? VARIANTS[4]).filter((n) => this.templates.has(n));
      // Trees vary tile by tile; beds and hedges by 4×4 block, so a planted row or patch matches.
      const pick = tree ? r >>> 11 : hash(x >> 2, y >> 2) >>> 11;
      const name = looks.length ? looks[pick % looks.length] : VARIANTS[id]?.[0] ?? 'hedge';
      // Trees turn and vary in size; beds, fountains and hedges stay square to the grid.
      const yaw = tree ? (k * 1.7) % (Math.PI * 2) : ((r >>> 3) & 3) * (Math.PI / 2);
      const s = tree ? 0.85 + ((r >>> 5) % 31) / 100 : 1;
      lists.get(name)!.push(PropSet.at(x + 0.5, y + 0.5, yaw, s));
    }
    for (const [name, list] of lists) this.propSet(name)?.set(list);
  }

  /** A wood round the board, on the meadow below it (decoration; built from the same tree props). */
  private syncOutside(st: ParkState) {
    const key = `${st.w}x${st.h}|${this.templates.size}`;
    if (key === this.outsideKey) return;
    this.outsideKey = key;
    for (const p of this.outside) p.dispose();
    this.outside = [];
    const names = ['oak_a', 'oak_b', 'pine_a', 'pine_b', 'oak_c', 'pine_c'].filter((n) => this.templates.has(n));
    if (!names.length) return;
    const lists = names.map(() => [] as THREE.Matrix4[]);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), sc = new THREE.Vector3();
    const band = 8, step = 1.5;
    for (let gy = -band; gy < st.h + band; gy += step) for (let gx = -band; gx < st.w + band; gx += step) {
      const ix = Math.round(gx * 2), iy = Math.round(gy * 2), r = hash(ix + 7919, iy + 104729);
      const x = gx + ((r & 255) / 255 - 0.5) * 1.1, z = gy + (((r >>> 8) & 255) / 255 - 0.5) * 1.1;
      const out = Math.max(-x, x - st.w, -z, z - st.h); // distance outside the board (negative: on it)
      if (out < 1.2) continue;
      // Thicker further out; a clearing in front of the gate.
      if (((r >>> 16) & 255) / 255 > 0.35 + out * 0.08) continue;
      if (z > st.h && Math.abs(x - st.gate[0] - 0.5) < 4) continue;
      const i = (r >>> 24) % names.length;
      const s = 1.15 + ((r >>> 20) & 15) / 25;
      q.setFromAxisAngle(up, ((r >>> 12) & 63) / 10);
      lists[i].push(new THREE.Matrix4().compose(pos.set(x, -1.2, z), q, sc.setScalar(s)));
    }
    names.forEach((n, i) => {
      const p = new PropSet(this.templates.get(n)!, false);
      p.set(lists[i]);
      this.scene.add(p.group);
      this.outside.push(p);
    });
  }

  /** An outline round the ride the inspect panel shows, pulsing gently. */
  private syncSelection(st: ParkState, time: number) {
    const id = this.selected();
    const r = id !== null ? st.rides.find((x) => x.id === id) : undefined;
    const key = r ? `${r.id},${r.x},${r.y},${r.w},${r.h},${r.track?.length ?? 0}` : '';
    if (key !== this.selectionKey) {
      this.selectionKey = key;
      for (const c of this.selection.children) (c as THREE.Mesh).geometry.dispose();
      this.selection.clear();
      if (r) {
        const tiles: [number, number][] = r.track ? r.track.map((tp) => [tp.x, tp.y]) : [[r.x, r.y]];
        const w = r.track ? 1 : r.w, h = r.track ? 1 : r.h;
        const m = this.selectMat;
        for (const [x0, y0] of tiles) {
          // Just outside the footprint, so a ride's own plinth can't hide it.
          const t = 0.09, x = x0 - t / 2, y = y0 - t / 2, ww = w + t, hh = h + t;
          for (const [cx, cz, sx, sz] of [[x + ww / 2, y, ww + t, t], [x + ww / 2, y + hh, ww + t, t], [x, y + hh / 2, t, hh], [x + ww, y + hh / 2, t, hh]]) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.05, sz), m);
            b.position.set(cx, 0.1, cz);
            this.selection.add(b);
          }
        }
      }
    }
    this.selection.visible = !!r;
    if (r) this.selectMat.opacity = 0.8 + Math.sin(time * 4) * 0.2;
  }
  private selectMat = new THREE.MeshBasicMaterial({ color: '#ffc531', transparent: true, opacity: 0.9, depthWrite: false });

  /** Sun, sky and lamps follow the park's clock: morning, a long day, a golden evening, a blue dusk. */
  private daylight(st: ParkState, alpha: number) {
    const ph = this.timeOfDay ?? (((st.tick + alpha) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY / TICKS_PER_DAY;
    let i = 0;
    while (i < DAY.length - 2 && ph > DAY[i + 1][0]) i++;
    const a = DAY[i], b = DAY[i + 1];
    const f = Math.min(1, Math.max(0, (ph - a[0]) / (b[0] - a[0] || 1)));
    const k = f * f * (3 - 2 * f);
    const c = this.tmp.c;
    this.sun.color.set(a[1]).lerp(c.set(b[1]), k);
    this.sun.intensity = a[2] + (b[2] - a[2]) * k;
    this.hemi.color.set(a[3]).lerp(c.set(b[3]), k);
    this.hemi.groundColor.set(a[4]).lerp(c.set(b[4]), k);
    this.hemi.intensity = a[5] + (b[5] - a[5]) * k;
    (this.scene.background as THREE.Color).set(a[6]).lerp(c.set(b[6]), k);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.night = a[7] + (b[7] - a[7]) * k;
    this.scene.environmentIntensity = 0.4 * (1 - this.night * 0.55);
    for (const [m, base] of glows) m.emissiveIntensity = base * (1 + this.night * 1.6);
    (this.pools.material as THREE.MeshBasicMaterial).opacity = this.night * 0.55;
    this.pools.visible = this.night > 0.02;
  }

  private tmp = { m: new THREE.Matrix4(), h: new THREE.Matrix4(), q: new THREE.Quaternion(), sc: new THREE.Vector3(1, 1, 1), p: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), c: new THREE.Color() };
  private chains = new Map<number, [number, number][]>();
  private chainsVersion = -1;
  /** Queue spots this frame: visitor id → slot in queueX/queueY. Reused every frame (no per-frame garbage). */
  private queueSlot = new Map<number, number>();
  private queueX = new Float32Array(MAX_PEOPLE);
  private queueY = new Float32Array(MAX_PEOPLE);

  private syncPeople(st: ParkState, alpha: number) {
    const { p } = this.tmp;
    if (this.chainsVersion !== st.mapVersion) { this.chains.clear(); this.chainsVersion = st.mapVersion; }
    const queueSlots = this.chains;
    const slots = this.queueSlot, qx = this.queueX, qy = this.queueY;
    slots.clear();
    let qn = 0;
    for (const r of st.rides) {
      if (!r.queue.length) continue;
      let chain = queueSlots.get(r.id);
      if (!chain) { chain = queueChain(st, r); queueSlots.set(r.id, chain); }
      for (let i = 0; i < r.queue.length && qn < MAX_PEOPLE; i++) {
        const tile = chain[Math.floor(i / 8)];
        const slot = i % 8;
        qx[qn] = (tile ? tile[0] : r.ex) + 0.2 + (slot % 4) * 0.2;
        qy[qn] = (tile ? tile[1] : r.ey) + 0.3 + Math.floor(slot / 4) * 0.4;
        slots.set(r.queue[i], qn++);
      }
    }
    const crowd = this.crowd;
    crowd.begin();
    for (const v of st.visitors) {
      if (v.mode === 'riding' || v.mode === 'gone') continue;
      const qi = v.mode === 'queuing' ? slots.get(v.id) : undefined;
      if (qi !== undefined) p.set(qx[qi], 0, qy[qi]);
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
        ROLE[s.role] ?? STAFF_TROUSERS, STAFF_TROUSERS, SKIN[(s.id * 7) % SKIN.length], HAIR[(s.id * 3) % HAIR.length]);
    }
    staff.end();
  }

  private syncLitter(st: ParkState) {
    const m = this.tmp.m;
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
    if (st !== this.lastState) { if (this.lastState) this.onNewPark(st); this.lastState = st; }
    // Tiles: on any map change, and every 16 ticks for litter-driven bins (once per tick, not every frame while paused).
    const tileTick = st.tick >> 4;
    if (st.mapVersion !== this.mapVersion || tileTick !== this.lastTileTick) { this.syncTiles(st); this.mapVersion = st.mapVersion; this.lastTileTick = tileTick; }
    if (st.mapVersion !== this.furnitureVersion) { this.syncFurniture(st); this.furnitureVersion = st.mapVersion; }
    this.syncRides(st);
    this.syncScenery(st);
    this.syncOutside(st);
    this.syncPeople(st, alpha);
    this.syncSelection(st, time);
    this.daylight(st, alpha);
    // The build preview breathes, so it reads against busy scenery.
    const breathe = 1 + Math.sin(time * 5) * 0.22;
    this.ghost.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m || Array.isArray(m) || !m.transparent) return;
      m.userData.baseOpacity ??= m.opacity;
      m.opacity = Math.min(1, m.userData.baseOpacity * breathe);
    });
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
