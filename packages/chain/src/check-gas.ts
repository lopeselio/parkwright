// `pnpm check:gas`: print every signer's NEAR balance. Exit 1 if any is below GAS_MIN_NEAR
// (default 0.1), 2 if a balance couldn't be read, 0 otherwise. Read-only; needs no keys.
import { gasReport, gasTable } from './gas.ts';

const report = await gasReport();
console.log(gasTable(report));
console.log();
if (report.low.length) {
  console.log(`${report.low.length} account(s) below ${report.threshold} NEAR: ${report.low.map((r) => r.account).join(', ')}. Send them testnet NEAR so they can keep paying gas.`);
  process.exit(1);
}
if (report.errors.length) {
  console.log(`couldn't read ${report.errors.length} balance(s); try again or set NEAR_RPC.`);
  process.exit(2);
}
console.log(`all ${report.rows.length} accounts have at least ${report.threshold} NEAR.`);
