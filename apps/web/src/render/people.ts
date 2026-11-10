// Low-poly people, instanced: legs (two instances each, so they can stride), torso with arms, head, hair.
// Five draw calls for the whole crowd (with a soft contact shadow under each person). Front is +z; the origin is between the feet.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const HIP = 0.16;

function torsoGeometry() {
  const body = new THREE.CylinderGeometry(0.052, 0.046, 0.15, 7);
  body.translate(0, HIP + 0.075, 0);
  const parts: THREE.BufferGeometry[] = [body];
  for (const s of [-1, 1]) {
    const arm = new THREE.BoxGeometry(0.028, 0.13, 0.034);
    arm.translate(0, -0.055, 0);
    arm.rotateZ(s * 0.12);
    arm.translate(s * 0.064, HIP + 0.14, 0);
    parts.push(arm);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
  g.computeVertexNormals();
  return g;
}

function legGeometry() {
  // Pivot at the hip; the shoe is a little longer than the leg is deep.
  const leg = new THREE.BoxGeometry(0.036, HIP - 0.012, 0.042);
  leg.translate(0, -(HIP - 0.012) / 2, 0);
  const shoe = new THREE.BoxGeometry(0.038, 0.024, 0.064);
  shoe.translate(0, -HIP + 0.012, 0.01);
  return mergeGeometries([leg.toNonIndexed(), shoe.toNonIndexed()])!;
}

function headGeometry() {
  const g = new THREE.SphereGeometry(0.052, 8, 6);
  g.scale(1, 1.08, 1);
  g.translate(0, HIP + 0.205, 0);
  return g;
}

function hairGeometry() {
  // A cap over the top and back of the head.
  const g = new THREE.SphereGeometry(0.057, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.42);
  g.rotateX(-0.35);
  g.translate(0, HIP + 0.212, -0.004);
  return g;
}

const material = (rough = 0.75) => new THREE.MeshStandardMaterial({ roughness: rough, metalness: 0 });

export class Crowd {
  readonly legs: THREE.InstancedMesh;
  readonly torso: THREE.InstancedMesh;
  readonly head: THREE.InstancedMesh;
  readonly hair: THREE.InstancedMesh;
  /** A dark blot under the feet, so people stay readable on paths where shadows are off (phones) or soft. */
  readonly blot: THREE.InstancedMesh;
  private t = new THREE.Matrix4();
  private n = 0;
  private m = new THREE.Matrix4();
  private l = new THREE.Matrix4();
  private r = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(readonly capacity: number, scene: THREE.Scene, scale = 1, shadows = true) {
    this.legs = new THREE.InstancedMesh(legGeometry(), material(), capacity * 2);
    this.torso = new THREE.InstancedMesh(torsoGeometry(), material(), capacity);
    this.head = new THREE.InstancedMesh(headGeometry(), material(0.6), capacity);
    this.hair = new THREE.InstancedMesh(hairGeometry(), material(0.9), capacity);
    this.blot = new THREE.InstancedMesh(new THREE.CircleGeometry(0.075 * scale, 10).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#1d2a14', transparent: true, opacity: 0.22, depthWrite: false }), capacity);
    this.blot.count = 0;
    this.blot.frustumCulled = false;
    this.blot.renderOrder = 1;
    scene.add(this.blot);
    this.one.setScalar(scale);
    for (const im of this.meshes()) {
      im.castShadow = shadows;
      im.count = 0;
      im.frustumCulled = false;
      scene.add(im);
    }
  }

  private meshes() { return [this.legs, this.torso, this.head, this.hair]; }

  begin() { this.n = 0; }

  /** One person at p (feet), facing yaw (0 = +z), with a stride (radians of leg swing). */
  add(p: THREE.Vector3, yaw: number, stride: number, shirt: THREE.Color, trousers: THREE.Color, skin: THREE.Color, hair: THREE.Color) {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.q.setFromAxisAngle(this.up, yaw);
    this.m.compose(p, this.q, this.one);
    this.torso.setMatrixAt(i, this.m);
    this.head.setMatrixAt(i, this.m);
    this.hair.setMatrixAt(i, this.m);
    this.blot.setMatrixAt(i, this.t.makeTranslation(p.x, 0.072, p.z));
    this.torso.setColorAt(i, shirt);
    this.head.setColorAt(i, skin);
    this.hair.setColorAt(i, hair);
    for (let k = 0; k < 2; k++) {
      const s = k * 2 - 1;
      this.l.makeRotationX(stride * s).setPosition(s * 0.026, HIP, 0);
      this.r.multiplyMatrices(this.m, this.l);
      this.legs.setMatrixAt(i * 2 + k, this.r);
      this.legs.setColorAt(i * 2 + k, trousers);
    }
  }

  end() {
    this.legs.count = this.n * 2;
    this.torso.count = this.head.count = this.hair.count = this.blot.count = this.n;
    this.blot.instanceMatrix.needsUpdate = true;
    for (const im of this.meshes()) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}
