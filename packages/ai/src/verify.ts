// Check a NEAR AI Cloud reply signature in the browser (or Node).
// provider_tee signs `${model}:${sha256(request)}:${sha256(response)}` with EIP-191 ECDSA (secp256k1).
// What this proves on its own: the exact request/response bytes were signed by that key. Which keys belong
// to an attested TEE comes from the model's attestation report — fetched via our server; verifying the
// TDX/GPU quote itself (with a client nonce) is not done in the browser yet.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export interface ChatSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind?: 'provider_tee' | 'gateway';
}

/** Everything needed to check one AI reply after the fact. */
export interface ProofBundle {
  model: string;
  chatId: string;
  requestBody: string;
  responseBody: string;
  signature: ChatSignature | null;
}

export interface Check { id: string; label: string; ok: boolean }

export const sha256Hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

/** Recover the Ethereum-style address that signed `message` (EIP-191 personal_sign). */
export function recoverAddress(message: string, signatureHex: string): string {
  const msg = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  let v = sig[64];
  if (v >= 27) v -= 27;
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
}

/**
 * Checks that don't need anyone's word for it: the signature is from the model's TEE key and covers
 * exactly this request and this reply. Whether that key belongs to an attested TEE is a separate
 * check (`trustedSigners`, from the model's attestation report).
 */
export function verifyProof(p: ProofBundle, trustedSigners: string[] = []): Check[] {
  const sig = p.signature;
  if (!sig) return [{ id: 'sig.present', label: 'The reply carries a TEE signature', ok: false }];
  let recovered = '';
  try { recovered = recoverAddress(sig.text, sig.signature).toLowerCase(); } catch { /* fails below */ }
  const expected = `${p.model}:${sha256Hex(p.requestBody)}:${sha256Hex(p.responseBody)}`;
  const checks: Check[] = [
    { id: 'sig.kind', label: 'Signed inside the model TEE (provider_tee)', ok: sig.signature_kind === 'provider_tee' },
    { id: 'sig.payload', label: 'Signature covers this exact request and reply', ok: sig.text === expected },
    { id: 'sig.valid', label: 'Signature is valid for the claimed TEE key', ok: recovered !== '' && recovered === sig.signing_address.toLowerCase() },
  ];
  // No attestation list means we can't tie the key to a TEE: that's a failed check, not a skipped one.
  checks.push({ id: 'sig.attested', label: 'Signing key is in the model’s attestation report', ok: trustedSigners.length > 0 && trustedSigners.map((s) => s.toLowerCase()).includes(recovered) });
  return checks;
}

/** The model's reply text, taken from the signed response bytes (not from anything the server re-sent). */
export function contentFromProof(p: ProofBundle): string {
  const j = JSON.parse(p.responseBody);
  return String(j?.choices?.[0]?.message?.content ?? '');
}
