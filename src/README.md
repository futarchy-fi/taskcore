# Multi-Agent/Session Isolation System

## Overview

This module provides strict isolation for layered memory in multi-agent environments, ensuring that:
- Working memory is never shared between agents
- Active tool calls are per-session only
- Project knowledge is shared with merge rules
- Profile data is agent-specific
- Daily logs are append-only

## Architecture

The system consists of six core components:

### 1. **NamespaceIsolation** (`NamespaceIsolation.ts`)
Enforces namespace-based isolation between agents and sessions.

**Key Features:**
- Unique namespace generation per agent-session pair
- Cross-namespace access validation
- Shared namespace support (e.g., project knowledge)
- Agent-session lifecycle management

**Key Methods:**
```typescript
registerSession(agentId: AgentId, sessionId: SessionId): NamespaceId
validateCrossNamespaceAccess(sourceContext: IsolationContext, targetNamespaceId: NamespaceId)
grantSharedAccess(namespaceId: NamespaceId, granteeNamespaceId: NamespaceId)
```

### 2. **ReferenceValidator** (`ReferenceValidator.ts`)
Validates memory references and enforces isolation rules.

**Key Features:**
- Reference structure validation
- Cross-context reference detection
- Key format validation and sanitization
- Permission checking against isolation rules

**Key Methods:**
```typescript
validateAccess(request: AccessRequest): AccessResult
validateReference(reference: MemoryReference, context: IsolationContext)
canAccess(reference: MemoryReference, context: IsolationContext, operation): boolean
```

### 3. **ContaminationDetector** (`ContaminationDetector.ts`)
Detects and tracks memory contamination between agents and sessions.

**Key Features:**
- Real-time contamination detection
- Cross-session and cross-agent contamination tracking
- Event status tracking (contained, spreading, resolved)
- Data access logging for contamination analysis

**Key Methods:**
```typescript
detectFromAccess(request: AccessRequest): ContaminationEvent | null
checkContamination(source: IsolationContext, target: IsolationContext): ContaminationEvent | null
reportContamination(violation: IsolationViolation, dataKeys: string[]): ContaminationEvent
```

### 4. **AuditLogger** (`AuditLogger.ts`)
Provides comprehensive audit logging for compliance and debugging.

**Key Features:**
- Append-only log entries
- Event-level classification (info, warn, error)
- Agent/session filtering
- Time-range queries
- JSON export

**Key Methods:**
```typescript
logAccess(context: IsolationContext, targetId: string, operation: string, allowed: boolean)
logViolation(violation: IsolationViolation, action: string)
logContamination(context: IsolationContext, sourceContext: IsolationContext, dataKeys: string[], status: string)
exportLogs(): string
```

### 5. **ViolationHandler** (`ViolationHandler.ts`)
Handles isolation violations according to configured policy.

**Key Features:**
- Severity-based action mapping (log, warn, block, terminate)
- Context blocking/unblocking
- Violation callback registration
- Policy updates

**Key Methods:**
```typescript
handle(violation: IsolationViolation): ViolationHandlerResult
isBlocked(context: IsolationContext): boolean
onViolation(callback: ViolationCallback): () => void
updatePolicy(policy: Partial<ViolationPolicy>)
```

### 6. **IsolationManager** (`IsolationManager.ts`)
Main coordinator that integrates all isolation components.

**Key Features:**
- Unified API for all isolation operations
- Session lifecycle management
- Comprehensive statistics
- Configuration management

**Key Methods:**
```typescript
registerSession(agentId: string, sessionId: string): string
access(request: AccessRequest): AccessResult
checkContamination(source: IsolationContext, target: IsolationContext): ContaminationEvent | null
getStats(): { namespaces, contamination, audit, violations }
```

## Usage Examples

### Basic Setup

```typescript
import { IsolationManager } from './isolation/index.js';

// Create manager with default config
const manager = new IsolationManager({ strictMode: true });

// Register sessions for different agents
const ns1 = manager.registerSession('agent1', 'session1');
const ns2 = manager.registerSession('agent2', 'session1');
```

### Accessing Memory

```typescript
// Get context for a namespace
const context1 = manager.getContext(ns1)!;

// Attempt to read memory
const reference: MemoryReference = {
  id: 'ref1',
  agentId: 'agent1',
  sessionId: 'session1',
  layerId: ns1,
  key: 'memory/data',
  scope: 'session',
};

const result = manager.access({
  context: context1,
  target: reference,
  operation: 'read',
});

if (result.allowed) {
  // Access granted
} else {
  // Handle violation
  console.log('Access denied:', result.reason);
}
```

### Violation Handling

```typescript
// Register callback for violations
const unsubscribe = manager.onViolation((violation, result) => {
  console.log('Violation detected:', violation.type);
  console.log('Action taken:', result.action);
  console.log('Blocked:', result.blocked);
});

// Later: unsubscribe
unsubscribe();
```

### Shared Namespace Access

```typescript
// Grant shared access between namespaces
manager.grantSharedAccess(ns1, ns2);

// Revoke access
manager.revokeSharedAccess(ns1, ns2);
```

### Audit and Statistics

```typescript
// Get comprehensive statistics
const stats = manager.getStats();
console.log('Total namespaces:', stats.namespaces.totalNamespaces);
console.log('Contamination events:', stats.contamination.totalEvents);
console.log('Audit logs:', stats.audit.totalLogs);

// Export audit logs
const auditJson = manager.exportAuditLogs();
```

## Isolation Rules

The system enforces three built-in isolation rules:

1. **Agent Isolation** - Working memory is never shared between agents
2. **Session Isolation** - Active tool calls are per-session only
3. **Shared Read Access** - Project knowledge is shared with merge rules

Custom rules can be added by extending the `ISOLATION_RULES` array in `types.ts`.

## Violation Types

| Type | Severity | Description |
|-----|----------|-------------|
| `INVALID_REFERENCE` | low | Malformed reference |
| `CROSS_SESSION_READ` | medium | Read across sessions (same agent) |
| `CROSS_SESSION_WRITE` | medium | Write across sessions (same agent) |
| `CROSS_AGENT_READ` | high | Read across agents |
| `CROSS_AGENT_WRITE` | critical | Write across agents |
| `CONTAMINATION_DETECTED` | critical | Memory contamination detected |

## Violation Policy

Default actions by severity:
- `low`: log
- `medium`: warn
- `high`: block
- `critical`: terminate

The policy can be customized via `updateConfig()`:

```typescript
manager.updateConfig({
  violationPolicy: {
    defaultAction: 'block',
    severityActions: {
      low: 'log',
      medium: 'block',  // Changed from 'warn' to 'block'
      high: 'block',
      critical: 'terminate',
    },
  },
});
```

## Configuration Options

```typescript
interface IsolationConfig {
  strictMode: boolean;                    // Enable strict enforcement
  enableContaminationDetection: boolean;   // Enable contamination tracking
  enableAuditLogging: boolean;             // Enable audit logging
  violationPolicy: ViolationPolicy;       // Violation handling policy
  namespacePrefix: string;                // Prefix for namespace IDs
  sharedNamespaces: string[];             // List of shared namespace IDs
}
```

## Testing

Run the test suite:

```bash
npm test -- isolation.test.ts
```

The test suite includes 36 tests covering:
- Namespace registration and management
- Reference validation
- Contamination detection
- Audit logging
- Violation handling
- Integration scenarios
- Zero contamination goal validation

## Zero Contamination Goal

The system is designed to prevent all forms of memory contamination:

1. **Cross-agent isolation**: Complete isolation between different agents
2. **Cross-session isolation**: Sessions of the same agent are isolated
3. **Working memory protection**: Agent-specific working memory never shared
4. **Controlled sharing**: Only explicitly shared namespaces are accessible

The test suite validates these guarantees with dedicated tests under the "Zero Contamination Goal" describe block.

## Performance Considerations

- Memory usage: O(n) for active contexts where n = number of active sessions
- Access validation: O(1) for namespace lookup, O(m) for rule validation where m = number of rules
- Contamination detection: O(k) where k = number of tracked data keys per context
- Audit log: Capped at maxLogs (default: 10000 entries)

## Future Enhancements

Potential areas for extension:
- Distributed isolation (multi-host scenarios)
- Time-based isolation rules
- Advanced contamination detection algorithms
- Real-time monitoring dashboard
- Machine learning-based anomaly detection
- Blockchain-style audit trail

## API Reference

See individual TypeScript files for detailed API documentation and inline comments.
