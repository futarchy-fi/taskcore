/**
 * Multi-Agent/Session Isolation System
 * 
 * Provides strict isolation for layered memory with:
 * - Namespace isolation enforcement
 * - Reference validation
 * - Contamination detection
 * - Audit logging
 * - Violation handling
 */

export * from './types.js';
export { NamespaceIsolation } from './NamespaceIsolation.js';
export { ReferenceValidator } from './ReferenceValidator.js';
export { ContaminationDetector } from './ContaminationDetector.js';
export { AuditLogger } from './AuditLogger.js';
export { ViolationHandler, type ViolationCallback, type ViolationAction, type ViolationHandlerResult } from './ViolationHandler.js';
export { IsolationManager } from './IsolationManager.js';
