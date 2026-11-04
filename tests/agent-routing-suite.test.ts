import { describe, expect, it } from 'vitest';
import {
  routeAgentIntent,
  createHandoffContract,
} from '@/lib/ai/agent-routing';

describe('Agent Routing & Delegation Suite', () => {
  describe('Intent-Based Automatic Routing', () => {
    it('routes marketing copywriting and visual creative requests to Jebat', () => {
      const decision = routeAgentIntent(
        'Tolong buat poster kreatif dan copywriting kempen raya dengan diskaun 30%',
      );
      expect(decision.selectedAgent).toBe('jebat');
      expect(decision.isCombined).toBe(false);
    });

    it('routes CRM, deals and sales pipeline requests to Kasturi', () => {
      const decision = routeAgentIntent(
        'Senaraikan deals dalam sales pipeline yang belum follow up minggu ini',
      );
      expect(decision.selectedAgent).toBe('kasturi');
      expect(decision.isCombined).toBe(false);
    });

    it('routes combined landing page + CRM campaigns to Jebat as primary builder with Kasturi as CRM specialist', () => {
      const decision = routeAgentIntent(
        'Bina landing page untuk Young Lecturer Programme dengan borang pendaftaran dan sambung terus ke CRM pipeline',
      );
      expect(decision.selectedAgent).toBe('jebat');
      expect(decision.isCombined).toBe(true);
      expect(decision.primaryBuilder).toBe('jebat');
      expect(decision.secondarySpecialist).toBe('kasturi');
      expect(decision.suggestedAction).toBe('collaborative_handoff');
    });

    it('honors explicit manual agent selection for Jebat', () => {
      const decision = routeAgentIntent('Jebat, semak prestasi kempen iklan Facebook');
      expect(decision.selectedAgent).toBe('jebat');
    });

    it('honors explicit manual agent selection for Kasturi', () => {
      const decision = routeAgentIntent('Kasturi, tambahkan kontak baharu dari WhatsApp');
      expect(decision.selectedAgent).toBe('kasturi');
    });
  });

  describe('Structured Delegation Handoff Contract', () => {
    it('creates a valid structured handoff contract between agents', () => {
      const res = createHandoffContract({
        taskId: 'task-101',
        parentTaskId: null,
        fromAgent: 'jebat',
        targetAgent: 'kasturi',
        originalIntent: 'Bina landing page dan hubungkan borang pendaftaran ke CRM',
        projectContext: { landingPageId: 'page-42' },
        selectedCapabilities: ['connect_form_to_crm'],
        relevantAssetReferences: ['https://v3.fal.media/files/img.webp'],
      });

      expect(res.contract).toBeDefined();
      expect(res.contract?.fromAgent).toBe('jebat');
      expect(res.contract?.targetAgent).toBe('kasturi');
      expect(res.contract?.depth).toBe(1);
      expect(res.contract?.delegationChain).toEqual(['jebat', 'kasturi']);
      expect(res.contract?.relevantAssetReferences).toContain('https://v3.fal.media/files/img.webp');
      expect(res.contract?.executionStatus).toBe('in_progress');
    });

    it('blocks self-delegation (Jebat to Jebat)', () => {
      const res = createHandoffContract({
        taskId: 'task-102',
        fromAgent: 'jebat',
        targetAgent: 'jebat',
        originalIntent: 'Test',
        selectedCapabilities: [],
      });

      expect(res.error).toMatch(/cannot delegate to itself/i);
      expect(res.contract).toBeUndefined();
    });

    it('detects and blocks circular delegation (Jebat -> Kasturi -> Jebat)', () => {
      const res = createHandoffContract({
        taskId: 'task-103',
        fromAgent: 'kasturi',
        targetAgent: 'jebat',
        originalIntent: 'Cycle test',
        selectedCapabilities: [],
        priorChain: ['jebat'], // Jebat was already in the chain
      });

      expect(res.error).toMatch(/Circular delegation detected/i);
      expect(res.contract).toBeUndefined();
    });

    it('enforces maximum delegation depth limit to prevent infinite loops', () => {
      const res = createHandoffContract({
        taskId: 'task-104',
        fromAgent: 'kasturi',
        targetAgent: 'jebat',
        originalIntent: 'Deep chain',
        selectedCapabilities: [],
        priorChain: ['jebat', 'kasturi', 'jebat', 'kasturi'],
      });

      expect(res.error).toMatch(/maximum delegation depth/i);
    });
  });
});
