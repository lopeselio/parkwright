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
    // Convention: a node named "spin" rotates about Y while the ride runs.
    const spin = clone.getObjectByName('spin');
    clone.userData.animate = (t: number, run: boolean) => { if (spin && run) spin.rotation.y = t * 0.9; };
  }
  return clone;
}
