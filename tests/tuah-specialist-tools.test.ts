import { describe, expect, it, vi } from 'vitest';
import { createSeedReachData } from '@/lib/reach/seed';
import { reachProduct, crmProduct, combineToolkits } from '@/lib/ai/products';
import { createTeamTools } from '@/lib/ai/agents/specialists';
import type { SharedToolContext } from '@/lib/ai/shared-tools';
import { SHARED_TOOL_NAMES } from '@/lib/ai/shared-tools';
import { memoryProposalStore } from '@/lib/chat/proposal-store';

describe('Tuah Specialist Tools - Shared Capabilities Matrix', () => {
  const mockSharedCtx: SharedToolContext = {
    agent: 'jebat',
    client: {} as never,
    orgId: 'test-org-uuid',
    userId: 'user-1',
    role: 'owner',
    canWrite: true,
    falKey: 'mock-fal-key-12345',
  };

  const reach = () => ({ data: createSeedReachData() });
  const crm = () => ({ client: {} as never, orgId: 'test-org-uuid', userId: 'user-1', canWrite: true });

  it('reachProduct equipped with sharedCtx includes all 9 shared tools in read tools', () => {
    const product = reachProduct(reach(), mockSharedCtx);
    for (const toolName of SHARED_TOOL_NAMES) {
      expect(product.read[toolName]).toBeDefined();
    }
  });

  it('crmProduct equipped with sharedCtx includes all 9 shared tools in read tools', () => {
    const product = crmProduct(crm(), { ...mockSharedCtx, agent: 'kasturi' });
    for (const toolName of SHARED_TOOL_NAMES) {
      expect(product.read[toolName]).toBeDefined();
    }
  });

  it('combineToolkits does not throw when combining reach and crm products with shared tools', () => {
    const jebatProd = reachProduct(reach(), mockSharedCtx);
    const kasturiProd = crmProduct(crm(), { ...mockSharedCtx, agent: 'kasturi' });
    expect(() => combineToolkits([jebatProd, kasturiProd])).not.toThrow();
  });

  it('createTeamTools exposes askJebat and askKasturi to Tuah', () => {
    const jebatProd = reachProduct(reach(), mockSharedCtx);
    const kasturiProd = crmProduct(crm(), { ...mockSharedCtx, agent: 'kasturi' });
    const store = memoryProposalStore();

    const teamTools = createTeamTools(
      [jebatProd, kasturiProd],
      {
        transcript: '',
        proposals: new Map(),
        store,
      },
      [],
    );

    expect(teamTools.tools['askJebat']).toBeDefined();
    expect(teamTools.tools['askKasturi']).toBeDefined();
    expect(teamTools.tools['applyChange']).toBeDefined();
  });

  it('Tuah TEAM_AREA includes fal.ai image generation for both Jebat and Kasturi', async () => {
    const { TEAM_AREA } = await import('@/lib/ai/agents/orchestrator');
    expect(TEAM_AREA.reach).toContain('fal.ai');
    expect(TEAM_AREA.reach).toContain('landing pages');
    expect(TEAM_AREA.crm).toContain('fal.ai');
    expect(TEAM_AREA.crm).toContain('landing pages');
  });

  it('subAgentSystem prompt for reach and crm mentions generate_image and fal.ai', async () => {
    const { subAgentSystem } = await import('@/lib/ai/agents/prompts');
    const jebatPrompt = subAgentSystem('reach', true);
    expect(jebatPrompt).toContain('generate_image');
    expect(jebatPrompt).toContain('fal.ai');

    const kasturiPrompt = subAgentSystem('crm', true);
    expect(kasturiPrompt).toContain('generate_image');
    expect(kasturiPrompt).toContain('fal.ai');
  });
});
