// Blender-built models (assets/blender → public/models/*.glb). Missing models fall back to procedural meshes.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let manifest: Promise<Set<string>> | null = null;
const cache = new Map<string, Promise<THREE.Group | null>>();
const loader = new GLTFLoader();

function available(): Promise<Set<string>> {
  manifest ??= fetch('/models/manifest.json')
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((m: { models: string[] }) => new Set(m.models))
    .catch(() => new Set<string>());
  return manifest;
}

/** A fresh clone of the model, or null if there is no .glb for it. */
export async function loadModel(id: string): Promise<THREE.Group | null> {
  if (!(await available()).has(id)) return null;
  let p = cache.get(id);
  if (!p) {
    p = loader.loadAsync(`/models/${id}.glb`).then((g) => {
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.scene.userData.clips = g.animations;
      return g.scene;
    }).catch(() => null);
    cache.set(id, p);
  }
  const src = await p;
  if (!src) return null;
  const clone = src.clone(true);
  const clips = src.userData.clips as THREE.AnimationClip[];
  if (clips?.length) {
    const mixer = new THREE.AnimationMixer(clone);
    for (const c of clips) mixer.clipAction(c).play();
    let last = 0;
    clone.userData.animate = (t: number, run: boolean) => { mixer.update(run ? t - last : 0); last = t; };
  } else {
    // Conventions from assets/blender/common.py: "spin" turns about the vertical axis, "wheel" turns on its
    // axle (the model's z after export), its "hang*" gondolas stay level, "carriage" rides up a tower and drops.
    // Anything else stays still.
    const spin = clone.getObjectByName('spin');
    const wheel = clone.getObjectByName('wheel');
    const hangs = wheel ? wheel.children.filter((c) => c.name.startsWith('hang')) : [];
    const carriage = clone.getObjectByName('carriage');
    const base = carriage?.position.y ?? 0;
    clone.userData.animate = (t: number, run: boolean) => {
      if (!run) { if (carriage) carriage.position.y = base; return; }
      if (spin) spin.rotation.y = t * 0.9;
      if (wheel) {
        wheel.rotation.z = t * 0.25;
        for (const h of hangs) h.rotation.z = -wheel.rotation.z;
      }
      if (carriage) {
        const ph = (t % 9) / 9;
        carriage.position.y = base + (ph < 0.55 ? (ph / 0.55) * 4.2 : ph < 0.7 ? 4.2 : ph < 0.76 ? 4.2 - ((ph - 0.7) / 0.06) * 4.2 : 0);
      }
    };
  }
  return clone;
}
