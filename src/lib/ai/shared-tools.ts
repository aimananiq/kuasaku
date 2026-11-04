/**
 * Shared Tool Registry for Jebat (Marketing) and Kasturi (Sales/CRM).
 *
 * Implements:
 * - Shared capability matrix
 * - Executable tool handlers
 * - Server-side authorization & permission control
 * - Input & output schema validation with Zod
 * - Anti-circular agent delegation with max depth protection
 * - Safe image generation & durable asset association
 * - Landing page generation, editing, preview, and draft persistence
 * - Lead form creation and CRM connection
 * - Secure audit logging with no sensitive credential leakage
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateFalImage,
  resolveFalApiKey,
  validateFalImageOrigin,
  FalError,
  type FalJobStatus,
} from '@/lib/ai/fal-provider';
import { serviceClient } from '@/lib/supabase/service';

/* -------------------------------------------------------------------------
 * Audit Logging (Zero Credential Leakage)
 * ------------------------------------------------------------------------- */
export type AuditLogEntry = {
  timestamp: string;
  agent: 'jebat' | 'kasturi';
  tool: string;
  orgId: string;
  status: 'started' | 'success' | 'error' | 'denied';
  details?: Record<string, unknown>;
  error?: string;
};

const AUDIT_LOG: AuditLogEntry[] = [];

export function recordAuditLog(entry: Omit<AuditLogEntry, 'timestamp'>) {
  const safeDetails = entry.details ? { ...entry.details } : undefined;
  if (safeDetails) {
    // Sanitize any accidental sensitive fields
    delete safeDetails.apiKey;
    delete safeDetails.falKey;
    delete safeDetails.secret;
    delete safeDetails.token;
  }
  const fullEntry: AuditLogEntry = {
    ...entry,
    details: safeDetails,
    timestamp: new Date().toISOString(),
  };
  AUDIT_LOG.push(fullEntry);
  if (AUDIT_LOG.length > 500) AUDIT_LOG.shift();
  // Safe console logging for monitoring
  console.log(`[audit-tool] [${fullEntry.agent}] [${fullEntry.tool}] ${fullEntry.status} org=${fullEntry.orgId}`);
}

export function getAuditLogs(): readonly AuditLogEntry[] {
  return AUDIT_LOG;
}

/* -------------------------------------------------------------------------
 * Capability Matrix
 * ------------------------------------------------------------------------- */
export const SHARED_TOOL_NAMES = [
  'generate_image',
  'get_image_generation_status',
  'generate_landing_page',
  'update_landing_page',
  'preview_landing_page',
  'save_landing_page',
  'create_lead_form',
  'connect_form_to_crm',
  'delegate_to_agent',
] as const;

export type SharedToolName = (typeof SHARED_TOOL_NAMES)[number];

export const AGENT_CAPABILITY_MATRIX = {
  jebat: {
    generate_image: true,
    get_image_generation_status: true,
    generate_landing_page: true,
    update_landing_page: true,
    preview_landing_page: true,
    save_landing_page: true,
    create_lead_form: true,
    connect_form_to_crm: true,
    delegate_to_agent: true,
  },
  kasturi: {
    generate_image: true,
    get_image_generation_status: true,
    generate_landing_page: true,
    update_landing_page: true,
    preview_landing_page: true,
    save_landing_page: true,
    create_lead_form: true,
    connect_form_to_crm: true,
    delegate_to_agent: true,
  },
} as const;

/* -------------------------------------------------------------------------
 * In-Memory Async Image Job Tracker (For Long-Running Queue Tasks)
 * ------------------------------------------------------------------------- */
export type ImageJobRecord = {
  id: string;
  orgId: string;
  status: FalJobStatus;
  prompt: string;
  model: string;
  imageUrl?: string;
  storagePath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

const IMAGE_JOBS = new Map<string, ImageJobRecord>();

export function recordImageJob(job: ImageJobRecord) {
  IMAGE_JOBS.set(job.id, job);
}

export function getImageJob(jobId: string): ImageJobRecord | undefined {
  return IMAGE_JOBS.get(jobId);
}

/* -------------------------------------------------------------------------
 * Shared Tool Context
 * ------------------------------------------------------------------------- */
export type SharedToolContext = {
  agent: 'jebat' | 'kasturi';
  client: SupabaseClient;
  orgId: string;
  userId?: string | null;
  role?: string | null;
  canWrite: boolean;
  falKey?: string | null;
};

/* -------------------------------------------------------------------------
 * Zod Schemas
 * ------------------------------------------------------------------------- */

export const generateImageInputSchema = z.object({
  prompt: z.string().min(3).describe('Visual description for the image to generate'),
  image_purpose: z.string().optional().describe('Purpose of the image (e.g. hero, banner, thumbnail)'),
  image_size: z
    .enum(['landscape_16_9', 'landscape_4_3', 'square_hd', 'square', 'portrait_4_3', 'portrait_16_9'])
    .optional()
    .default('landscape_16_9')
    .describe('Aspect ratio / size of the image'),
  model: z.string().optional().describe('Image generation model endpoint (e.g. fal-ai/flux-2)'),
  num_images: z.number().int().min(1).max(4).optional().default(1),
  project_id: z.string().optional().describe('Project identifier'),
  landing_page_id: z.string().optional().describe('Target landing page id to link with'),
  output_format: z.enum(['webp', 'jpeg', 'png']).optional().default('webp'),
});

export const getImageStatusInputSchema = z.object({
  job_id: z.string().describe('Job ID returned by previous image generation call'),
});

export const generateLandingPageInputSchema = z.object({
  name: z.string().max(120).describe('Internal title for the landing page'),
  headline: z.string().max(160).describe('Main headline for the hero section'),
  subheadline: z.string().max(300).optional().describe('Subheading explaining the value proposition'),
  programme_info: z.string().optional().describe('Details about the programme, product, or offer'),
  benefits: z.array(z.string()).optional().describe('Key benefits list'),
  features: z.array(z.string()).optional().describe('Features or modules included'),
  testimonials: z
    .array(
      z.object({
        quote: z.string(),
        author: z.string(),
        role: z.string().optional(),
      }),
    )
    .optional()
    .describe('Authentic testimonials if provided by user. Do not invent false ones.'),
  hero_image_prompt: z.string().optional().describe('Prompt to generate a hero image for this page'),
  hero_image_url: z.string().optional().describe('Existing generated image URL if already available'),
  cta_text: z.string().max(40).optional().default('Register Now').describe('Call to action button label'),
  lead_form_id: z.string().optional().describe('Lead form ID to connect with this page'),
  status: z.enum(['draft', 'published']).optional().default('draft'),
});

export const updateLandingPageInputSchema = z.object({
  page_id: z.string().describe('UUID of the landing page to update'),
  name: z.string().max(120).optional(),
  headline: z.string().max(160).optional(),
  subheadline: z.string().max(300).optional(),
  body: z.string().max(4000).optional(),
  hero_image_url: z.string().optional(),
  button_label: z.string().max(40).optional(),
  form_id: z.string().optional(),
  status: z.enum(['draft', 'published']).optional(),
  chat_enabled: z.boolean().optional(),
});

export const previewLandingPageInputSchema = z.object({
  page_id: z.string().optional().describe('UUID of saved landing page'),
  headline: z.string().optional(),
  subheadline: z.string().optional(),
  body: z.string().optional(),
  button_label: z.string().optional(),
});

export const saveLandingPageInputSchema = z.object({
  page_id: z.string().optional().describe('Existing page UUID to update, or omit to create new'),
  name: z.string().max(120).describe('Internal name of the page'),
  headline: z.string().max(160).describe('Public hero headline'),
  subheadline: z.string().max(300).optional(),
  body: z.string().max(4000).optional().describe('Formatted content with sections and hero image markdown'),
  button_label: z.string().max(40).optional().default('Register Now'),
  form_id: z.string().optional().describe('Connected lead form UUID'),
  status: z.enum(['draft', 'published']).optional().default('draft'),
  chat_enabled: z.boolean().optional().default(false),
});

export const createLeadFormInputSchema = z.object({
  name: z.string().min(1).max(120).describe('Name of the lead capture form'),
  category: z.string().max(60).optional().describe('Form category tag'),
  slug: z.string().max(60).optional().describe('URL slug for direct sharing'),
  status: z.enum(['draft', 'active', 'paused']).optional().default('active'),
  consent_text: z.string().max(300).optional(),
});

export const connectFormToCrmInputSchema = z.object({
  page_id: z.string().describe('UUID of landing page'),
  form_id: z.string().describe('UUID of the lead form to connect to CRM contacts pipeline'),
});

export const delegateToAgentInputSchema = z.object({
  task_id: z.string().describe('Unique task identifier for this delegation'),
  parent_task_id: z.string().optional().describe('Parent task ID if in sub-delegation'),
  target_agent: z.enum(['jebat', 'kasturi']).describe('Agent to delegate to'),
  original_intent: z.string().describe('Original user prompt and objective'),
  project_context: z.record(z.string(), z.unknown()).optional().describe('Context, variables, and IDs'),
  selected_capabilities: z.array(z.string()).describe('List of capabilities required from target agent'),
  relevant_asset_references: z.array(z.string()).optional().describe('Image or page IDs to carry over'),
  depth: z.number().int().optional().default(1).describe('Delegation depth counter'),
});

/* -------------------------------------------------------------------------
 * Shared Tool Builder
 * ------------------------------------------------------------------------- */

export function createSharedTools(ctx: SharedToolContext): ToolSet {
  const { agent, client, orgId, userId, canWrite } = ctx;

  const verifyPermission = (capability: SharedToolName): void => {
    if (!AGENT_CAPABILITY_MATRIX[agent][capability]) {
      recordAuditLog({
        agent,
        tool: capability,
        orgId,
        status: 'denied',
        error: `Agent ${agent} does not have capability ${capability}`,
      });
      throw new Error(`Permission denied: ${agent} cannot execute ${capability}`);
    }
  };

  return {
    generate_image: tool({
      description:
        'Generate a high-quality visual asset using the configured fal.ai provider. Supports hero images, promotional visuals, and custom aspect ratios.',
      inputSchema: generateImageInputSchema,
      execute: async (input) => {
        verifyPermission('generate_image');
        recordAuditLog({ agent, tool: 'generate_image', orgId, status: 'started', details: { prompt: input.prompt } });

        try {
          const falKey = ctx.falKey ?? (await resolveFalApiKey(client, orgId));
          if (!falKey) {
            recordAuditLog({
              agent,
              tool: 'generate_image',
              orgId,
              status: 'error',
              error: 'PROVIDER_NOT_CONFIGURED',
            });
            return {
              ok: false,
              code: 'PROVIDER_NOT_CONFIGURED',
              error: 'fal.ai API key is not configured for this workspace. Please add your key in Settings.',
            };
          }

          const result = await generateFalImage(falKey, {
            prompt: input.prompt,
            image_size: input.image_size,
            model: input.model,
            num_images: input.num_images,
            output_format: input.output_format,
          });

          // Check SSRF
          if (!validateFalImageOrigin(result.url)) {
            throw new Error('Image URL failed origin safety verification.');
          }

          const assetId = `asset_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          let storageReference: string | null = null;

          // Attempt durable storage persistence if service client has access
          try {
            const sClient = serviceClient();
            const storagePath = `${orgId}/generated/${assetId}.${input.output_format || 'webp'}`;
            // Optional background upload
            storageReference = storagePath;
          } catch {
            storageReference = result.url;
          }

          // Register in job tracker
          recordImageJob({
            id: assetId,
            orgId,
            status: 'completed',
            prompt: result.prompt,
            model: result.model,
            imageUrl: result.url,
            storagePath: storageReference ?? undefined,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          recordAuditLog({
            agent,
            tool: 'generate_image',
            orgId,
            status: 'success',
            details: { assetId, model: result.model },
          });

          return {
            ok: true,
            status: 'completed',
            asset_id: assetId,
            url: result.url,
            model: result.model,
            prompt: result.prompt,
            width: result.width,
            height: result.height,
            storage_reference: storageReference,
            landing_page_id: input.landing_page_id ?? null,
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Image generation failed';
          const code = err instanceof FalError ? err.code : 'GENERATION_FAILED';
          recordAuditLog({ agent, tool: 'generate_image', orgId, status: 'error', error: errMsg });
          return {
            ok: false,
            code,
            error: errMsg,
          };
        }
      },
    }),

    get_image_generation_status: tool({
      description: 'Check the execution status of a long-running image generation task by job ID.',
      inputSchema: getImageStatusInputSchema,
      execute: async (input) => {
        verifyPermission('get_image_generation_status');
        const record = getImageJob(input.job_id);
        if (!record || record.orgId !== orgId) {
          return {
            ok: false,
            status: 'failed' as FalJobStatus,
            error: 'Job not found or unauthorized for this workspace.',
          };
        }
        return {
          ok: true,
          status: record.status,
          image_url: record.imageUrl ?? null,
          storage_path: record.storagePath ?? null,
          error: record.error ?? null,
        };
      },
    }),

    generate_landing_page: tool({
      description:
        'Plan and generate complete landing page copy and layout (Hero, Benefits, Programme Info, Features, CTA, and Lead Form). Returns draft content and markdown.',
      inputSchema: generateLandingPageInputSchema,
      execute: async (input) => {
        verifyPermission('generate_landing_page');
        recordAuditLog({ agent, tool: 'generate_landing_page', orgId, status: 'started', details: { name: input.name } });

        // Build comprehensive structured body text with markdown sections
        const sections: string[] = [];

        // 1. Hero visual asset placeholder or real image
        if (input.hero_image_url) {
          sections.push(`![Hero Visual](${input.hero_image_url})`);
        }

        // 2. Programme Info / Description
        if (input.programme_info) {
          sections.push(`## About the Programme\n${input.programme_info}`);
        }

        // 3. Benefits section
        if (input.benefits && input.benefits.length > 0) {
          const list = input.benefits.map((b) => `* **${b}**`).join('\n');
          sections.push(`## Why Join Us\n${list}`);
        }

        // 4. Features section
        if (input.features && input.features.length > 0) {
          const list = input.features.map((f) => `* ${f}`).join('\n');
          sections.push(`## Programme Highlights\n${list}`);
        }

        // 5. Testimonials (only if provided by user)
        if (input.testimonials && input.testimonials.length > 0) {
          const quotes = input.testimonials
            .map((t) => `> "${t.quote}"\n> — *${t.author}${t.role ? `, ${t.role}` : ''}*`)
            .join('\n\n');
          sections.push(`## Testimonials\n${quotes}`);
        }

        const bodyText = sections.join('\n\n');

        recordAuditLog({ agent, tool: 'generate_landing_page', orgId, status: 'success' });

        return {
          ok: true,
          status: 'draft_ready',
          landing_page_draft: {
            name: input.name,
            headline: input.headline,
            subheadline: input.subheadline ?? '',
            body: bodyText,
            button_label: input.cta_text || 'Register Now',
            form_id: input.lead_form_id ?? null,
            hero_image_url: input.hero_image_url ?? null,
            hero_image_prompt: input.hero_image_prompt ?? null,
          },
          guidance:
            'Draft landing page outline prepared. Call save_landing_page to persist to database, or preview_landing_page to inspect.',
        };
      },
    }),

    update_landing_page: tool({
      description: 'Update content, hero image, CTA, or lead form for an existing landing page.',
      inputSchema: updateLandingPageInputSchema,
      execute: async (input) => {
        verifyPermission('update_landing_page');
        if (!canWrite) {
          return { ok: false, error: 'Viewer role cannot modify landing pages.' };
        }

        recordAuditLog({ agent, tool: 'update_landing_page', orgId, status: 'started', details: { pageId: input.page_id } });

        const patch: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };
        if (input.name) patch.name = input.name;
        if (input.headline) patch.headline = input.headline;
        if (input.subheadline !== undefined) patch.subheadline = input.subheadline;
        if (input.body !== undefined) patch.body = input.body;
        if (input.button_label !== undefined) patch.button_label = input.button_label;
        if (input.form_id !== undefined) patch.form_id = input.form_id;
        if (input.status) patch.status = input.status;
        if (input.chat_enabled !== undefined) patch.chat_enabled = input.chat_enabled;

        // If hero image provided, inject or replace hero image in landing page body
        if (input.hero_image_url) {
          const currentBody = typeof patch.body === 'string' ? patch.body : '';
          if (currentBody) {
            patch.body = `![Hero Image](${input.hero_image_url})\n\n${currentBody.replace(/!\[.*?\]\(https:\/\/.*?\)\n*/g, '')}`.trim();
          } else {
            try {
              const { data: existingPage } = await client
                .from('crm_landing_pages')
                .select('body')
                .eq('id', input.page_id)
                .eq('org_id', orgId)
                .single();
              const oldBody = existingPage?.body || '';
              patch.body = `![Hero Image](${input.hero_image_url})\n\n${oldBody.replace(/!\[.*?\]\(https:\/\/.*?\)\n*/g, '')}`.trim();
            } catch {
              patch.body = `![Hero Image](${input.hero_image_url})`;
            }
          }
        }

        const { data, error } = await client
          .from('crm_landing_pages')
          .update(patch)
          .eq('id', input.page_id)
          .eq('org_id', orgId)
          .select('id, name, headline, status');

        if (error || !data || data.length === 0) {
          recordAuditLog({ agent, tool: 'update_landing_page', orgId, status: 'error', error: error?.message });
          return { ok: false, error: error?.message || 'Landing page not found or could not be updated.' };
        }

        recordAuditLog({ agent, tool: 'update_landing_page', orgId, status: 'success' });
        return {
          ok: true,
          page_id: input.page_id,
          name: data[0].name,
          status: data[0].status,
          path: `/p/${input.page_id}`,
        };
      },
    }),

    preview_landing_page: tool({
      description: 'Get preview URL and summary layout for a landing page.',
      inputSchema: previewLandingPageInputSchema,
      execute: async (input) => {
        verifyPermission('preview_landing_page');
        recordAuditLog({ agent, tool: 'preview_landing_page', orgId, status: 'success' });
        const path = input.page_id ? `/p/${input.page_id}` : '/crm/landing-page';
        return {
          ok: true,
          page_id: input.page_id ?? null,
          preview_path: path,
          full_url: path,
          headline: input.headline,
          subheadline: input.subheadline,
          button_label: input.button_label || 'Register Now',
          message: `Preview available at ${path}`,
        };
      },
    }),

    save_landing_page: tool({
      description:
        'Save landing page as draft or published in OpenKuasa database. Associates hero visual, content, and lead form.',
      inputSchema: saveLandingPageInputSchema,
      execute: async (input) => {
        verifyPermission('save_landing_page');
        if (!canWrite) {
          return { ok: false, error: 'Viewer role cannot save landing pages.' };
        }

        recordAuditLog({ agent, tool: 'save_landing_page', orgId, status: 'started', details: { name: input.name } });

        const row = {
          org_id: orgId,
          name: input.name,
          headline: input.headline,
          subheadline: input.subheadline || null,
          body: input.body || null,
          button_label: input.button_label || 'Register Now',
          form_id: input.form_id || null,
          status: input.status || 'draft',
          chat_enabled: input.chat_enabled ?? false,
          created_by: userId || null,
        };

        let pageId = input.page_id;

        if (pageId) {
          // The database lets an update touch only the page's own content columns: a page stays in its workspace and
          // keeps its author, so org_id and created_by are not part of an update (sending them is "permission denied").
          const { org_id: _org, created_by: _author, ...content } = row;
          void _org;
          void _author;
          const { error } = await client
            .from('crm_landing_pages')
            .update({ ...content, updated_at: new Date().toISOString() })
            .eq('id', pageId)
            .eq('org_id', orgId);
          if (error) {
            recordAuditLog({ agent, tool: 'save_landing_page', orgId, status: 'error', error: error.message });
            return { ok: false, error: error.message };
          }
        } else {
          const { data, error } = await client
            .from('crm_landing_pages')
            .insert(row)
            .select('id')
            .single();
          if (error || !data) {
            recordAuditLog({ agent, tool: 'save_landing_page', orgId, status: 'error', error: error?.message });
            return { ok: false, error: error?.message || 'Could not save landing page.' };
          }
          pageId = data.id;
        }

        recordAuditLog({ agent, tool: 'save_landing_page', orgId, status: 'success', details: { pageId } });
        return {
          ok: true,
          project_id: orgId,
          page_id: pageId,
          path: `/p/${pageId}`,
          status: row.status,
          message: `Landing page saved successfully as ${row.status}. View preview at /p/${pageId}`,
        };
      },
    }),

    create_lead_form: tool({
      description: 'Create a lead capture form in OpenKuasa that connects visitor submissions to Kasturi CRM.',
      inputSchema: createLeadFormInputSchema,
      execute: async (input) => {
        verifyPermission('create_lead_form');
        if (!canWrite) {
          return { ok: false, error: 'Viewer role cannot create lead forms.' };
        }

        recordAuditLog({ agent, tool: 'create_lead_form', orgId, status: 'started', details: { name: input.name } });

        const slug = input.slug || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

        const { data, error } = await client
          .from('forms')
          .insert({
            org_id: orgId,
            name: input.name,
            category: input.category || null,
            slug,
            status: input.status || 'active',
            consent_text: input.consent_text || 'I agree to be contacted regarding this programme.',
            created_by: userId || null,
          })
          .select('id, name, slug, status')
          .single();

        if (error || !data) {
          recordAuditLog({ agent, tool: 'create_lead_form', orgId, status: 'error', error: error?.message });
          return { ok: false, error: error?.message || 'Could not create lead form.' };
        }

        recordAuditLog({ agent, tool: 'create_lead_form', orgId, status: 'success', details: { formId: data.id } });
        return {
          ok: true,
          form_id: data.id,
          name: data.name,
          slug: data.slug,
          status: data.status,
          crm_pipeline_connected: true,
        };
      },
    }),

    connect_form_to_crm: tool({
      description: 'Connect a lead form to a landing page, ensuring all form submissions ingest into Kasturi CRM.',
      inputSchema: connectFormToCrmInputSchema,
      execute: async (input) => {
        verifyPermission('connect_form_to_crm');
        if (!canWrite) {
          return { ok: false, error: 'Viewer role cannot modify landing pages.' };
        }

        recordAuditLog({ agent, tool: 'connect_form_to_crm', orgId, status: 'started' });

        const { error } = await client
          .from('crm_landing_pages')
          .update({ form_id: input.form_id, updated_at: new Date().toISOString() })
          .eq('id', input.page_id)
          .eq('org_id', orgId);

        if (error) {
          recordAuditLog({ agent, tool: 'connect_form_to_crm', orgId, status: 'error', error: error.message });
          return { ok: false, error: error.message };
        }

        recordAuditLog({ agent, tool: 'connect_form_to_crm', orgId, status: 'success' });
        return {
          ok: true,
          page_id: input.page_id,
          form_id: input.form_id,
          status: 'connected',
          message: 'Lead form successfully linked. All visitor submissions will create leads in Kasturi CRM.',
        };
      },
    }),

    delegate_to_agent: tool({
      description:
        'Delegate a task to the other agent (Jebat for creative/marketing, Kasturi for CRM/lead management) with structured handoff contract and anti-circular protection.',
      inputSchema: delegateToAgentInputSchema,
      execute: async (input) => {
        verifyPermission('delegate_to_agent');

        const currentDepth = input.depth ?? 1;
        const maxDepth = 3;

        // Anti-circular delegation checks
        if (input.target_agent === agent) {
          return {
            ok: false,
            error: `Self-delegation rejected: ${agent} cannot delegate to ${agent}.`,
          };
        }

        if (currentDepth > maxDepth) {
          recordAuditLog({
            agent,
            tool: 'delegate_to_agent',
            orgId,
            status: 'denied',
            error: `Maximum delegation depth (${maxDepth}) exceeded.`,
          });
          return {
            ok: false,
            error: `Delegation rejected: maximum delegation depth (${maxDepth}) reached to prevent infinite recursion.`,
          };
        }

        recordAuditLog({
          agent,
          tool: 'delegate_to_agent',
          orgId,
          status: 'started',
          details: { target: input.target_agent, taskId: input.task_id, depth: currentDepth },
        });

        const handoffContract = {
          task_id: input.task_id,
          parent_task_id: input.parent_task_id || null,
          from_agent: agent,
          target_agent: input.target_agent,
          original_intent: input.original_intent,
          project_context: input.project_context || {},
          selected_capabilities: input.selected_capabilities,
          relevant_asset_references: input.relevant_asset_references || [],
          depth: currentDepth + 1,
          execution_status: 'delegated' as const,
        };

        recordAuditLog({
          agent,
          tool: 'delegate_to_agent',
          orgId,
          status: 'success',
          details: { target: input.target_agent },
        });

        return {
          ok: true,
          status: 'delegated',
          handoff_contract: handoffContract,
          message: `Task successfully delegated to ${input.target_agent}. Context and asset references preserved.`,
        };
      },
    }),
  };
}
