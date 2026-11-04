/**
 * Meta Graph / Marketing API client. Server-only.
 *
 * Every call takes an already-opened access token from the caller; this module
 * never reads storage, never logs a token and never puts one in a URL (the token
 * goes in the Authorization header). Errors are normalised to MetaApiError, whose
 * message is safe to show to a user or an agent.
 */
import 'server-only';

export const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH_HOST = 'https://graph.facebook.com';
const VERSION_RE = /^v\d{1,2}\.\d$/;

export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.META_GRAPH_VERSION?.trim();
  return v && VERSION_RE.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

export type MetaErrorKind = 'auth' | 'permission' | 'rate_limit' | 'transient' | 'invalid' | 'unknown';

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly kind: MetaErrorKind,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

/** Maps Graph error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling */
export function classifyError(status: number, code?: number): MetaErrorKind {
  if (code === 190 || status === 401) return 'auth';
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return 'permission';
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80004 || status === 429) return 'rate_limit';
  if (code === 1 || code === 2 || status >= 500) return 'transient';
  if (status >= 400) return 'invalid';
  return 'unknown';
}

export type GraphOptions = {
  token: string;
  version?: string;
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown> | FormData;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Paths are `/me/adaccounts`, `/act_123/campaigns`: letters, digits, underscore, slash, dot, dash. */
function assertPath(path: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) throw new MetaApiError('Invalid Graph path.', 'invalid', 400);
  return path;
}

export async function graph<T>(path: string, opts: GraphOptions): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const method = opts.method ?? 'GET';
  const url = new URL(`${GRAPH_HOST}/${opts.version ?? graphVersion()}${assertPath(path)}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.body && !isForm) headers['Content-Type'] = 'application/json';
  // Writes are retried only when the call failed before Meta accepted it, never after a 2xx; reads retry freely.
  const maxAttempts = 1 + (opts.retries ?? (method === 'GET' ? 3 : 1));

  let last: MetaApiError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await f(url, {
        method,
        headers,
        body: opts.body ? (isForm ? (opts.body as FormData) : JSON.stringify(opts.body)) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } };
      if (res.ok) return json as T;
      const code = json.error?.code;
      // Meta's message may quote user input but never a token; we still cap its length.
      const message = (json.error?.message ?? `Meta request failed (${res.status}).`).slice(0, 300);
      last = new MetaApiError(message, classifyError(res.status, code), res.status, code, json.error?.error_subcode);
    } catch (e) {
      last = new MetaApiError(e instanceof Error && e.name === 'TimeoutError' ? 'Meta request timed out.' : 'Could not reach Meta.', 'transient', 0);
    }
    if (!last.retryable || attempt === maxAttempts - 1) throw last;
    await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
  }
  throw last ?? new MetaApiError('Meta request failed.', 'unknown', 0);
}

type Page<T> = { data: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/** Follows cursor pagination to `max` items. */
export async function graphAll<T>(path: string, opts: GraphOptions, max = 200): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const page = await graph<Page<T>>(path, { ...opts, query: { limit: 50, ...opts.query, after } });
    out.push(...page.data);
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after && out.length < max);
  return out.slice(0, max);
}

// ---- Typed reads used by the connection flow ----------------------------------------------------------------------

export type MetaBusiness = { id: string; name: string };
export type MetaAdAccount = { id: string; account_id: string; name: string; currency?: string; account_status?: number };
export type MetaPage = { id: string; name: string };

export const listBusinesses = (o: GraphOptions) => graphAll<MetaBusiness>('/me/businesses', { ...o, query: { fields: 'id,name' } });
export const listAdAccounts = (o: GraphOptions) =>
  graphAll<MetaAdAccount>('/me/adaccounts', { ...o, query: { fields: 'id,account_id,name,currency,account_status' } });
export const listPages = (o: GraphOptions) => graphAll<MetaPage>('/me/accounts', { ...o, query: { fields: 'id,name' } });

/** The permissions this token has actually been granted (status `granted`). */
export async function grantedPermissions(o: GraphOptions): Promise<string[]> {
  const rows = await graphAll<{ permission: string; status: string }>('/me/permissions', o);
  return rows.filter((r) => r.status === 'granted').map((r) => r.permission);
}
