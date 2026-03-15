import type {
  IsolationContext,
  ContaminationEvent,
  AccessRequest,
  IsolationViolation,
  IsolationConfig,
} from './types.js';
import { DEFAULT_ISOLATION_CONFIG } from './types.js';

/**
 * Detects and tracks memory contamination between agents and sessions.
 * Prevents cross-contamination of working memory.
 */
export class ContaminationDetector {
  private events: Map<string, ContaminationEvent>;
  private activeContexts: Map<string, IsolationContext>;
  private dataAccessLog: Map<string, Set<string>>;
  private config: IsolationConfig;

  constructor(config: Partial<IsolationConfig> = {}) {
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
    this.events = new Map();
    this.activeContexts = new Map();
    this.dataAccessLog = new Map();
  }

  /**
   * Register an active context for monitoring
   */
  registerContext(context: IsolationContext): void {
    const contextKey = this.getContextKey(context);
    this.activeContexts.set(contextKey, context);
    
    // Initialize access log for this context
    if (!this.dataAccessLog.has(contextKey)) {
      this.dataAccessLog.set(contextKey, new Set());
    }
  }

  /**
   * Unregister a context
   */
  unregisterContext(context: IsolationContext): void {
    const contextKey = this.getContextKey(context);
    this.activeContexts.delete(contextKey);
    this.dataAccessLog.delete(contextKey);
  }

  /**
   * Log data access for contamination tracking
   */
  logDataAccess(context: IsolationContext, dataKey: string): void {
    const contextKey = this.getContextKey(context);
    const accessLog = this.dataAccessLog.get(contextKey);
    
    if (accessLog) {
      accessLog.add(dataKey);
    }
  }

  /**
   * Check for potential contamination between two contexts
   */
  checkContamination(
    source: IsolationContext,
    target: IsolationContext
  ): ContaminationEvent | null {
    const sourceKey = this.getContextKey(source);
    const targetKey = this.getContextKey(target);

    // Same context - no contamination possible
    if (sourceKey === targetKey) {
      return null;
    }

    // Same agent, different session - check for cross-session contamination
    if (source.agentId === target.agentId) {
      return this.checkCrossSessionContamination(source, target);
    }

    // Different agents - check for cross-agent contamination
    return this.checkCrossAgentContamination(source, target);
  }

  /**
   * Detect contamination from an access request
   */
  detectFromAccess(request: AccessRequest): ContaminationEvent | null {
    const { context, target } = request;

    // Log this access FIRST (both namespaced and logical)
    // This ensures that when checking for contamination, both contexts
    // have the data recorded for cross-session detection
    const targetKey = `${target.layerId}:${target.key}`;
    const logicalKey = `logical:${target.key}`;
    this.logDataAccess(context, targetKey);
    this.logDataAccess(context, logicalKey);

    // Check for contamination using full namespaced key (cross-namespace access)
    const contamination = this.checkContaminationForKey(context, targetKey);
    if (contamination) {
      return contamination;
    }

    // Check logical key for cross-session detection (same agent, different sessions)
    // This detects when the same logical key is accessed across session boundaries
    const logicalContamination = this.checkContaminationForKey(context, logicalKey, true);
    if (logicalContamination) {
      return logicalContamination;
    }

    return null;
  }

  /**
   * Check contamination for a specific data key
   */
  private checkContaminationForKey(
    context: IsolationContext,
    dataKey: string,
    isLogicalKey: boolean = false
  ): ContaminationEvent | null {
    for (const [contextKey, accessLog] of Array.from(this.dataAccessLog.entries())) {
      if (accessLog.has(dataKey)) {
        const otherContext = this.activeContexts.get(contextKey);

        if (otherContext && this.getContextKey(context) !== contextKey) {
          // For logical keys, skip if same agent AND same session (same context, not contamination)
          // Report if: different sessions (same agent = cross-session) OR different agents (cross-agent)
          if (isLogicalKey &&
              otherContext.agentId === context.agentId &&
              otherContext.sessionId === context.sessionId) {
            continue;
          }

          const contamination = this.checkContamination(otherContext, context);

          if (contamination && this.config.enableContaminationDetection) {
            this.events.set(contamination.id, contamination);
            return contamination;
          }
        }
      }
    }
    return null;
  }

  /**
   * Check for cross-session contamination
   */
  private checkCrossSessionContamination(
    source: IsolationContext,
    target: IsolationContext
  ): ContaminationEvent | null {
    const sourceAccessLog = this.dataAccessLog.get(this.getContextKey(source));
    const targetAccessLog = this.dataAccessLog.get(this.getContextKey(target));

    if (!sourceAccessLog || !targetAccessLog) {
      return null;
    }

    // Collect logical keys from both contexts
    const sourceLogicalKeys: string[] = [];
    const targetLogicalKeys: string[] = [];
    
    for (const key of Array.from(sourceAccessLog)) {
      if (key.startsWith('logical:')) {
        sourceLogicalKeys.push(key);
      }
    }
    
    for (const key of Array.from(targetAccessLog)) {
      if (key.startsWith('logical:')) {
        targetLogicalKeys.push(key);
      }
    }
    
    // Find shared logical keys (same key accessed from different sessions)
    const sharedLogicalKeys = sourceLogicalKeys.filter(k => targetLogicalKeys.includes(k));
    
    // Also check for exact matches (same namespace access - should not happen across sessions)
    const sharedExactKeys: string[] = [];
    for (const key of Array.from(sourceAccessLog)) {
      if (!key.startsWith('logical:') && targetAccessLog.has(key)) {
        sharedExactKeys.push(key);
      }
    }
    
    const allSharedKeys = [...sharedExactKeys, ...sharedLogicalKeys];
    
    if (allSharedKeys.length === 0) {
      return null;
    }

    return {
      id: this.generateEventId(),
      source,
      target,
      dataKeys: allSharedKeys,
      timestamp: new Date(),
      containmentStatus: 'contained',
    };
  }

  /**
   * Check for cross-agent contamination (more severe)
   */
  private checkCrossAgentContamination(
    source: IsolationContext,
    target: IsolationContext
  ): ContaminationEvent | null {
    const sourceAccessLog = this.dataAccessLog.get(this.getContextKey(source));
    const targetAccessLog = this.dataAccessLog.get(this.getContextKey(target));

    if (!sourceAccessLog || !targetAccessLog) {
      return null;
    }

    // Collect logical keys from both contexts
    const sourceLogicalKeys: string[] = [];
    const targetLogicalKeys: string[] = [];
    
    for (const key of Array.from(sourceAccessLog)) {
      if (key.startsWith('logical:')) {
        sourceLogicalKeys.push(key);
      }
    }
    
    for (const key of Array.from(targetAccessLog)) {
      if (key.startsWith('logical:')) {
        targetLogicalKeys.push(key);
      }
    }
    
    // Find shared logical keys (same key accessed from different agents)
    const sharedLogicalKeys = sourceLogicalKeys.filter(k => targetLogicalKeys.includes(k));
    
    // Also check for exact matches (same namespace - shouldn't happen across agents)
    const sharedExactKeys: string[] = [];
    for (const key of Array.from(sourceAccessLog)) {
      if (!key.startsWith('logical:') && targetAccessLog.has(key)) {
        sharedExactKeys.push(key);
      }
    }
    
    const allSharedKeys = [...sharedExactKeys, ...sharedLogicalKeys];

    if (allSharedKeys.length === 0) {
      return null;
    }

    return {
      id: this.generateEventId(),
      source,
      target,
      dataKeys: allSharedKeys,
      timestamp: new Date(),
      containmentStatus: 'spreading',
    };
  }

  /**
   * Report a contamination event from a violation
   */
  reportContamination(
    violation: IsolationViolation,
    dataKeys: string[]
  ): ContaminationEvent {
    const event: ContaminationEvent = {
      id: this.generateEventId(),
      source: violation.context,
      target: {
        ...violation.context,
        agentId: violation.target.agentId || violation.context.agentId,
        sessionId: violation.target.sessionId || violation.context.sessionId,
      },
      dataKeys,
      timestamp: new Date(),
      containmentStatus: (violation.type.includes('WRITE') || violation.type.includes('CROSS_AGENT')) ? 'spreading' : 'contained',
    };

    this.events.set(event.id, event);
    return event;
  }

  /**
   * Mark a contamination event as resolved
   */
  resolveContamination(eventId: string): boolean {
    const event = this.events.get(eventId);
    
    if (!event) {
      return false;
    }

    event.containmentStatus = 'resolved';
    return true;
  }

  /**
   * Get all contamination events
   */
  getAllEvents(): ContaminationEvent[] {
    return Array.from(this.events.values());
  }

  /**
   * Get active (unresolved) contamination events
   */
  getActiveEvents(): ContaminationEvent[] {
    return this.getAllEvents().filter(
      e => e.containmentStatus !== 'resolved'
    );
  }

  /**
   * Get contamination events for a specific agent
   */
  getEventsForAgent(agentId: string): ContaminationEvent[] {
    return this.getAllEvents().filter(
      e => e.source.agentId === agentId || e.target.agentId === agentId
    );
  }

  /**
   * Get contamination events for a specific session
   */
  getEventsForSession(sessionId: string): ContaminationEvent[] {
    return this.getAllEvents().filter(
      e => e.source.sessionId === sessionId || e.target.sessionId === sessionId
    );
  }

  /**
   * Check if there is active contamination between two contexts
   */
  hasContamination(
    contextA: IsolationContext,
    contextB: IsolationContext
  ): boolean {
    return this.getAllEvents().some(
      e =>
        e.containmentStatus !== 'resolved' &&
        ((this.contextsMatch(e.source, contextA) &&
          this.contextsMatch(e.target, contextB)) ||
          (this.contextsMatch(e.source, contextB) &&
            this.contextsMatch(e.target, contextA)))
    );
  }

  /**
   * Get contamination statistics
   */
  getStats(): {
    totalEvents: number;
    containedCount: number;
    spreadingCount: number;
    resolvedCount: number;
    activeContexts: number;
  } {
    const events = this.getAllEvents();
    
    return {
      totalEvents: events.length,
      containedCount: events.filter(e => e.containmentStatus === 'contained').length,
      spreadingCount: events.filter(e => e.containmentStatus === 'spreading').length,
      resolvedCount: events.filter(e => e.containmentStatus === 'resolved').length,
      activeContexts: this.activeContexts.size,
    };
  }

  /**
   * Clear all events (for testing)
   */
  clear(): void {
    this.events.clear();
    this.activeContexts.clear();
    this.dataAccessLog.clear();
  }

  /**
   * Generate unique context key
   */
  private getContextKey(context: IsolationContext): string {
    return `${context.agentId}:${context.sessionId}:${context.namespaceId}`;
  }

  /**
   * Check if two contexts match
   */
  private contextsMatch(a: IsolationContext, b: IsolationContext): boolean {
    return (
      a.agentId === b.agentId &&
      a.sessionId === b.sessionId &&
      a.namespaceId === b.namespaceId
    );
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    return `contam-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
