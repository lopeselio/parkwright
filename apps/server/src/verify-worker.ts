// Worker thread: replays saves for the Verifier, off the main event loop.
import { parentPort } from 'node:worker_threads';
import { verifySave } from './verify.ts';

parentPort!.on('message', (save) => {
  let r;
  try { r = verifySave(save); } catch (e) { r = { ok: false, reason: `verification crashed: ${(e as Error).message}`, ms: 0 }; }
  parentPort!.postMessage(r);
});
