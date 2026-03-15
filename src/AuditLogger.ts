import type {
  AuditLogEntry,
  IsolationContext,
  IsolationViolation,
  IsolationConfig,
} from './types.js';
import { DEFAULT_ISOLATION_CONFIG } from './types.js';

/**
 * Audit logger for memory isolation events.
 * Provides append-only logging for compliance and debugging.
 */
export class AuditLogger {
  private logs: AuditLogEntry[];
  private maxLogs: number;
  private config: IsolationConfig;

  constructor(
    maxLogs: number = 10000,
    config: Partial<IsolationConfig> = {}
  ) {
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
    this.logs = [];
    this.maxLogs = maxLogs;
  }

  /**
   * Log an access event
   */
  logAccess(
    context: IsolationContext,
    targetId: string,
    operation: string,
    allowed: boolean
  ): AuditLogEntry {
    return this.log({
      level: allowed ? 'info' : 'warn',
      event: 'MEMORY_ACCESS',
      context,
      details: {
        targetId,
        operation,
        allowed,
      },
    });
  }

  /**
   * Log a violation event
   */
  logViolation(
    violation: IsolationViolation,
    action: string
  ): AuditLogEntry {
    return this.log({
      level: (violation.severity === 'critical' || violation.severity === 'high') ? 'error' : 'warn',
      event: 'ISOLATION_VIOLATION',
      context: violation.context,
      details: {
        violationType: violation.type,
        severity: violation.severity,
        operation: violation.operation,
        action,
      },
      violation,
    });
  }

  /**
   * Log a namespace registration
   */
  logNamespaceRegistration(
    context: IsolationContext,
    namespaceId: string
  ): AuditLogEntry {
    return this.log({
      level: 'info',
      event: 'NAMESPACE_REGISTERED',
      context,
      details: {
        namespaceId,
        agentId: context.agentId,
        sessionId: context.sessionId,
      },
    });
  }

  /**
   * Log a namespace unregistration
   */
  logNamespaceUnregistration(
    context: IsolationContext,
    namespaceId: string
  ): AuditLogEntry {
    return this.log({
      level: 'info',
      event: 'NAMESPACE_UNREGISTERED',
      context,
      details: {
        namespaceId,
        agentId: context.agentId,
        sessionId: context.sessionId,
      },
    });
  }

  /**
   * Log a contamination detection event
   */
  logContamination(
    context: IsolationContext,
    sourceContext: IsolationContext,
    dataKeys: string[],
    status: string
  ): AuditLogEntry {
    return this.log({
      level: 'error',
      event: 'CONTAMINATION_DETECTED',
      context,
      details: {
        sourceAgentId: sourceContext.agentId,
        sourceSessionId: sourceContext.sessionId,
        dataKeys,
        status,
      },
    });
  }

  /**
   * Log a configuration change
   */
  logConfigChange(
    context: IsolationContext,
    changes: Record<string, unknown>
  ): AuditLogEntry {
    return this.log({
      level: 'info',
      event: 'CONFIG_CHANGED',
      context,
      details: {
        changes,
      },
    });
  }

  /**
   * Log a general info message
   */
  logInfo(
    event: string,
    context: IsolationContext,
    details: Record<string, unknown> = {}
  ): AuditLogEntry {
    return this.log({
      level: 'info',
      event,
      context,
      details,
    });
  }

  /**
   * Log a warning
   */
  logWarning(
    event: string,
    context: IsolationContext,
    details: Record<string, unknown> = {}
  ): AuditLogEntry {
    return this.log({
      level: 'warn',
      event,
      context,
      details,
    });
  }

  /**
   * Log an error
   */
  logError(
    event: string,
    context: IsolationContext,
    error: Error | string,
    details: Record<string, unknown> = {}
  ): AuditLogEntry {
    return this.log({
      level: 'error',
      event,
      context,
      details: {
        ...details,
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }

  /**
   * Create a log entry (internal)
   */
  private log(partial: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    if (!this.config.enableAuditLogging) {
      return null as unknown as AuditLogEntry;
    }

    const entry: AuditLogEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      ...partial,
    };

    this.logs.push(entry);

    // Maintain max log size
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    return entry;
  }

  /**
   * Get all logs
   */
  getAllLogs(): readonly AuditLogEntry[] {
    return this.logs;
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: AuditLogEntry['level']): AuditLogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * Get logs for a specific agent
   */
  getLogsForAgent(agentId: string): AuditLogEntry[] {
    return this.logs.filter(log => log.context.agentId === agentId);
  }

  /**
   * Get logs for a specific session
   */
  getLogsForSession(sessionId: string): AuditLogEntry[] {
    return this.logs.filter(log => log.context.sessionId === sessionId);
  }

  /**
   * Get logs for a specific event type
   */
  getLogsForEvent(event: string): AuditLogEntry[] {
    return this.logs.filter(log => log.event === event);
  }

  /**
   * Get logs within a time range
   */
  getLogsInRange(start: Date, end: Date): AuditLogEntry[] {
    return this.logs.filter(
      log => log.timestamp >= start && log.timestamp <= end
    );
  }

  /**
   * Get recent logs
   */
  getRecentLogs(count: number = 100): AuditLogEntry[] {
    return this.logs.slice(-count);
  }

  /**
   * Search logs
   */
  searchLogs(query: string): AuditLogEntry[] {
    const lowerQuery = query.toLowerCase();
    
    return this.logs.filter(log =>
      log.event.toLowerCase().includes(lowerQuery) ||
      log.context.agentId.toLowerCase().includes(lowerQuery) ||
      log.context.sessionId.toLowerCase().includes(lowerQuery) ||
      JSON.stringify(log.details).toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Export logs to JSON
   */
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  /**
   * Get audit statistics
   */
  getStats(): {
    totalLogs: number;
    infoCount: number;
    warnCount: number;
    errorCount: number;
    violationCount: number;
  } {
    return {
      totalLogs: this.logs.length,
      infoCount: this.logs.filter(l => l.level === 'info').length,
      warnCount: this.logs.filter(l => l.level === 'warn').length,
      errorCount: this.logs.filter(l => l.level === 'error').length,
      violationCount: this.logs.filter(l => l.event === 'ISOLATION_VIOLATION').length,
    };
  }

  /**
   * Clear all logs (for testing)
   */
  clear(): void {
    this.logs = [];
  }

  /**
   * Generate unique log ID
   */
  private generateId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
