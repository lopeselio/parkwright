// /api/health's `gas` field: which NEAR signers (admin, patrons) are low on gas money.
// Balances are read over RPC at most once per 10 minutes, and a health check never waits long for them.
export interface GasLow { account: string; near: string }
export interface GasStatus { low: GasLow[]; unread: string[]; checkedAt: number | null; error?: string }
type Read = () => Promise<{ low: GasLow[]; errors: { account: string }[] }>;

export class GasWatch {
  private last: GasStatus | null = null;
  private at = -Infinity;
  private inFlight: Promise<GasStatus> | null = null;

  constructor(private read: Read, private ttlMs = 600_000, private waitMs = 3_000, private now = Date.now) {}

  /** The cached status; refreshes it when stale, waiting at most `waitMs` before answering with the old one. */
  async status(): Promise<GasStatus> {
    if (this.last && this.now() - this.at < this.ttlMs) return this.last;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), this.waitMs); });
    const fresh = await Promise.race([this.refresh(), late]).finally(() => clearTimeout(timer));
    return fresh ?? this.last ?? { low: [], unread: [], checkedAt: null, error: 'checking' };
  }

  private refresh(): Promise<GasStatus> {
    this.inFlight ??= this.read()
      .then((r) => ({ low: r.low.map(({ account, near }) => ({ account, near })), unread: r.errors.map((e) => e.account), checkedAt: this.now() }))
      .catch((e: Error): GasStatus => ({ low: this.last?.low ?? [], unread: [], checkedAt: this.last?.checkedAt ?? null, error: e.message }))
      .then((s) => { this.last = s; this.at = this.now(); return s; })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
