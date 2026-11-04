/**
 * Pure rules for Meta paid ads and Page posts: no I/O, so they are testable and safe to run anywhere.
 * Objective names follow the Marketing API's outcome-based (ODAX) objectives.
 */
import { createHash } from 'node:crypto';

export const OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'sales'] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const OBJECTIVE_API: Record<Objective, string> = {
  awareness: 'OUTCOME_AWARENESS',
  traffic: 'OUTCOME_TRAFFIC',
  engagement: 'OUTCOME_ENGAGEMENT',
  leads: 'OUTCOME_LEADS',
  sales: 'OUTCOME_SALES',
};

/** Optimization goals each objective accepts, first is the default. */
export const GOALS: Record<Objective, string[]> = {
  awareness: ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT'],
  traffic: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH'],
  engagement: ['POST_ENGAGEMENT', 'PAGE_LIKES', 'REACH'],
  leads: ['LEAD_GENERATION', 'QUALITY_LEAD'],
  sales: ['OFFSITE_CONVERSIONS', 'VALUE'],
};

export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'] as const;
export const CTAS = ['LEARN_MORE', 'SIGN_UP', 'APPLY_NOW', 'CONTACT_US', 'GET_QUOTE', 'SHOP_NOW', 'BOOK_TRAVEL', 'DOWNLOAD', 'SUBSCRIBE'] as const;
export const FB_POSITIONS = ['feed', 'right_hand_column', 'marketplace', 'video_feeds', 'story', 'search', 'reels'] as const;

export type Targeting = { countries: string[]; ageMin?: number; ageMax?: number };

export type DraftInput = {
  name: string;
  objective: Objective;
  budgetType: 'daily' | 'lifetime';
  budgetMinor: number;
  currency: string;
  startsAt?: string | null;
  endsAt?: string | null;
  targeting: Targeting;
  placements?: string[];
  optimizationGoal?: string | null;
  bidStrategy?: string | null;
  headline?: string | null;
  primaryText?: string | null;
  description?: string | null;
  cta?: string | null;
  linkUrl?: string | null;
  leadFormId?: string | null;
};

export type SpendPolicy = {
  /** Largest budget one campaign may carry, in minor units, for the budget type. Null: the workspace set none. */
  maxDailyMinor: number | null;
  maxLifetimeMinor: number | null;
  currency: string;
};

/** Returns a list of problems; an empty list means the draft may be created on Meta (still PAUSED). */
export function validateDraft(d: DraftInput, policy: SpendPolicy, now = new Date()): string[] {
  const e: string[] = [];
  if (!d.name.trim()) e.push('Give the campaign a name.');
  if (!OBJECTIVES.includes(d.objective)) e.push('Unsupported objective.');
  if (d.objective === 'sales') e.push('Sales campaigns need a Meta Pixel and conversion event, which are not configured; use traffic or leads.');
  if (!Number.isInteger(d.budgetMinor) || d.budgetMinor <= 0) e.push('The budget must be a positive whole number of the currency\'s smallest unit.');
  if (d.currency.toUpperCase() !== policy.currency.toUpperCase()) e.push(`Budget currency must be ${policy.currency.toUpperCase()}, the workspace currency.`);
  const cap = d.budgetType === 'daily' ? policy.maxDailyMinor : policy.maxLifetimeMinor;
  if (cap !== null && d.budgetMinor > cap) e.push(`The ${d.budgetType} budget exceeds the workspace limit.`);
  if (d.budgetType === 'lifetime' && !d.endsAt) e.push('A lifetime budget needs an end date.');
  const s = d.startsAt ? Date.parse(d.startsAt) : null;
  const en = d.endsAt ? Date.parse(d.endsAt) : null;
  if (s !== null && Number.isNaN(s)) e.push('The start time is not a valid date.');
  if (en !== null && Number.isNaN(en)) e.push('The end time is not a valid date.');
  if (en !== null && !Number.isNaN(en) && en <= now.getTime()) e.push('The end time must be in the future.');
  if (s !== null && en !== null && en <= s) e.push('The end time must be after the start time.');
  if (!d.targeting.countries.length || d.targeting.countries.some((c) => !/^[A-Z]{2}$/.test(c))) e.push('Targeting needs at least one ISO country code such as MY.');
  const { ageMin, ageMax } = d.targeting;
  if (ageMin !== undefined && (ageMin < 18 || ageMin > 65)) e.push('Minimum age must be between 18 and 65.');
  if (ageMax !== undefined && (ageMax < 18 || ageMax > 65)) e.push('Maximum age must be between 18 and 65.');
  if (ageMin !== undefined && ageMax !== undefined && ageMin > ageMax) e.push('Minimum age cannot exceed maximum age.');
  if (d.optimizationGoal && !GOALS[d.objective]?.includes(d.optimizationGoal)) e.push(`${d.optimizationGoal} is not valid for the ${d.objective} objective.`);
  if (d.bidStrategy && !(BID_STRATEGIES as readonly string[]).includes(d.bidStrategy)) e.push('Unsupported bid strategy.');
  for (const p of d.placements ?? []) if (!(FB_POSITIONS as readonly string[]).includes(p)) e.push(`Unsupported placement: ${p}.`);
  if (d.cta && !(CTAS as readonly string[]).includes(d.cta)) e.push('Unsupported call to action.');
  if (d.linkUrl && !isHttpsUrl(d.linkUrl)) e.push('The landing page URL must be a valid https URL.');
  if (d.headline && d.headline.length > 40) e.push('Keep the headline to 40 characters.');
  if (d.primaryText && d.primaryText.length > 500) e.push('Keep the primary text to 500 characters.');
  if (d.objective === 'leads' && !d.leadFormId && !d.linkUrl) e.push('A leads ad needs a lead form or a landing page URL.');
  if (d.objective !== 'leads' && !d.linkUrl) e.push('This objective needs a landing page URL.');
  return e;
}

export function isHttpsUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && !!p.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Page post media must be https and, for photos, an image extension or a known image host path. */
export function validatePost(i: { message?: string | null; link?: string | null; mediaUrls?: string[]; scheduledAt?: string | null }, now = new Date()): string[] {
  const e: string[] = [];
  const media = i.mediaUrls ?? [];
  if (!i.message?.trim() && !i.link && media.length === 0) e.push('A post needs text, a link or an image.');
  if ((i.message?.length ?? 0) > 5000) e.push('The post text is too long.');
  if (i.link && !isHttpsUrl(i.link)) e.push('The link must be a valid https URL.');
  if (i.link && media.length) e.push('A post can carry a link or images, not both.');
  if (media.length > 10) e.push('At most 10 images per post.');
  for (const m of media) if (!isHttpsUrl(m)) e.push('Image URLs must be https.');
  if (i.scheduledAt) {
    const t = Date.parse(i.scheduledAt);
    if (Number.isNaN(t)) e.push('The scheduled time is not a valid date.');
    else if (t < now.getTime() + 60_000) e.push('The scheduled time must be at least a minute in the future.');
    else if (t > now.getTime() + 180 * 86_400_000) e.push('Schedule no more than 180 days ahead.');
  }
  return e;
}

export function postKind(i: { link?: string | null; mediaUrls?: string[] }): 'text' | 'link' | 'image' | 'multi_image' {
  const n = i.mediaUrls?.length ?? 0;
  return n > 1 ? 'multi_image' : n === 1 ? 'image' : i.link ? 'link' : 'text';
}

/** Every setting that changes what runs or what it costs. Approval is bound to this hash. */
export function configHash(d: Record<string, unknown>): string {
  const keys = ['ad_account_id', 'page_id', 'objective', 'budget_type', 'budget_minor', 'currency', 'starts_at', 'ends_at', 'targeting', 'placements',
    'optimization_goal', 'bid_strategy', 'headline', 'primary_text', 'description', 'cta', 'link_url', 'lead_form_id', 'image_url', 'meta_ad_id'];
  const norm = (v: unknown): unknown => v === undefined ? null : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(norm)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  const body = JSON.stringify(keys.map((k) => [k, k === 'starts_at' || k === 'ends_at' ? (d[k] ? new Date(String(d[k])).toISOString() : null) : norm(d[k])]));
  return createHash('sha256').update(body).digest('hex');
}

/** Exponential backoff with a ceiling: 1, 2, 4, 8 minutes... up to 30. */
export const backoffMs = (attempt: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));

/** Wall-clock `YYYY-MM-DDTHH:mm` in an IANA zone to a UTC instant. Used so "tomorrow 9am" means 9am where the user is. */
export function zonedToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const at = (t: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
    };
    let t = guess - at(guess);
    t = guess - at(t);
    return new Date(t);
  } catch {
    return null;
  }
}
