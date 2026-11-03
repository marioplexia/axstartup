import pg from 'pg';

/** Un solo LISTEN por proceso; reparte avisos a las conexiones SSE del grupo correspondiente. */
export class EventHub {
  private client?: pg.Client;
  private subs = new Map<string, Set<() => void>>();
  private starting?: Promise<void>;

  private async start() {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    c.on('notification', m => {
      try { const { group_id } = JSON.parse(m.payload ?? '{}'); this.subs.get(group_id)?.forEach(f => f()); } catch { /* aviso mal formado */ }
    });
    c.on('error', () => { this.client = undefined; this.starting = undefined; });
    await c.connect();
    await c.query('listen axai_events');
    this.client = c;
  }

  async subscribe(groupId: string, fn: () => void): Promise<() => void> {
    if (!this.client) await (this.starting ??= this.start());
    if (!this.subs.has(groupId)) this.subs.set(groupId, new Set());
    this.subs.get(groupId)!.add(fn);
    return () => { this.subs.get(groupId)?.delete(fn); };
  }

  async close() { this.subs.clear(); const c = this.client; this.client = undefined; this.starting = undefined; await c?.end().catch(() => {}); }
}
