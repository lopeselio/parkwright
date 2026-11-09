// Instanced scenery: one InstancedMesh per part (material) of a prop, however many of it the park has.
import * as THREE from 'three';

export class PropSet {
  readonly group = new THREE.Group();
  private parts: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private capacity = 0;

  /** template: a prop whose meshes are baked relative to its own origin. */
  constructor(template: THREE.Object3D, private shadows = true) {
    template.updateMatrixWorld(true);
    const inv = template.matrixWorld.clone().invert();
    template.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      this.parts.push({ geo: m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)), mat: m.material });
    });
  }

  private grow(n: number) {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.capacity = Math.max(16, 1 << Math.ceil(Math.log2(n)));
    this.meshes = this.parts.map((p) => {
      const im = new THREE.InstancedMesh(p.geo, p.mat, this.capacity);
      im.castShadow = this.shadows;
      im.receiveShadow = true;
      this.group.add(im);
      return im;
    });
  }

  set(matrices: THREE.Matrix4[]) {
    if (matrices.length > this.capacity) this.grow(matrices.length);
    for (const im of this.meshes) {
      matrices.forEach((m, i) => im.setMatrixAt(i, m));
      im.count = matrices.length;
      im.instanceMatrix.needsUpdate = true;
      // Culling uses the bounds of the instances; recompute them now that they moved.
      im.computeBoundingSphere();
    }
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    for (const p of this.parts) p.geo.dispose();
    this.group.removeFromParent();
  }

  /** A matrix for a prop standing at (x, z) turned yaw about the vertical, scaled s. */
  static at(x: number, z: number, yaw = 0, s = 1, out = new THREE.Matrix4()) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return out.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s, s));
  }
}
