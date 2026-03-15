/**
 * Types and interfaces for multi-agent/session isolation
 */

export type AgentId = string;
export type SessionId = string;
export type NamespaceId = string;
export type MemoryLayerId = string;

export type IsolationScope = 'agent' | 'session' | 'shared';

export interface IsolationContext {
  agentId: AgentId;
  sessionId: SessionId;
  namespaceId: NamespaceId;
  scope: IsolationScope;
  timestamp: Date;
}

export interface MemoryReference {
  id: string;
  agentId?: AgentId;
  sessionId?: SessionId;
  layerId: MemoryLayerId;
  key: string;
  scope: IsolationScope;
}

export interface AccessRequest {
  context: IsolationContext;
  target: MemoryReference;
  operation: 'read' | 'write' | 'delete';
}

export interface AccessResult {
  allowed: boolean;
  reason?: string;
  violation?: IsolationViolation;
}

export interface IsolationViolation {
  id: string;
  type: ViolationType;
  severity: ViolationSeverity;
  context: IsolationContext;
  target: MemoryReference;
  operation: string;
  timestamp: Date;
  details: Record<string, unknown>;
}

export type ViolationType =
  | 'CROSS_AGENT_READ'
  | 'CROSS_AGENT_WRITE'
  | 'CROSS_SESSION_READ'
  | 'CROSS_SESSION_WRITE'
  | 'INVALID_REFERENCE'
  | 'CONTAMINATION_DETECTED';

export type ViolationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ContaminationEvent {
  id: string;
  source: IsolationContext;
  target: IsolationContext;
  dataKeys: string[];
  timestamp: Date;
  containmentStatus: 'contained' | 'spreading' | 'resolved';
}

export interface IsolationRule {
  id: string;
  name: string;
  description: string;
  scope: IsolationScope;
  allowedOperations: ('read' | 'write' | 'delete')[];
  validator: (request: AccessRequest) => boolean;
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  event: string;
  context: IsolationContext;
  details: Record<string, unknown>;
  violation?: IsolationViolation;
}

export interface IsolationConfig {
  strictMode: boolean;
  enableContaminationDetection: boolean;
  enableAuditLogging: boolean;
  violationPolicy: ViolationPolicy;
  namespacePrefix: string;
  sharedNamespaces: string[];
}

export interface ViolationPolicy {
  defaultAction: 'log' | 'warn' | 'block' | 'terminate';
  severityActions: Record<ViolationSeverity, 'log' | 'warn' | 'block' | 'terminate'>;
}

export interface NamespaceMapping {
  agentId: AgentId;
  sessionId: SessionId;
  namespaceId: NamespaceId;
  sharedAccess: Set<string>;
}

export const DEFAULT_ISOLATION_CONFIG: IsolationConfig = {
  strictMode: true,
  enableContaminationDetection: true,
  enableAuditLogging: true,
  violationPolicy: {
    defaultAction: 'block',
    severityActions: {
      low: 'log',
      medium: 'warn',
      high: 'block',
      critical: 'terminate',
    },
  },
  namespacePrefix: 'isolated',
  sharedNamespaces: ['project_knowledge', 'public'],
};

export const ISOLATION_RULES: IsolationRule[] = [
  {
    id: 'agent-isolation',
    name: 'Agent Isolation',
    description: 'Working memory is never shared between agents',
    scope: 'agent',
    allowedOperations: ['read', 'write', 'delete'],
    validator: (req: AccessRequest) => req.context.agentId === req.target.agentId,
  },
  {
    id: 'session-isolation',
    name: 'Session Isolation',
    description: 'Active tool calls are per-session only',
    scope: 'session',
    allowedOperations: ['read', 'write'],
    validator: (req: AccessRequest) =>
      req.context.agentId === req.target.agentId &&
      req.context.sessionId === req.target.sessionId,
  },
  {
    id: 'shared-read',
    name: 'Shared Read Access',
    description: 'Project knowledge is shared with merge rules',
    scope: 'shared',
    allowedOperations: ['read'],
    validator: (req: AccessRequest) => req.operation === 'read',
  },
];
