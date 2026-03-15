import type {
  IsolationViolation,
  ViolationPolicy,
  ViolationSeverity,
  IsolationConfig,
  IsolationContext,
} from './types.js';
import { DEFAULT_ISOLATION_CONFIG } from './types.js';
import { AuditLogger } from './AuditLogger.js';
import { ContaminationDetector } from './ContaminationDetector.js';

export type ViolationAction = 'log' | 'warn' | 'block' | 'terminate';

export interface ViolationHandlerResult {
  action: ViolationAction;
  handled: boolean;
  message?: string;
  blocked: boolean;
}

export interface ViolationCallback {
  (violation: IsolationViolation, result: ViolationHandlerResult): void;
}

/**
 * Handles isolation violations according to policy.
 * Takes appropriate action based on violation severity.
 */
export class ViolationHandler {
  private policy: ViolationPolicy;
  private auditLogger: AuditLogger;
  private contaminationDetector: ContaminationDetector;
  private callbacks: Set<ViolationCallback>;
  private config: IsolationConfig;
  private blockedContexts: Set<string>;

  constructor(
    auditLogger: AuditLogger,
    contaminationDetector: ContaminationDetector,
    config: Partial<IsolationConfig> = {}
  ) {
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
    this.policy = this.config.violationPolicy;
    this.auditLogger = auditLogger;
    this.contaminationDetector = contaminationDetector;
    this.callbacks = new Set();
    this.blockedContexts = new Set();
  }

  /**
   * Handle a violation according to policy
   */
  handle(violation: IsolationViolation): ViolationHandlerResult {
    // Determine action based on severity
    const action = this.policy.severityActions[violation.severity] || 
                   this.policy.defaultAction;

    const result = this.executeAction(action, violation);

    // Log the violation and action taken
    this.auditLogger.logViolation(violation, action);

    // Report contamination if applicable
    if (this.shouldReportContamination(violation)) {
      this.contaminationDetector.reportContamination(
        violation,
        this.getContaminatedKeys(violation)
      );
    }

    // Notify callbacks
    this.notifyCallbacks(violation, result);

    return result;
  }

  /**
   * Check if an operation should be blocked for a context
   */
  isBlocked(context: IsolationContext): boolean {
    const contextKey = this.getContextKey(context);
    return this.blockedContexts.has(contextKey);
  }

  /**
   * Block a context from further operations
   */
  blockContext(context: IsolationContext, reason: string): void {
    const contextKey = this.getContextKey(context);
    this.blockedContexts.add(contextKey);
    
    this.auditLogger.logWarning(
      'CONTEXT_BLOCKED',
      context,
      { reason }
    );
  }

  /**
   * Unblock a context
   */
  unblockContext(context: IsolationContext): void {
    const contextKey = this.getContextKey(context);
    this.blockedContexts.delete(contextKey);
  }

  /**
   * Register a callback for violation events
   */
  onViolation(callback: ViolationCallback): () => void {
    this.callbacks.add(callback);
    
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Execute the appropriate action for a violation
   */
  private executeAction(
    action: ViolationAction,
    violation: IsolationViolation
  ): ViolationHandlerResult {
    switch (action) {
      case 'log':
        return this.handleLog(violation);
      
      case 'warn':
        return this.handleWarn(violation);
      
      case 'block':
        return this.handleBlock(violation);
      
      case 'terminate':
        return this.handleTerminate(violation);
      
      default:
        return this.handleLog(violation);
    }
  }

  /**
   * Handle log action - just record, don't block
   */
  private handleLog(violation: IsolationViolation): ViolationHandlerResult {
    return {
      action: 'log',
      handled: true,
      message: `Logged ${violation.type} violation`,
      blocked: false,
    };
  }

  /**
   * Handle warn action - log and warn
   */
  private handleWarn(violation: IsolationViolation): ViolationHandlerResult {
    const message = this.formatViolationMessage(violation);
    
    // In a real system, this might emit an event or console.warn
    console.warn(`[ISOLATION WARNING] ${message}`);
    
    return {
      action: 'warn',
      handled: true,
      message,
      blocked: false,
    };
  }

  /**
   * Handle block action - block the operation
   */
  private handleBlock(violation: IsolationViolation): ViolationHandlerResult {
    const message = this.formatViolationMessage(violation);
    
    // Block the context temporarily
    this.blockContext(violation.context, message);
    
    return {
      action: 'block',
      handled: true,
      message: `Blocked operation: ${message}`,
      blocked: true,
    };
  }

  /**
   * Handle terminate action - terminate the session
   */
  private handleTerminate(violation: IsolationViolation): ViolationHandlerResult {
    const message = this.formatViolationMessage(violation);
    
    // Block the context permanently
    this.blockContext(violation.context, message);
    
    this.auditLogger.logError(
      'SESSION_TERMINATED',
      violation.context,
      message,
      {
        violationType: violation.type,
        severity: violation.severity,
      }
    );
    
    return {
      action: 'terminate',
      handled: true,
      message: `Session terminated: ${message}`,
      blocked: true,
    };
  }

  /**
   * Check if violation should report contamination
   */
  private shouldReportContamination(violation: IsolationViolation): boolean {
    return (
      violation.type === 'CROSS_AGENT_READ' ||
      violation.type === 'CROSS_AGENT_WRITE' ||
      violation.type === 'CONTAMINATION_DETECTED'
    );
  }

  /**
   * Get contaminated data keys from violation
   */
  private getContaminatedKeys(violation: IsolationViolation): string[] {
    if (violation.details?.dataKeys) {
      return violation.details.dataKeys as string[];
    }
    
    if (violation.target?.key) {
      return [violation.target.key];
    }
    
    return [];
  }

  /**
   * Format a violation message for display
   */
  private formatViolationMessage(violation: IsolationViolation): string {
    const parts = [
      `Violation: ${violation.type}`,
      `Severity: ${violation.severity}`,
      `Agent: ${violation.context.agentId}`,
      `Session: ${violation.context.sessionId}`,
      `Operation: ${violation.operation}`,
    ];

    if (violation.target.agentId) {
      parts.push(`Target Agent: ${violation.target.agentId}`);
    }
    
    if (violation.target.sessionId) {
      parts.push(`Target Session: ${violation.target.sessionId}`);
    }

    return parts.join(' | ');
  }

  /**
   * Notify all registered callbacks
   */
  private notifyCallbacks(
    violation: IsolationViolation,
    result: ViolationHandlerResult
  ): void {
    for (const callback of Array.from(this.callbacks)) {
      try {
        callback(violation, result);
      } catch (error) {
        console.error('Violation callback error:', error);
      }
    }
  }

  /**
   * Get context key for tracking
   */
  private getContextKey(context: IsolationContext): string {
    return `${context.agentId}:${context.sessionId}:${context.namespaceId}`;
  }

  /**
   * Update the violation policy
   */
  updatePolicy(policy: Partial<ViolationPolicy>): void {
    this.policy = { ...this.policy, ...policy };
    
    this.auditLogger.logInfo(
      'POLICY_UPDATED',
      {
        agentId: 'system',
        sessionId: 'system',
        namespaceId: 'system',
        scope: 'shared',
        timestamp: new Date(),
      },
      { policy: this.policy }
    );
  }

  /**
   * Get current policy
   */
  getPolicy(): ViolationPolicy {
    return { ...this.policy };
  }

  /**
   * Get blocked contexts count
   */
  getBlockedCount(): number {
    return this.blockedContexts.size;
  }

  /**
   * Clear all blocked contexts
   */
  clearBlockedContexts(): void {
    this.blockedContexts.clear();
  }

  /**
   * Get handler statistics
   */
  getStats(): {
    blockedContexts: number;
    registeredCallbacks: number;
  } {
    return {
      blockedContexts: this.blockedContexts.size,
      registeredCallbacks: this.callbacks.size,
    };
  }
}
