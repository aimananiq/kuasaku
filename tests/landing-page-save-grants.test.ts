import { describe, expect, it, vi } from 'vitest';
import { createSharedTools, type SharedToolContext } from '@/lib/ai/shared-tools';

vi.mock('server-only', () => ({}));

/** The columns `authenticated` may write on crm_landing_pages (supabase/migrations 20261104090000 + 20261114090000). */
const INSERT_GRANT = ['org_id', 'name', 'headline', 'subheadline', 'body', 'button_label', 'form_id', 'status', 'created_by', 'chat_enabled'];
const UPDATE_GRANT = ['name', 'headline', 'subheadline', 'body', 'button_label', 'form_id', 'status', 'updated_at', 'chat_enabled'];

/** Behaves like Postgres column grants: writing a column outside the grant is "permission denied". */
function grantedClient() {
  const calls: { op: 'insert' | 'update'; keys: string[] }[] = [];
  const denied = { message: 'permission denied for table crm_landing_pages' };
  const check = (op: 'insert' | 'update', row: Record<string, unknown>, grant: string[]) => {
    const keys = Object.keys(row);
    calls.push({ op, keys });
    return keys.every((k) => grant.includes(k)) ? null : denied;
  };
  const client = {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => { const error = check('insert', row, INSERT_GRANT); return { data: error ? null : { id: 'new-page' }, error }; } }) }),
      update: (row: Record<string, unknown>) => ({ eq: () => ({ eq: async () => ({ error: check('update', row, UPDATE_GRANT) }) }) }),
    }),
  };
  return { client: client as never, calls };
}

const ctx = (client: never): SharedToolContext => ({ agent: 'jebat', client, orgId: 'o1', userId: 'u1', canWrite: true });
const input = { name: 'YLP 2.0', headline: 'Jadilah Pensyarah', subheadline: 'Mohon sekarang', body: 'Isi page', status: 'draft' as const };
const run = (tools: ReturnType<typeof createSharedTools>, i: object) =>
  (tools.save_landing_page as unknown as { execute: (i: object, o: object) => Promise<{ ok: boolean; error?: string; page_id?: string }> }).execute(i, { toolCallId: 't', messages: [] });

describe('save_landing_page respects the table\'s column grants', () => {
  it('creates a page (org_id and created_by are insertable)', async () => {
    const { client } = grantedClient();
    expect(await run(createSharedTools(ctx(client)), input)).toMatchObject({ ok: true, page_id: 'new-page' });
  });
  it('updates an existing page without sending org_id or created_by', async () => {
    const { client, calls } = grantedClient();
    const res = await run(createSharedTools(ctx(client)), { ...input, page_id: '11111111-1111-4111-8111-111111111111' });
    expect(res).toMatchObject({ ok: true });
    const update = calls.find((c) => c.op === 'update')!;
    expect(update.keys).not.toContain('org_id');
    expect(update.keys).not.toContain('created_by');
  });
});
