import type {
  AgentId,
  SessionId,
  NamespaceId,
  IsolationContext,
  NamespaceMapping,
  IsolationConfig,
} from './types.js';
import { DEFAULT_ISOLATION_CONFIG } from './types.js';

/**
 * Enforces namespace isolation between agents and sessions.
 * Ensures working memory is never shared.
 */
export class NamespaceIsolation {
  private namespaces: Map<NamespaceId, NamespaceMapping>;
  private agentSessions: Map<AgentId, Set<SessionId>>;
  private config: IsolationConfig;

  constructor(config: Partial<IsolationConfig> = {}) {
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
    this.namespaces = new Map();
    this.agentSessions = new Map();
  }

  /**
   * Register a new agent session with its isolated namespace
   */
  registerSession(
    agentId: AgentId,
    sessionId: SessionId
  ): NamespaceId {
    const namespaceId = this.generateNamespaceId(agentId, sessionId);

    const mapping: NamespaceMapping = {
      agentId,
      sessionId,
      namespaceId,
      sharedAccess: new Set(this.config.sharedNamespaces),
    };

    this.namespaces.set(namespaceId, mapping);

    // Track agent's sessions
    if (!this.agentSessions.has(agentId)) {
      this.agentSessions.set(agentId, new Set());
    }
    this.agentSessions.get(agentId)!.add(sessionId);

    return namespaceId;
  }

  /**
   * Unregister a session and clean up its namespace
   */
  unregisterSession(agentId: AgentId, sessionId: SessionId): boolean {
    const namespaceId = this.generateNamespaceId(agentId, sessionId);
    const removed = this.namespaces.delete(namespaceId);

    // Clean up agent session tracking
    const sessions = this.agentSessions.get(agentId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.agentSessions.delete(agentId);
      }
    }

    return removed;
  }

  /**
   * Get namespace for a session
   */
  getNamespace(agentId: AgentId, sessionId: SessionId): NamespaceId | undefined {
    const namespaceId = this.generateNamespaceId(agentId, sessionId);
    return this.namespaces.has(namespaceId) ? namespaceId : undefined;
  }

  /**
   * Check if a namespace exists
   */
  hasNamespace(namespaceId: NamespaceId): boolean {
    return this.namespaces.has(namespaceId);
  }

  /**
   * Get namespace mapping
   */
  getNamespaceMapping(
    namespaceId: NamespaceId
  ): NamespaceMapping | undefined {
    return this.namespaces.get(namespaceId);
  }

  /**
   * Validate cross-namespace access
   */
  validateCrossNamespaceAccess(
    sourceContext: IsolationContext,
    targetNamespaceId: NamespaceId
  ): { allowed: boolean; reason?: string } {
    // Shared namespaces are always accessible for reads
    if (this.config.sharedNamespaces.includes(targetNamespaceId)) {
      return { allowed: true };
    }

    const targetMapping = this.namespaces.get(targetNamespaceId);
    if (!targetMapping) {
      return { allowed: false, reason: 'Target namespace does not exist' };
    }

    // Same session - always allowed
    if (
      sourceContext.agentId === targetMapping.agentId &&
      sourceContext.sessionId === targetMapping.sessionId
    ) {
      return { allowed: true };
    }

    // Same agent, different session - check policy
    if (sourceContext.agentId === targetMapping.agentId) {
      return {
        allowed: false,
        reason:
          'Cross-session access denied: sessions must be isolated per-agent',
      };
    }

    // Different agent - strict denial
    return {
      allowed: false,
      reason: 'Cross-agent access denied: agents have isolated working memory',
    };
  }

  /**
   * Grant shared access to a namespace
   */
  grantSharedAccess(
    namespaceId: NamespaceId,
    granteeNamespaceId: NamespaceId
  ): boolean {
    const mapping = this.namespaces.get(namespaceId);
    if (!mapping) return false;

    mapping.sharedAccess.add(granteeNamespaceId);
    return true;
  }

  /**
   * Revoke shared access
   */
  revokeSharedAccess(
    namespaceId: NamespaceId,
    granteeNamespaceId: NamespaceId
  ): boolean {
    const mapping = this.namespaces.get(namespaceId);
    if (!mapping) return false;

    mapping.sharedAccess.delete(granteeNamespaceId);
    return true;
  }

  /**
   * Check if grantee has shared access
   */
  hasSharedAccess(
    namespaceId: NamespaceId,
    granteeNamespaceId: NamespaceId
  ): boolean {
    const mapping = this.namespaces.get(namespaceId);
    if (!mapping) return false;

    return mapping.sharedAccess.has(granteeNamespaceId);
  }

  /**
   * Get all sessions for an agent
   */
  getAgentSessions(agentId: AgentId): SessionId[] {
    const sessions = this.agentSessions.get(agentId);
    return sessions ? Array.from(sessions) : [];
  }

  /**
   * Get all registered namespaces
   */
  getAllNamespaces(): NamespaceId[] {
    return Array.from(this.namespaces.keys());
  }

  /**
   * Get isolation context for a namespace
   */
  getContextForNamespace(
    namespaceId: NamespaceId
  ): IsolationContext | undefined {
    const mapping = this.namespaces.get(namespaceId);
    if (!mapping) return undefined;

    return {
      agentId: mapping.agentId,
      sessionId: mapping.sessionId,
      namespaceId: mapping.namespaceId,
      scope: 'agent',
      timestamp: new Date(),
    };
  }

  /**
   * Check if isolation is maintained between two contexts
   */
  isIsolated(
    contextA: IsolationContext,
    contextB: IsolationContext
  ): boolean {
    // Same session - not isolated from itself
    if (
      contextA.agentId === contextB.agentId &&
      contextA.sessionId === contextB.sessionId
    ) {
      return false;
    }

    // Same agent, different session - isolated
    if (contextA.agentId === contextB.agentId) {
      return true;
    }

    // Different agents - fully isolated
    return true;
  }

  /**
   * Generate unique namespace ID
   */
  private generateNamespaceId(
    agentId: AgentId,
    sessionId: SessionId
  ): NamespaceId {
    return `${this.config.namespacePrefix}:${agentId}:${sessionId}`;
  }

  /**
   * Get namespace stats
   */
  getStats(): {
    totalNamespaces: number;
    totalAgents: number;
    totalSessions: number;
    avgSessionsPerAgent: number;
  } {
    const totalAgents = this.agentSessions.size;
    let totalSessions = 0;

    for (const sessions of Array.from(this.agentSessions.values())) {
      totalSessions += sessions.size;
    }

    return {
      totalNamespaces: this.namespaces.size,
      totalAgents,
      totalSessions,
      avgSessionsPerAgent: totalAgents > 0 ? totalSessions / totalAgents : 0,
    };
  }

  /**
   * Clear all namespaces (for testing)
   */
  clear(): void {
    this.namespaces.clear();
    this.agentSessions.clear();
  }
}
