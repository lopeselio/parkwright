// NEAR wallet for claiming a park and withdrawing its earnings: NEAR Connect's wallet picker (testnet).
// Loaded on demand, so players who never claim don't download it.
import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect';

export const CONTRACT = 'park.parkwright.testnet';
let connector: Promise<NearConnector> | null = null;

function picker() {
  connector ??= import('@hot-labs/near-connect').then(({ NearConnector }) => new NearConnector({ network: 'testnet', features: { signMessage: true, signAndSendTransaction: true } }));
  return connector;
}

/** Open the wallet picker (or reuse a connected wallet). */
export async function connect(): Promise<{ wallet: NearWalletBase; accountId: string }> {
  const c = await picker();
  const existing = await c.getConnectedWallet().catch(() => null);
  const wallet = existing?.wallet ?? (await c.connect());
  const [acc] = await wallet.getAccounts({ network: 'testnet' });
  if (!acc) throw new Error('the wallet did not share an account');
  return { wallet, accountId: acc.accountId };
}

export async function disconnect() {
  const c = await picker();
  await c.disconnect().catch(() => {});
}

/** Sign the server's one-time claim challenge (NEP-413). */
export async function signClaim(wallet: NearWalletBase, accountId: string, ch: { message: string; recipient: string; nonce: string }) {
  const nonce = Uint8Array.from(atob(ch.nonce), (c) => c.charCodeAt(0));
  return wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce, network: 'testnet', signerId: accountId });
}

/** Move the park's escrow into your CR balance (the contract requires 1 yoctoNEAR and the owner's signature). */
export async function withdraw(wallet: NearWalletBase, accountId: string, parkId: string) {
  return wallet.signAndSendTransaction({
    network: 'testnet', signerId: accountId, receiverId: CONTRACT,
    actions: [{ type: 'FunctionCall', params: { methodName: 'withdraw', args: { park_id: parkId }, gas: '30000000000000', deposit: '1' } }],
  });
}
