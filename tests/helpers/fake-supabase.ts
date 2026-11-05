/** A tiny in-memory stand-in for the parts of the Supabase client the Meta code uses. Not a general emulator. */
type Row = Record<string, unknown>;
export type Fake = ReturnType<typeof fakeSupabase>;

/** What the real tables fill in when an insert leaves a column out. */
const DB_DEFAULTS: Record<string, Row> = {
  meta_page_posts: { status: 'draft', attempts: 0, media_urls: [] },
  meta_ad_drafts: { status: 'draft', image_status: 'pending', placements: [] },
  meta_jobs: { status: 'pending', attempts: 0, max_attempts: 5 },
};

export function fakeSupabase(seed: Record<string, Row[]> = {}, uniques: Record<string, string[][]> = {}, defaults: Record<string, Row> = DB_DEFAULTS) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  let seq = 0;
  const table = (n: string) => (tables[n] ??= []);

  function builder(name: string) {
    let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    const filters: ((r: Row) => boolean)[] = [];
    let wantRows = false;
    let limit = Infinity;
    const run = (): { data: unknown; error: { code: string } | null } => {
      const t = table(name);
      if (mode === 'insert') {
        const row: Row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, created_at: new Date().toISOString(), ...(defaults[name] ?? {}), ...payload };
        for (const cols of uniques[name] ?? []) if (t.some((r) => cols.every((c) => r[c] === row[c] && row[c] != null))) return { data: null, error: { code: '23505' } };
        t.push(row);
        return { data: [row], error: null };
      }
      const hit = t.filter((r) => filters.every((f) => f(r)));
      if (mode === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
      if (mode === 'delete') { tables[name] = t.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
      return { data: hit.slice(0, limit), error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select() { wantRows = true; return b; },
      insert(p: Row) { mode = 'insert'; payload = p; return b; },
      upsert(p: Row) { mode = 'insert'; payload = p; return b; },
      update(p: Row) { mode = 'update'; payload = p; return b; },
      delete() { mode = 'delete'; return b; },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      ilike(c: string, v: string) { filters.push((r) => String(r[c] ?? '').toLowerCase() === v.toLowerCase()); return b; },
      gt() { return b; }, order() { return b; },
      gte(c: string, v: string) { filters.push((r) => String(r[c] ?? '') >= v); return b; },
      limit(n: number) { limit = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: ((r.data as Row[]) ?? [])[0] ?? null, error: r.error }); },
      single() { const r = run(); const row = ((r.data as Row[]) ?? [])[0]; return Promise.resolve({ data: row ?? null, error: r.error ?? (row ? null : { code: 'PGRST116' }) }); },
      then(res: (v: unknown) => unknown) { void wantRows; return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tables, from: builder, rpc: async (): Promise<{ data: unknown; error: null }> => ({ data: [], error: null }) } as any;
}
