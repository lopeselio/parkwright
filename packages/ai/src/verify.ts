// Check a NEAR AI Cloud reply signature in the browser (or Node): no trust in our server needed.
// provider_tee signs `${model}:${sha256(request)}:${sha256(response)}` with EIP-191 ECDSA (secp256k1).
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
    { id: 'sig.kind', label: 'Signed inside the model TEE (provider_tee)', ok: (sig.signature_kind ?? 'provider_tee') === 'provider_tee' },
    { id: 'sig.payload', label: 'Signature covers this exact request and reply', ok: sig.text === expected },
    { id: 'sig.valid', label: 'Signature is valid for the claimed TEE key', ok: recovered !== '' && recovered === sig.signing_address.toLowerCase() },
  ];
  if (trustedSigners.length) checks.push({ id: 'sig.attested', label: 'Signing key is in the model’s attestation report', ok: trustedSigners.map((s) => s.toLowerCase()).includes(recovered) });
  return checks;
}
