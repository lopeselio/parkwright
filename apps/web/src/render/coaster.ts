// Coaster track + train, generated from the sim's own path so what you see is what the test run measured.
import * as THREE from 'three';
import { TILE_M, PIECES, endPose, isClosed, testRun, trackPath, type Ride, type TestRun } from '@parkwright/sim';
import { mat } from './models.ts';

/** Sim metres → render units (1 unit = 1 tile). */
const M = 1 / TILE_M;
const GAUGE = 0.11;
const CARS = 3;
const CAR_GAP = 0.32; // units between car centres along the track

export interface CoasterView {
  group: THREE.Group;
  /** Place the train from the sim: ticks into the ride cycle (+ alpha between ticks). */
  animate: (ride: Ride, alpha: number) => void;
}

function toVec(p: { x: number; y: number; z: number }) {
  return new THREE.Vector3(p.x * M, p.y * M + 0.12, p.z * M);
}

/** Intensity colour: calm wood → hot red where the forces are high. */
function forceColour(vert: number, lat: number) {
  const k = Math.min(1, Math.max(0, (Math.max(vert - 1, 0) / 2.5 + Math.abs(lat) / 2 + Math.max(0, -vert) / 0.8) / 1.2));
  return new THREE.Color().setHSL(0.08 - 0.08 * k, 0.55 + 0.3 * k, 0.42);
}

/** car: an optional factory for a car model (front +z, sitting on y = 0); the car index picks its colour. */
export function buildCoaster(ride: Ride, car?: (i: number) => THREE.Object3D | null): CoasterView {
  const g = new THREE.Group();
  const track = ride.track ?? [];
  const pts = trackPath(track);
  if (pts.length < 2) return { group: g, animate: () => {} };
  const closed = isClosed(track);
  const run: TestRun | null = closed ? testRun(track) : null;
  const vecs = pts.map(toVec);

  // Frame along the path: tangent + horizontal right vector (rails sit either side).
  const right: THREE.Vector3[] = vecs.map((v, i) => {
    const a = vecs[Math.max(0, i - 1)], b = vecs[Math.min(vecs.length - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
    return new THREE.Vector3(-t.z, 0, t.x);
  });

  const curveOf = (side: number) => new THREE.CatmullRomCurve3(vecs.map((v, i) => v.clone().addScaledVector(right[i], side * GAUGE)), closed, 'centripetal');
  const railMat = mat('#c9c2b0', { metalness: 0.5, roughness: 0.35 });
  const segs = Math.max(16, pts.length * 2);
  for (const side of [-1, 1]) {
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curveOf(side), segs, 0.028, 6, closed), railMat);
    tube.castShadow = true;
    g.add(tube);
  }

  // Ties (sleepers), coloured by the forces measured in the test run.
  const tieGeo = new THREE.BoxGeometry(GAUGE * 2.6, 0.03, 0.06);
  const ties = new THREE.InstancedMesh(tieGeo, mat('#ffffff', { roughness: 0.8 }), pts.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  pts.forEach((p, i) => {
    const v = vecs[i];
    const nxt = vecs[(i + 1) % vecs.length];
    const ang = Math.atan2(nxt.x - v.x, nxt.z - v.z);
    const bank = p.bank * 0.7;
    q.setFromEuler(new THREE.Euler(0, ang, -bank, 'YXZ'));
    m4.compose(v.clone().setY(v.y - 0.03), q, new THREE.Vector3(1, 1, 1));
    ties.setMatrixAt(i, m4);
    const def = PIECES[track[p.piece].piece];
    const c = def.lift ? new THREE.Color('#5a5f66') : def.brakes ? new THREE.Color('#d0a020') : def.station ? new THREE.Color('#8a6a4a') : run?.vert ? forceColour(run.vert[i], run.lat![i]) : new THREE.Color('#9a7048');
    ties.setColorAt(i, c);
  });
  ties.castShadow = true;
  g.add(ties);

  // Timber bents down to the ground every few samples: two posts, a cap beam under the ties, a diagonal
  // brace on the taller ones, and a concrete footing under each post. All instances of one unit box.
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const timber: THREE.Matrix4[] = [], footings: THREE.Matrix4[] = [];
  const up = new THREE.Vector3(0, 1, 0), qq = new THREE.Quaternion(), half = GAUGE * 1.4;
  for (let i = 0; i < pts.length; i += 4) {
    const v = vecs[i];
    if (v.y < 0.2) continue;
    const r = right[i];
    const yaw = Math.atan2(-r.z, r.x);
    qq.setFromAxisAngle(up, yaw);
    const top = v.y - 0.04;
    for (const side of [-1, 1]) {
      const base = v.clone().addScaledVector(r, side * half);
      timber.push(new THREE.Matrix4().compose(new THREE.Vector3(base.x, top / 2, base.z), qq, new THREE.Vector3(0.05, top, 0.05)));
      footings.push(new THREE.Matrix4().compose(new THREE.Vector3(base.x, 0.02, base.z), qq, new THREE.Vector3(0.1, 0.04, 0.1)));
    }
    timber.push(new THREE.Matrix4().compose(new THREE.Vector3(v.x, top - 0.02, v.z), qq, new THREE.Vector3(half * 2 + 0.08, 0.035, 0.05)));
    if (top > 0.5) {
      // From the foot of one post to near the top of the other.
      const a = v.clone().addScaledVector(r, -half).setY(0.05);
      const b = v.clone().addScaledVector(r, half).setY(top - 0.08);
      const d = new THREE.Vector3().subVectors(b, a);
      const q2 = new THREE.Quaternion().setFromUnitVectors(up, d.clone().normalize());
      timber.push(new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), q2, new THREE.Vector3(0.025, d.length(), 0.025)));
    }
  }
  const instanced = (list: THREE.Matrix4[], m: THREE.Material) => {
    const im = new THREE.InstancedMesh(unit, m, Math.max(1, list.length));
    list.forEach((p, i) => im.setMatrixAt(i, p));
    im.count = list.length;
    im.castShadow = true;
    im.receiveShadow = true;
    g.add(im);
  };
  instanced(timber, mat('#7a5638'));
  instanced(footings, mat('#bdb8ae'));

  // Station platform.
  for (const tp of track.filter((t) => PIECES[t.piece].station)) {
    const plat = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.1, 0.98), mat('#b8a07c'));
    plat.position.set(tp.x + 0.5, 0.05, tp.y + 0.5);
    plat.receiveShadow = true;
    g.add(plat);
  }

  // Open end marker while building.
  if (!closed) {
    const e = endPose(track);
    if (e) {
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.35, 8), mat('#f2b84b', { emissive: '#f2b84b', emissiveIntensity: 0.4 }));
      arrow.position.set(e.x + 0.5, e.z * 0.5 + 0.35, e.y + 0.5);
      arrow.rotation.z = Math.PI;
      g.add(arrow);
    }
  }

  // Train: cars follow the test-run speed profile.
  const cars: THREE.Group[] = [];
  const carCols = ['#c0533a', '#f2b84b', '#5fb6e8'];
  for (let i = 0; i < CARS; i++) {
    const holder = new THREE.Group();
    const model = car?.(i);
    if (model) holder.add(model);
    else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.26), mat(carCols[i % 3]));
      body.position.y = 0.06;
      body.castShadow = true;
      holder.add(body);
    }
    g.add(holder);
    cars.push(holder);
  }
  const curve = new THREE.CatmullRomCurve3(vecs, closed, 'centripetal');
  const total = run?.s ? run.s[run.s.length - 1] : 1;
  const sAt = (sec: number) => {
    if (!run?.t || !run.s) return 0;
    const tt = run.t;
    if (sec <= 0) return 0;
    if (sec >= tt[tt.length - 1]) return total;
    let lo = 0, hi = tt.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tt[mid] <= sec) lo = mid; else hi = mid; }
    const f = (sec - tt[lo]) / (tt[hi] - tt[lo] || 1);
    return run.s[lo] + (run.s[hi] - run.s[lo]) * f;
  };
  const place = (sMetres: number) => {
    cars.forEach((c, i) => {
      let u = (sMetres / total) - (i * CAR_GAP) / (total * M);
      u = ((u % 1) + 1) % 1;
      const p = curve.getPointAt(u);
      const tan = curve.getTangentAt(u);
      c.position.copy(p);
      c.lookAt(p.clone().add(tan));
    });
  };
  place(0);
  // The sim loads a batch, then counts `cycle` down from cycleTicks: the train runs for the test-run
  // duration, then sits in the station unloading. Deriving the position from the sim keeps the train
  // in step at any game speed, and still while paused.
  const animate = (r: Ride, alpha: number) => {
    if (!run?.ok || !run.t) return;
    if (r.status !== 'open' || r.cycle <= 0 || !r.cycleTicks) { place(0); return; }
    const sec = Math.min((r.cycleTicks - r.cycle + alpha) / 20, run.t[run.t.length - 1]);
    place(sAt(sec));
  };
  return { group: g, animate };
}
