import type {
  IsolationConfig,
  IsolationContext,
  AccessRequest,
  AccessResult,
  MemoryReference,
} from './types.js';
import { DEFAULT_ISOLATION_CONFIG } from './types.js';
import { NamespaceIsolation } from './NamespaceIsolation.js';
import { ReferenceValidator } from './ReferenceValidator.js';
import { ContaminationDetector } from './ContaminationDetector.js';
import { AuditLogger } from './AuditLogger.js';
import { ViolationHandler, ViolationCallback } from './ViolationHandler.js';

/**
 * Main isolation manager that coordinates all isolation components.
 * Provides a unified interface for memory isolation enforcement.
 */
export class IsolationManager {
  readonly namespaceIsolation: NamespaceIsolation;
  readonly referenceValidator: ReferenceValidator;
  readonly contaminationDetector: ContaminationDetector;
  readonly auditLogger: AuditLogger;
  readonly violationHandler: ViolationHandler;
  
  private config: IsolationConfig;

  constructor(config: Partial<IsolationConfig> = {}) {
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
    
    // Initialize components
    this.namespaceIsolation = new NamespaceIsolation(this.config);
    this.referenceValidator = new ReferenceValidator(this.namespaceIsolation);
    this.contaminationDetector = new ContaminationDetector(this.config);
    this.auditLogger = new AuditLogger(10000, this.config);
    this.violationHandler = new ViolationHandler(
      this.auditLogger,
      this.contaminationDetector,
      this.config
    );
  }

  /**
   * Register a new session with isolated namespace
   */
  registerSession(agentId: string, sessionId: string): string {
    const namespaceId = this.namespaceIsolation.registerSession(agentId, sessionId);
    
    const context: IsolationContext = {
      agentId,
      sessionId,
      namespaceId,
      scope: 'agent',
      timestamp: new Date(),
    };

    this.contaminationDetector.registerContext(context);
    this.auditLogger.logNamespaceRegistration(context, namespaceId);

    return namespaceId;
  }

  /**
   * Unregister a session and clean up
   */
  unregisterSession(agentId: string, sessionId: string): boolean {
    const namespaceId = this.namespaceIsolation.getNamespace(agentId, sessionId);
    
    if (namespaceId) {
      const context: IsolationContext = {
        agentId,
        sessionId,
        namespaceId,
        scope: 'agent',
        timestamp: new Date(),
      };

      this.contaminationDetector.unregisterContext(context);
      this.auditLogger.logNamespaceUnregistration(context, namespaceId);
    }

    return this.namespaceIsolation.unregisterSession(agentId, sessionId);
  }

  /**
   * Validate and execute a memory access request
   */
  access(request: AccessRequest): AccessResult {
    // Check if context is blocked
    if (this.violationHandler.isBlocked(request.context)) {
      const result: AccessResult = {
        allowed: false,
        reason: 'Context is blocked due to previous violations',
      };
      
      this.auditLogger.logAccess(
        request.context,
        request.target.id,
        request.operation,
        false
      );
      
      return result;
    }

    // Validate the access request
    const result = this.referenceValidator.validateAccess(request);

    // Log the access attempt
    this.auditLogger.logAccess(
      request.context,
      request.target.id,
      request.operation,
      result.allowed
    );

    // Handle violations
    if (!result.allowed && result.violation) {
      this.violationHandler.handle(result.violation);
    }

    // Check for contamination
    if (result.allowed) {
      const contamination = this.contaminationDetector.detectFromAccess(request);
      
      if (contamination) {
        this.auditLogger.logContamination(
          request.context,
          contamination.source,
          contamination.dataKeys,
          contamination.containmentStatus
        );
      }
    }

    return result;
  }

  /**
   * Check if a reference can be accessed
   */
  canAccess(
    reference: MemoryReference,
    context: IsolationContext,
    operation: 'read' | 'write' | 'delete' = 'read'
  ): boolean {
    return this.referenceValidator.canAccess(reference, context, operation);
  }

  /**
   * Validate a memory reference
   */
  validateReference(
    reference: MemoryReference,
    context: IsolationContext
  ): { valid: boolean; errors: string[] } {
    return this.referenceValidator.validateReference(reference, context);
  }

  /**
   * Register a callback for violation events
   */
  onViolation(callback: ViolationCallback): () => void {
    return this.violationHandler.onViolation(callback);
  }

  /**
   * Get isolation context for a namespace
   */
  getContext(namespaceId: string): IsolationContext | undefined {
    return this.namespaceIsolation.getContextForNamespace(namespaceId);
  }

  /**
   * Get namespace for a session
   */
  getNamespace(agentId: string, sessionId: string): string | undefined {
    return this.namespaceIsolation.getNamespace(agentId, sessionId);
  }

  /**
   * Check if two contexts are isolated from each other
   */
  isIsolated(contextA: IsolationContext, contextB: IsolationContext): boolean {
    return this.namespaceIsolation.isIsolated(contextA, contextB);
  }

  /**
   * Check for contamination between contexts
   */
  checkContamination(
    source: IsolationContext,
    target: IsolationContext
  ): import('./types.js').ContaminationEvent | null {
    return this.contaminationDetector.checkContamination(source, target);
  }

  /**
   * Grant shared access between namespaces
   */
  grantSharedAccess(namespaceId: string, granteeNamespaceId: string): boolean {
    return this.namespaceIsolation.grantSharedAccess(namespaceId, granteeNamespaceId);
  }

  /**
   * Revoke shared access
   */
  revokeSharedAccess(namespaceId: string, granteeNamespaceId: string): boolean {
    return this.namespaceIsolation.revokeSharedAccess(namespaceId, granteeNamespaceId);
  }

  /**
   * Get all sessions for an agent
   */
  getAgentSessions(agentId: string): string[] {
    return this.namespaceIsolation.getAgentSessions(agentId);
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): {
    namespaces: ReturnType<NamespaceIsolation['getStats']>;
    contamination: ReturnType<ContaminationDetector['getStats']>;
    audit: ReturnType<AuditLogger['getStats']>;
    violations: ReturnType<ViolationHandler['getStats']>;
  } {
    return {
      namespaces: this.namespaceIsolation.getStats(),
      contamination: this.contaminationDetector.getStats(),
      audit: this.auditLogger.getStats(),
      violations: this.violationHandler.getStats(),
    };
  }

  /**
   * Export audit logs
   */
  exportAuditLogs(): string {
    return this.auditLogger.exportLogs();
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.namespaceIsolation.clear();
    this.contaminationDetector.clear();
    this.auditLogger.clear();
    this.violationHandler.clearBlockedContexts();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<IsolationConfig>): void {
    this.config = { ...this.config, ...config };
    
    this.auditLogger.logConfigChange(
      {
        agentId: 'system',
        sessionId: 'system',
        namespaceId: 'system',
        scope: 'shared',
        timestamp: new Date(),
      },
      config
    );
  }

  /**
   * Get current configuration
   */
  getConfig(): IsolationConfig {
    return { ...this.config };
  }
}

// Re-export types
export * from './types.js';
export { NamespaceIsolation } from './NamespaceIsolation.js';
export { ReferenceValidator } from './ReferenceValidator.js';
export { ContaminationDetector } from './ContaminationDetector.js';
export { AuditLogger } from './AuditLogger.js';
export { ViolationHandler, type ViolationCallback, type ViolationAction, type ViolationHandlerResult } from './ViolationHandler.js';
