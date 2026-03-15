import type {
  MemoryReference,
  IsolationContext,
  AccessRequest,
  AccessResult,
  IsolationViolation,
  ViolationType,
} from './types.js';
import { ISOLATION_RULES } from './types.js';
import { NamespaceIsolation } from './NamespaceIsolation.js';

/**
 * Validates memory references and enforces isolation rules
 */
export class ReferenceValidator {
  private namespaceIsolation: NamespaceIsolation;

  constructor(namespaceIsolation: NamespaceIsolation) {
    this.namespaceIsolation = namespaceIsolation;
  }

  /**
   * Validate a memory reference is properly scoped
   */
  validateReference(
    reference: MemoryReference,
    context: IsolationContext
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check required fields
    if (!reference.id) errors.push('Reference ID is required');
    if (!reference.layerId) errors.push('Layer ID is required');
    if (!reference.key) errors.push('Key is required');
    if (!reference.scope) errors.push('Scope is required');

    // Validate scope-specific requirements
    if (reference.scope === 'agent' && !reference.agentId) {
      errors.push('Agent-scoped references must have an agentId');
    }

    if (reference.scope === 'session') {
      if (!reference.agentId) {
        errors.push('Session-scoped references must have an agentId');
      }
      if (!reference.sessionId) {
        errors.push('Session-scoped references must have a sessionId');
      }
    }

    // Note: Cross-reference validation is handled by isolation rules, not here
    // We intentionally do NOT flag cross-agent/cross-session refs as invalid
    // because that would prevent proper violation detection with correct types

    // Validate key format
    if (reference.key) {
      const keyValidation = this.validateKeyFormat(reference.key);
      if (!keyValidation.valid) {
        errors.push(...keyValidation.errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Check if a reference is a cross-context reference (different agent or session)
   */
  checkCrossContextReference(
    reference: MemoryReference,
    context: IsolationContext
  ): { isCrossAgent: boolean; isCrossSession: boolean; errors: string[] } {
    const errors: string[] = [];
    let isCrossAgent = false;
    let isCrossSession = false;

    // Check for cross-agent reference
    if (reference.agentId && reference.agentId !== context.agentId) {
      isCrossAgent = true;
      errors.push(`Cross-agent reference detected: reference belongs to agent '${reference.agentId}' but accessed from agent '${context.agentId}'`);
    }

    // Check for cross-session reference
    if (reference.sessionId && reference.sessionId !== context.sessionId) {
      isCrossSession = true;
      errors.push(`Cross-session reference detected: reference belongs to session '${reference.sessionId}' but accessed from session '${context.sessionId}'`);
    }

    return { isCrossAgent, isCrossSession, errors };
  }

  /**
   * Validate access request against isolation rules
   */
  validateAccess(request: AccessRequest): AccessResult {
    const { context, target, operation } = request;

    // First validate the reference structure
    const refValidation = this.validateReference(target, context);
    if (!refValidation.valid) {
      return {
        allowed: false,
        reason: `Invalid reference: ${refValidation.errors.join(', ')}`,
        violation: this.createViolation(
          'INVALID_REFERENCE',
          request,
          refValidation.errors.join('; ')
        ),
      };
    }

    // Check namespace isolation
    const namespaceValidation = this.namespaceIsolation.validateCrossNamespaceAccess(
      context,
      target.layerId
    );

    if (!namespaceValidation.allowed) {
      return {
        allowed: false,
        reason: namespaceValidation.reason,
        violation: this.createCrossViolation(request),
      };
    }

    // Apply isolation rules
    for (const rule of ISOLATION_RULES) {
      if (rule.scope === target.scope) {
        const ruleResult = rule.validator(request);
        if (!ruleResult) {
          return {
            allowed: false,
            reason: `Rule '${rule.name}' denied ${operation} access`,
            violation: this.createViolation('CONTAMINATION_DETECTED', request, rule.name),
          };
        }

        // Check if operation is allowed
        if (!rule.allowedOperations.includes(operation)) {
          return {
            allowed: false,
            reason: `Operation '${operation}' not allowed for ${rule.scope} scope`,
            violation: this.createViolation('CONTAMINATION_DETECTED', request, rule.name),
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check if reference is accessible from context
   */
  canAccess(
    reference: MemoryReference,
    context: IsolationContext,
    operation: 'read' | 'write' | 'delete' = 'read'
  ): boolean {
    const result = this.validateAccess({
      context,
      target: reference,
      operation,
    });
    return result.allowed;
  }

  /**
   * Validate key format
   */
  private validateKeyFormat(key: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (key.length === 0) {
      errors.push('Key cannot be empty');
    }

    if (key.length > 256) {
      errors.push('Key cannot exceed 256 characters');
    }

    // Check for invalid characters
    if (!/^[a-zA-Z0-9_:\-\/\.]+$/.test(key)) {
      errors.push(
        'Key contains invalid characters (allowed: alphanumeric, _, :, -, /, .)'
      );
    }

    // Check for path traversal attempts
    if (key.includes('..')) {
      errors.push('Key cannot contain path traversal sequences');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Create violation record for cross-context access
   */
  private createCrossViolation(request: AccessRequest): IsolationViolation {
    const { context, target, operation } = request;
    let type: ViolationType;

    if (target.agentId && target.agentId !== context.agentId) {
      type = operation === 'read' ? 'CROSS_AGENT_READ' : 'CROSS_AGENT_WRITE';
    } else {
      type =
        operation === 'read' ? 'CROSS_SESSION_READ' : 'CROSS_SESSION_WRITE';
    }

    return this.createViolation(type, request);
  }

  /**
   * Create violation record
   */
  private createViolation(
    type: ViolationType,
    request: AccessRequest,
    details?: string
  ): IsolationViolation {
    return {
      id: this.generateId(),
      type,
      severity: this.getSeverityForType(type),
      context: request.context,
      target: request.target,
      operation: request.operation,
      timestamp: new Date(),
      details: details ? { rule: details } : {},
    };
  }

  /**
   * Get severity level for violation type
   */
  private getSeverityForType(type: ViolationType): 'low' | 'medium' | 'high' | 'critical' {
    switch (type) {
      case 'INVALID_REFERENCE':
        return 'low';
      case 'CROSS_SESSION_READ':
      case 'CROSS_SESSION_WRITE':
        return 'medium';
      case 'CROSS_AGENT_READ':
        return 'high';
      case 'CROSS_AGENT_WRITE':
      case 'CONTAMINATION_DETECTED':
        return 'critical';
      default:
        return 'medium';
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sanitize a reference key
   */
  sanitizeKey(key: string): string {
    return key
      .replace(/[^a-zA-Z0-9_:\-\/\.]/g, '_')
      .replace(/\.\./g, '_')
      .slice(0, 256);
  }

  /**
   * Build a fully qualified reference key
   */
  buildReferenceKey(
    agentId: string,
    sessionId: string,
    key: string
  ): string {
    return `ref:${agentId}:${sessionId}:${this.sanitizeKey(key)}`;
  }

  /**
   * Parse a reference key
   */
  parseReferenceKey(qualifiedKey: string): {
    agentId?: string;
    sessionId?: string;
    key?: string;
  } {
    const parts = qualifiedKey.split(':');
    if (parts.length < 4 || parts[0] !== 'ref') {
      return {};
    }

    return {
      agentId: parts[1],
      sessionId: parts[2],
      key: parts.slice(3).join(':'),
    };
  }
}
