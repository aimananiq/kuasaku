/**
 * Agent Routing and Delegation Orchestrator for Jebat and Kasturi.
 *
 * Implements:
 * - Intent-based automatic agent selection
 * - Manual agent mode support
 * - Structured agent handoff contracts
 * - Anti-circular delegation protection with configurable maximum depth
 * - Context preservation across multi-agent turns
 */

export type AgentName = 'jebat' | 'kasturi';

export type AgentRoutingDecision = {
  selectedAgent: AgentName;
  reason: string;
  isCombined: boolean;
  primaryBuilder?: AgentName;
  secondarySpecialist?: AgentName;
  suggestedAction: 'direct_execution' | 'collaborative_handoff';
};

export type HandoffContract = {
  taskId: string;
  parentTaskId: string | null;
  fromAgent: AgentName;
  targetAgent: AgentName;
  originalIntent: string;
  projectContext: Record<string, unknown>;
  selectedCapabilities: string[];
  relevantAssetReferences: string[];
  depth: number;
  delegationChain: AgentName[];
  executionStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
};

const MAX_DELEGATION_DEPTH = 3;

/**
 * Evaluates user prompt intent to route to the appropriate agent.
 * Rules:
 * - Creative, campaign, marketing copywriting, visual design -> Jebat
 * - CRM, leads, deals, pipeline, sales follow-up -> Kasturi
 * - Combined landing page + CRM -> Jebat as primary builder, Kasturi as CRM integration
 */
export function routeAgentIntent(prompt: string): AgentRoutingDecision {
  const p = prompt.toLowerCase();

  const marketingKeywords = [
    'kempen',
    'campaign',
    'creative',
    'design',
    'copywriting',
    'hero image',
    'visual',
    'iklan',
    'ad',
    'poster',
    'headline',
    'jebat',
  ];

  const crmKeywords = [
    'crm',
    'pipeline',
    'deal',
    'deals',
    'follow-up',
    'follow up',
    'contact',
    'contacts',
    'sales',
    'kasturi',
  ];

  const landingPageKeywords = [
    'landing page',
    'landingpage',
    'page',
    'borang',
    'form',
    'lead form',
    'lead capture',
  ];

  const hasMarketing = marketingKeywords.some((k) => p.includes(k));
  const hasCrm = crmKeywords.some((k) => p.includes(k));
  const hasLandingPage = landingPageKeywords.some((k) => p.includes(k));

  // Explicit agent mention
  if (p.includes('jebat') && !p.includes('kasturi')) {
    return {
      selectedAgent: 'jebat',
      reason: 'User explicitly addressed Jebat.',
      isCombined: hasCrm,
      primaryBuilder: 'jebat',
      secondarySpecialist: hasCrm ? 'kasturi' : undefined,
      suggestedAction: hasCrm ? 'collaborative_handoff' : 'direct_execution',
    };
  }

  if (p.includes('kasturi') && !p.includes('jebat')) {
    return {
      selectedAgent: 'kasturi',
      reason: 'User explicitly addressed Kasturi.',
      isCombined: hasMarketing,
      primaryBuilder: 'kasturi',
      secondarySpecialist: hasMarketing ? 'jebat' : undefined,
      suggestedAction: hasMarketing ? 'collaborative_handoff' : 'direct_execution',
    };
  }

  // Combined Landing Page + CRM Campaign
  if (hasLandingPage && (hasMarketing || hasCrm)) {
    return {
      selectedAgent: 'jebat',
      reason: 'Combined landing page and lead campaign: Jebat leads creation with Kasturi handling CRM integration.',
      isCombined: true,
      primaryBuilder: 'jebat',
      secondarySpecialist: 'kasturi',
      suggestedAction: 'collaborative_handoff',
    };
  }

  // CRM / Sales Pipeline Intent
  if (hasCrm && !hasMarketing) {
    return {
      selectedAgent: 'kasturi',
      reason: 'Sales pipeline, CRM contacts, or customer follow-up intent prefers Kasturi.',
      isCombined: false,
      suggestedAction: 'direct_execution',
    };
  }

  // Default to Jebat for marketing, creative and landing page initiatives
  return {
    selectedAgent: 'jebat',
    reason: 'Marketing, creative campaigns, and content generation prefer Jebat.',
    isCombined: false,
    suggestedAction: 'direct_execution',
  };
}

/**
 * Creates a structured delegation handoff contract.
 * Checks against circular delegation and enforces maximum depth.
 */
export function createHandoffContract(params: {
  taskId: string;
  parentTaskId?: string | null;
  fromAgent: AgentName;
  targetAgent: AgentName;
  originalIntent: string;
  projectContext?: Record<string, unknown>;
  selectedCapabilities: string[];
  relevantAssetReferences?: string[];
  priorChain?: AgentName[];
}): { contract?: HandoffContract; error?: string } {
  const { fromAgent, targetAgent, priorChain = [] } = params;

  if (fromAgent === targetAgent) {
    return { error: `Circular delegation rejected: ${fromAgent} cannot delegate to itself.` };
  }

  const delegationChain = [...priorChain, fromAgent];
  const depth = delegationChain.length;

  if (depth > MAX_DELEGATION_DEPTH) {
    return {
      error: `Delegation rejected: maximum delegation depth (${MAX_DELEGATION_DEPTH}) exceeded to prevent infinite cycles.`,
    };
  }

  // Check if target agent already appeared in the chain
  if (delegationChain.includes(targetAgent)) {
    return {
      error: `Circular delegation detected: agent ${targetAgent} has already processed this chain (${delegationChain.join(' -> ')}).`,
    };
  }

  const contract: HandoffContract = {
    taskId: params.taskId,
    parentTaskId: params.parentTaskId ?? null,
    fromAgent,
    targetAgent,
    originalIntent: params.originalIntent,
    projectContext: params.projectContext ?? {},
    selectedCapabilities: params.selectedCapabilities,
    relevantAssetReferences: params.relevantAssetReferences ?? [],
    depth,
    delegationChain: [...delegationChain, targetAgent],
    executionStatus: 'in_progress',
  };

  return { contract };
}
