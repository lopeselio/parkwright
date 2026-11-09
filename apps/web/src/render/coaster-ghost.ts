// The see-through "next piece" shown at a coaster's open end while you build: the same path the sim
// would lay (trackPath with the piece appended), the tiles it would take, and an arrow for where the
// track heads next. Green if the piece fits, red if it doesn't.
import * as THREE from 'three';
import { LEVEL_M, PIECES, TILE_M, endPose, isClosed, nextPose, pieceTiles, trackPath, type TrackPiece } from '@parkwright/sim';

const M = 1 / TILE_M;
const GAUGE = 0.11;
const look = (ok: boolean, opacity: number) => new THREE.MeshBasicMaterial({ color: ok ? '#5fd17a' : '#ef5a5a', transparent: true, opacity, depthWrite: false });
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

/** Free a ghost's geometry and materials (they're built fresh each time). */
export function disposeGhost(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
}

export function pieceGhost(track: TrackPiece[], pieceId: string, ok: boolean): THREE.Group {
  const g = new THREE.Group();
  const def = PIECES[pieceId];
  const end = endPose(track);
  if (!def || !end) return g;
  const tmp: TrackPiece[] = [...track, { piece: pieceId, x: end.x, y: end.y, z: end.z, dir: end.dir }];
  const idx = tmp.length - 1;
  const all = trackPath(tmp);
  const first = all.findIndex((p) => p.piece === idx);
  if (first < 0) return g;
  const pts = all.slice(Math.max(0, first - 1)).filter((p, i) => i === 0 || p.piece === idx);
  // The closing piece: run the rails right into the station.
  if (isClosed(tmp) && all.length) pts.push(all[0]);
  let tipY = end.z * LEVEL_M * M + 0.12;
  const vecs = pts.map((p) => new THREE.Vector3(p.x * M, p.y * M + 0.12, p.z * M));
  if (vecs.length >= 2) {
    const right = vecs.map((v, i) => {
      const a = vecs[Math.max(0, i - 1)], b = vecs[Math.min(vecs.length - 1, i + 1)];
      const t = new THREE.Vector3().subVectors(b, a).setY(0).normalize();
      return new THREE.Vector3(-t.z, 0, t.x);
    });
    const rail = look(ok, 0.8);
    for (const side of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3(vecs.map((v, i) => v.clone().addScaledVector(right[i], side * GAUGE)), false, 'centripetal');
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, vecs.length * 2, 0.032, 6, false), rail));
    }
    // A post under the end so you can read the height.
    const tip = vecs[vecs.length - 1];
    tipY = tip.y;
    if (tip.y > 0.25) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, tip.y, 0.04), look(ok, 0.35));
      post.position.set(tip.x, tip.y / 2, tip.z);
      g.add(post);
    }
  }
  // Tiles the piece would take, on the ground.
  const tileMat = look(ok, 0.3);
  for (const [tx, ty] of pieceTiles(end, def)) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.03, 0.94), tileMat);
    t.position.set(tx + 0.5, 0.04, ty + 0.5);
    g.add(t);
  }
  // Arrow: where the track goes after this piece.
  const nxt = nextPose(end, def);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 10), look(ok, 0.85));
  arrow.rotation.set(Math.PI / 2, 0, 0);
  const holder = new THREE.Group();
  holder.add(arrow);
  // Sits on the rail tip (the smoothed height the train actually rides), pointing the way the track continues.
  holder.position.set(nxt.x + 0.5 - DX[nxt.dir] * 0.25, tipY + 0.18, nxt.y + 0.5 - DY[nxt.dir] * 0.25);
  holder.rotation.y = Math.atan2(DX[nxt.dir], DY[nxt.dir]);
  g.add(holder);
  g.renderOrder = 10;
  return g;
}
