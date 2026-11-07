// Procedural low-poly models. Used when no Blender-built .glb exists for a model id (and as the base look).
import * as THREE from 'three';

export type Animator = (t: number, running: boolean) => void;

const mats = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const key = color + JSON.stringify(opts);
  let m = mats.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, flatShading: true, ...opts }); mats.set(key, m); }
  return m;
}

function mesh(geo: THREE.BufferGeometry, color: string, opts?: Partial<THREE.MeshStandardMaterialParameters>) {
  const m = new THREE.Mesh(geo, mat(color, opts));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const PALETTE = ['#e85d5d', '#f2b84b', '#5fb6e8', '#7ccf7a', '#b07ae8', '#f08fc0'];

/** A model sits on a w×h footprint with its origin at the footprint's centre, y = 0 at ground. */
export function buildModel(model: string, color: string, w: number, h: number): { group: THREE.Group; animate: Animator } {
  const g = new THREE.Group();
  let animate: Animator = () => {};
  const base = (r: number, c = '#d9cdb4') => { const b = mesh(new THREE.CylinderGeometry(r, r * 1.04, 0.18, 24), c); b.position.y = 0.09; g.add(b); return b; };
  switch (model) {
    case 'carousel': {
      base(1.35);
      const spin = new THREE.Group();
      g.add(spin);
      const roof = mesh(new THREE.ConeGeometry(1.45, 0.8, 12), color);
      roof.position.y = 1.75;
      spin.add(roof);
      const pole = mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.6, 8), '#c9a74a', { metalness: 0.5, roughness: 0.4 });
      pole.position.y = 0.95;
      spin.add(pole);
      const horses: THREE.Object3D[] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rod = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6), '#e8d8a0', { metalness: 0.6 });
        rod.position.set(Math.cos(a) * 1.05, 0.95, Math.sin(a) * 1.05);
        spin.add(rod);
        const horse = mesh(new THREE.BoxGeometry(0.16, 0.22, 0.42), PALETTE[i % PALETTE.length]);
        horse.position.set(Math.cos(a) * 1.05, 0.7, Math.sin(a) * 1.05);
        horse.rotation.y = -a;
        spin.add(horse);
        horses.push(horse);
      }
      animate = (t, run) => {
        if (!run) return;
        spin.rotation.y = t * 0.9;
        horses.forEach((hh, i) => (hh.position.y = 0.7 + Math.sin(t * 3 + i) * 0.12));
      };
      break;
    }
    case 'teacups': {
      base(1.4, '#e8d0d8');
      const plate = new THREE.Group();
      g.add(plate);
      const cups: THREE.Object3D[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const cup = new THREE.Group();
        const body = mesh(new THREE.CylinderGeometry(0.34, 0.22, 0.34, 14, 1, true), PALETTE[i], { side: THREE.DoubleSide });
        body.position.y = 0.17;
        const handle = mesh(new THREE.TorusGeometry(0.1, 0.03, 6, 10), PALETTE[i]);
        handle.position.set(0.36, 0.2, 0);
        cup.add(body, handle);
        cup.position.set(Math.cos(a) * 0.85, 0.18, Math.sin(a) * 0.85);
        plate.add(cup);
        cups.push(cup);
      }
      animate = (t, run) => {
        if (!run) return;
        plate.rotation.y = t * 0.6;
        cups.forEach((c, i) => (c.rotation.y = t * (2 + i * 0.3)));
      };
      break;
    }
    case 'wheel': {
      const support = (side: number) => {
        for (const s of [-1, 1]) {
          const leg = mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.4, 6), '#8c96a0', { metalness: 0.6 });
          leg.position.set(s * 0.45, 1.15, side * 0.35);
          leg.rotation.x = 0;
          leg.rotation.z = s * 0.2;
          g.add(leg);
        }
      };
      support(1); support(-1);
      const wheel = new THREE.Group();
      wheel.position.y = 2.2;
      g.add(wheel);
      const rim = mesh(new THREE.TorusGeometry(1.0, 0.04, 6, 32), color, { metalness: 0.4 });
      wheel.add(rim);
      const gondolas: THREE.Object3D[] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const sp = mesh(new THREE.CylinderGeometry(0.015, 0.015, 1, 4), '#dfe6ec');
        sp.position.set(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0);
        sp.rotation.z = a + Math.PI / 2;
        wheel.add(sp);
        const gd = mesh(new THREE.BoxGeometry(0.2, 0.18, 0.22), PALETTE[i % PALETTE.length]);
        gd.position.set(Math.cos(a) * 1.0, Math.sin(a) * 1.0 - 0.12, 0);
        wheel.add(gd);
        gondolas.push(gd);
      }
      g.rotation.y = w > h ? 0 : Math.PI / 2;
      animate = (t, run) => {
        if (!run) return;
        wheel.rotation.z = t * 0.25;
        gondolas.forEach((gd) => (gd.rotation.z = -wheel.rotation.z));
      };
      break;
    }
    case 'swings': {
      base(1.3, '#cfe0c8');
      const tower = mesh(new THREE.CylinderGeometry(0.15, 0.22, 2.6, 10), '#e6e1d3');
      tower.position.y = 1.3;
      g.add(tower);
      const top = new THREE.Group();
      top.position.y = 2.5;
      g.add(top);
      const canopy = mesh(new THREE.ConeGeometry(1.1, 0.45, 12), color);
      top.add(canopy);
      const seats: THREE.Object3D[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const arm = new THREE.Group();
        arm.rotation.y = a;
        arm.position.set(0, -0.15, 0);
        const pivot = new THREE.Group();
        pivot.position.x = 0.95;
        const chain = mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.2, 3), '#888');
        chain.position.y = -0.6;
        const seat = mesh(new THREE.BoxGeometry(0.16, 0.05, 0.16), PALETTE[i % PALETTE.length]);
        seat.position.y = -1.2;
        pivot.add(chain, seat);
        arm.add(pivot);
        top.add(arm);
        seats.push(pivot);
      }
      animate = (t, run) => {
        const spd = run ? 1.6 : 0;
        top.rotation.y = t * spd;
        seats.forEach((p) => (p.rotation.z = run ? 0.75 : 0));
      };
      break;
    }
    case 'droptower': {
      const pad = mesh(new THREE.BoxGeometry(w * 0.9, 0.18, h * 0.9), '#d6d0e0');
      pad.position.y = 0.09;
      g.add(pad);
      const col = mesh(new THREE.BoxGeometry(0.35, 5.2, 0.35), '#ececf4');
      col.position.y = 2.6;
      g.add(col);
      const cap = mesh(new THREE.ConeGeometry(0.35, 0.5, 4), color);
      cap.position.y = 5.45;
      cap.rotation.y = Math.PI / 4;
      g.add(cap);
      const ring = mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.3, 12), color);
      ring.position.y = 0.5;
      g.add(ring);
      animate = (t, run) => {
        if (!run) { ring.position.y = 0.5; return; }
        const ph = (t % 9) / 9;
        ring.position.y = ph < 0.55 ? 0.5 + (ph / 0.55) * 4.2 : ph < 0.7 ? 4.7 : ph < 0.76 ? 4.7 - ((ph - 0.7) / 0.06) * 4.2 : 0.5;
      };
      break;
    }
    case 'spookwalk': {
      const house = mesh(new THREE.BoxGeometry(w * 0.9, 1.3, h * 0.85), color);
      house.position.y = 0.65;
      g.add(house);
      const roof = mesh(new THREE.ConeGeometry(Math.max(w, h) * 0.62, 0.9, 4), '#2b2b3d');
      roof.position.y = 1.75;
      roof.rotation.y = Math.PI / 4;
      roof.scale.z = h / w;
      g.add(roof);
      const lamps: THREE.Mesh[] = [];
      for (let i = 0; i < 3; i++) {
        const l = mesh(new THREE.SphereGeometry(0.09, 8, 6), '#ffd27a', { emissive: '#ffb347', emissiveIntensity: 1 });
        l.position.set(-w * 0.3 + i * w * 0.3, 1.0, h * 0.44);
        g.add(l);
        lamps.push(l);
      }
      animate = (t) => lamps.forEach((l, i) => ((l.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6 + Math.sin(t * 4 + i * 2) * 0.4));
      break;
    }
    case 'stall': {
      const box = mesh(new THREE.BoxGeometry(0.75, 0.6, 0.6), '#f4eee0');
      box.position.y = 0.3;
      g.add(box);
      const awn = mesh(new THREE.BoxGeometry(0.85, 0.06, 0.45), color);
      awn.position.set(0, 0.85, 0.2);
      awn.rotation.x = 0.35;
      g.add(awn);
      for (const s of [-1, 1]) {
        const post = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.85, 4), '#999');
        post.position.set(s * 0.37, 0.42, 0.38);
        g.add(post);
      }
      const sign = mesh(new THREE.BoxGeometry(0.5, 0.2, 0.04), color);
      sign.position.set(0, 1.1, -0.1);
      g.add(sign);
      break;
    }
    case 'restroom': {
      const box = mesh(new THREE.BoxGeometry(0.8, 0.7, 0.75), color);
      box.position.y = 0.35;
      g.add(box);
      const roof = mesh(new THREE.BoxGeometry(0.9, 0.08, 0.85), '#5a6a78');
      roof.position.y = 0.74;
      g.add(roof);
      const door = mesh(new THREE.BoxGeometry(0.22, 0.42, 0.02), '#4a7ab0');
      door.position.set(0, 0.22, 0.385);
      g.add(door);
      break;
    }
    default: {
      const box = mesh(new THREE.BoxGeometry(w * 0.85, 1, h * 0.85), color);
      box.position.y = 0.5;
      g.add(box);
    }
  }
  return { group: g, animate };
}

export function buildScenery(id: number): THREE.Object3D {
  const g = new THREE.Group();
  const rnd = (n: number) => 0.85 + ((n * 9301 + 49297) % 233280) / 233280 * 0.3;
  switch (id) {
    case 1: {
      const trunk = mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.4, 5), '#7a5536');
      trunk.position.y = 0.2;
      const crown = mesh(new THREE.IcosahedronGeometry(0.32, 0), '#5f9e4a');
      crown.position.y = 0.6;
      g.add(trunk, crown);
      break;
    }
    case 5: {
      const trunk = mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.25, 5), '#6a4a30');
      trunk.position.y = 0.12;
      const c1 = mesh(new THREE.ConeGeometry(0.3, 0.55, 7), '#3f7d4d');
      c1.position.y = 0.48;
      const c2 = mesh(new THREE.ConeGeometry(0.22, 0.45, 7), '#478a56');
      c2.position.y = 0.78;
      g.add(trunk, c1, c2);
      break;
    }
    case 2: {
      const bed = mesh(new THREE.BoxGeometry(0.8, 0.12, 0.8), '#6b4e33');
      bed.position.y = 0.06;
      g.add(bed);
      for (let i = 0; i < 9; i++) {
        const f = mesh(new THREE.IcosahedronGeometry(0.08, 0), PALETTE[i % PALETTE.length]);
        f.position.set(((i % 3) - 1) * 0.24, 0.17, (Math.floor(i / 3) - 1) * 0.24);
        g.add(f);
      }
      break;
    }
    case 3: {
      const basin = mesh(new THREE.CylinderGeometry(0.42, 0.45, 0.18, 16), '#cfd6dc');
      basin.position.y = 0.09;
      const water = mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.02, 16), '#6ec3ea', { roughness: 0.1, metalness: 0.2 });
      water.position.y = 0.17;
      const spout = mesh(new THREE.CylinderGeometry(0.04, 0.08, 0.5, 8), '#cfd6dc');
      spout.position.y = 0.4;
      const top = mesh(new THREE.SphereGeometry(0.09, 10, 8), '#9ad8f4', { transparent: true, opacity: 0.8 });
      top.position.y = 0.7;
      g.add(basin, water, spout, top);
      break;
    }
    case 4: {
      const hedge = mesh(new THREE.BoxGeometry(0.9, 0.35, 0.35), '#4f8a3e');
      hedge.position.y = 0.17;
      g.add(hedge);
      break;
    }
  }
  g.scale.setScalar(rnd(id));
  return g;
}
