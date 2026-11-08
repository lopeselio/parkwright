import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import { parseJsonReply, recoverAddress, sha256Hex, verifyProof, type ProofBundle } from '../src/index.ts';

// A throwaway key standing in for the model TEE's signing key.
const priv = secp256k1.utils.randomPrivateKey();
const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20))}`;

function personalSign(message: string) {
  const msg = utf8ToBytes(message);
  const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const sig = secp256k1.sign(digest, priv);
  return `0x${bytesToHex(sig.toCompactRawBytes())}${(sig.recovery + 27).toString(16)}`;
}

function bundle(): ProofBundle {
  const requestBody = '{"model":"m","messages":[]}';
  const responseBody = '{"id":"chat-1","choices":[]}';
  const text = `m:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  return { model: 'm', chatId: 'chat-1', requestBody, responseBody, signature: { text, signature: personalSign(text), signing_address: address, signature_kind: 'provider_tee' } };
}

describe('TEE reply proofs', () => {
  it('recovers the signer of an EIP-191 message', () => {
    expect(recoverAddress('hello', personalSign('hello'))).toBe(address);
  });

  it('accepts a reply signed over exactly its request and response', () => {
    const checks = verifyProof(bundle(), [address]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('rejects a tampered reply, a stranger key and a missing signature', () => {
    const b = bundle();
    expect(verifyProof({ ...b, responseBody: b.responseBody + ' ' }).find((c) => c.id === 'sig.payload')!.ok).toBe(false);
    expect(verifyProof(b, ['0x0000000000000000000000000000000000000001']).find((c) => c.id === 'sig.attested')!.ok).toBe(false);
    expect(verifyProof({ ...b, signature: null })[0].ok).toBe(false);
  });

  it('parses JSON replies wrapped in fences or prose', () => {
    expect(parseJsonReply<{ a: number }>('```json\n{"a":1}\n```').a).toBe(1);
    expect(parseJsonReply<{ a: number }>('Sure! {"a":2} done').a).toBe(2);
    expect(() => parseJsonReply('nope')).toThrow();
  });
});
