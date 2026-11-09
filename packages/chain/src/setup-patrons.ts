/**
 * One-time setup of the patron agents and the server's admin key.
 *
 *   pnpm --filter @parkwright/chain setup:patrons
 *
 * Signs as the admin account (parkwright.testnet) from ~/.near-credentials, and:
 * 1. Creates p0…p7.parkwright.testnet, each funded for gas, with ONE key: a function-call key that
 *    may only call `settle_day` on the park contract. No full-access key, so a patron's key can never
 *    move NEAR or do anything else — and the contract caps what settle_day can move per park-day.
 * 2. Registers each patron (daily cap) and funds its credit budget.
 * 3. Adds a function-call key to the admin account for the game server, limited to
 *    register_park / set_patron / fund_patrons on the park contract.
 * 4. Deactivates the retired first-generation patrons (p0…p7), whose keys had a lifetime gas allowance.
 * New private keys go to ~/.near-credentials/testnet (never the repo). Idempotent.
 * `--rotate-server-key` replaces the server's admin key (e.g. one created with an allowance).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Near, generateKey } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { ADMIN, CONTRACT, DAY_CAP, NETWORK, PATRONS, RETIRED_PATRONS, RPC, TOP_UP, getPatron } from './index.ts';

const near = new Near({ network: NETWORK, rpcUrl: RPC, keyStore: new FileKeyStore('~/.near-credentials', NETWORK), defaultSignerId: ADMIN });
const credDir = join(homedir(), '.near-credentials', NETWORK);

async function exists(account: string) {
  const r = (await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }),
  }).then((x) => x.json())) as any;
  return !r.error && !!r.result;
}

function saveKey(account: string, publicKey: string, secretKey: string, file = `${account}.json`) {
  mkdirSync(credDir, { recursive: true });
  const path = join(credDir, file);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ account_id: account, public_key: publicKey, private_key: secretKey }), { mode: 0o600 });
  return path;
}

for (const account of PATRONS) {
  if (await exists(account)) {
    console.log(`${account} exists`);
  } else {
    const key = generateKey();
    await near
      .transaction(ADMIN)
      .createAccount(account)
      .transfer(account, '0.3 NEAR')
      // No allowance: the key may spend the account's own (small) NEAR balance on gas. A lifetime allowance
      // would silently stop settlement after a few hundred calls, and a function-call-only account can't be rekeyed.
      .addKey(key.publicKey.toString(), { type: 'functionCall', receiverId: CONTRACT, methodNames: ['settle_day'] })
      .send({ waitUntil: 'FINAL' });
    saveKey(account, key.publicKey.toString(), key.secretKey);
    console.log(`created ${account} (function-call key for settle_day only)`);
  }
  const p = await getPatron(account).catch(() => null);
  if (!p) {
    await near.transaction(ADMIN).functionCall(CONTRACT, 'set_patron', { patron: account, day_cap: String(DAY_CAP), active: true }, { gas: '30 Tgas' }).send({ waitUntil: 'FINAL' });
    console.log(`  registered, cap ${DAY_CAP / 100} CR per park-day`);
  }
}

const unfunded = [];
for (const a of PATRONS) if (BigInt((await getPatron(a))?.balance ?? '0') === 0n) unfunded.push(a);
if (unfunded.length) {
  await near.transaction(ADMIN).functionCall(CONTRACT, 'fund_patrons', { patrons: unfunded, amount: String(TOP_UP) }, { gas: '100 Tgas' }).send({ waitUntil: 'FINAL' });
  console.log(`funded ${unfunded.length} patrons with ${TOP_UP / 100} CR each`);
}

// The server's admin key: only the three admin methods on the park contract, no lifetime allowance.
const serverKeyFile = join(credDir, `${ADMIN}.server-key.json`);
const rotate = process.argv.includes('--rotate-server-key');
if (!existsSync(serverKeyFile) || rotate) {
  const old = existsSync(serverKeyFile) ? JSON.parse(readFileSync(serverKeyFile, 'utf8')).public_key as string : null;
  const key = generateKey();
  let tx = near.transaction(ADMIN).addKey(key.publicKey.toString(), { type: 'functionCall', receiverId: CONTRACT, methodNames: ['register_park', 'set_patron', 'fund_patrons'] });
  if (old) tx = tx.deleteKey(ADMIN, old);
  await tx.send({ waitUntil: 'FINAL' });
  writeFileSync(serverKeyFile, JSON.stringify({ account_id: ADMIN, public_key: key.publicKey.toString(), private_key: key.secretKey }), { mode: 0o600 });
  console.log(`${old ? 'rotated' : 'added'} the server's admin function-call key → ${serverKeyFile}${old ? ' (old key deleted on chain)' : ''}`);
}

for (const old of RETIRED_PATRONS) {
  const p = await getPatron(old).catch(() => null);
  if (p?.active) {
    await near.transaction(ADMIN).functionCall(CONTRACT, 'set_patron', { patron: old, day_cap: p.day_cap, active: false }, { gas: '30 Tgas' }).send({ waitUntil: 'FINAL' });
    console.log(`retired ${old}`);
  }
}

const missing = PATRONS.filter((a) => !existsSync(join(credDir, `${a}.json`)));
if (missing.length) throw new Error(`no local key for ${missing.join(', ')} — these accounts exist on chain but their key files are gone; create new patron accounts`);
const keys = Object.fromEntries(PATRONS.map((a) => [a, JSON.parse(readFileSync(join(credDir, `${a}.json`), 'utf8')).private_key]));
console.log(`\nFor the hosted server (Azure secrets), from ${credDir}:`);
console.log(`  PARK_ADMIN_KEY  = private_key in ${ADMIN}.server-key.json`);
console.log(`  PATRON_KEYS     = JSON map of ${Object.keys(keys).length} patron accounts → private keys`);
console.log('done');
