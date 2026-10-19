# Browser/Indexer Data Boundary

This document defines the authoritative data boundary between the ILN frontend browser components and the indexer service, including ownership, authentication, schema contracts, timeout configurations, and operational escalation paths.

## Overview

The ILN frontend components consume data from an external indexer service that aggregates on-chain protocol events and analytics. This boundary ensures that all browser-side indexer access follows a single authoritative contract with explicit error handling, schema validation, and operational safeguards.

## Data Access Patterns

### Environment Variables

All indexer endpoints are configured via environment variables to enforce a single source of truth:

| Variable | Scope | Purpose | Default |
|----------|-------|---------|---------|
| `NEXT_PUBLIC_INDEXER_API_URL` | Browser (client-side) | REST API for activity feeds, analytics charts | `https://api.iln.example.com` |
| `NEXT_PUBLIC_INDEXER_WS_URL` | Browser (client-side) | WebSocket for real-time updates | `ws://localhost:8080/ws` |
| `INDEXER_URL` | Server-side | Server-side indexer access (leaderboard, API routes) | (no default) |

**Important**: All browser components MUST use `NEXT_PUBLIC_INDEXER_API_URL` for REST API calls. Server-side code MUST use `INDEXER_URL`. Mixing these scopes is a security violation.

### Authorized Components

The following components are authorized to access the indexer:

| Component | Endpoint | Method | Data Type |
|-----------|----------|--------|-----------|
| `ActivityFeed.tsx` | `/invoice/{invoiceId}/events` | GET | Invoice event history |
| `DefaultRateChart.tsx` | `/analytics/defaults?period=12m` | GET | Protocol default rate analytics |
| `FundingChart.tsx` | `/v1/analytics/funding?period={range}` | GET | LP funding volume history |
| `leaderboard.ts` (server) | `/leaderboard?type={type}&period={period}` | GET | Protocol leaderboard data |

### Access Boundary Rules

1. **Single API Base**: All REST API calls MUST use `NEXT_PUBLIC_INDEXER_API_URL` as the base URL. Hardcoded URLs are prohibited.
2. **No Direct Contract Access**: Browser components MUST NOT query the Soroban smart contract directly for aggregated analytics data. All aggregated analytics MUST come through the indexer.
3. **Cache Strategy**: Use `cache: 'no-store'` for event feeds to ensure fresh data. Analytics data may use browser cache.
4. **Fallback Behavior**: Mock data fallbacks are ONLY permitted in development mode (`NODE_ENV === 'development'`). Production MUST fail explicitly.

## Schema Contracts

### Invoice Events API

**Endpoint**: `GET {NEXT_PUBLIC_INDEXER_API_URL}/invoice/{invoiceId}/events`

**Request Parameters**:
- `invoiceId` (path): BigInt identifier of the invoice

**Response Schema**:
```typescript
interface RawInvoiceEvent {
  type?: string;              // Event type (e.g., "submitted", "funded", "paid")
  timestamp?: number | string; // Unix timestamp or ISO string
  actor?: string;            // Stellar public key of the actor
  data?: Record<string, unknown>; // Event-specific payload (e.g., amount)
  [key: string]: unknown;     // Additional properties
}
```

**Expected Event Types**:
- `submitted`, `invoice_submitted` → Invoice submitted to protocol
- `funded`, `invoice_funded` → Invoice funded by LP
- `paid`, `invoice_paid` → Invoice settled by payer
- `partially_paid`, `invoice_partially_paid`, `partial_payment` → Partial payment
- `defaulted`, `invoice_defaulted` → Invoice defaulted
- `cancelled`, `invoice_cancelled` → Invoice cancelled
- `dispute_raised`, `invoice_disputed` → Dispute opened
- `dispute_resolved`, `invoice_resolved` → Dispute resolved

**Error Responses**:
- `404`: Invoice not found
- `500`: Indexer internal error
- `503`: Indexer unavailable

### Default Rate Analytics API

**Endpoint**: `GET {NEXT_PUBLIC_INDEXER_API_URL}/analytics/defaults?period=12m`

**Request Parameters**:
- `period` (query): Time period (e.g., "12m", "6m", "30d")

**Response Schema**:
```typescript
interface MonthlyDefaultBucket {
  date: string;           // ISO date string (YYYY-MM)
  label: string;         // Display label (e.g., "Jan 2024")
  defaulted: number;     // Count of defaulted invoices
  funded: number;        // Count of funded invoices
  defaultRate: number;   // Percentage (0-100)
}

interface AnalyticsResponse {
  monthly?: MonthlyDefaultBucket[];
  // or directly an array of buckets
}
```

**Error Responses**:
- `400`: Invalid period parameter
- `500`: Indexer internal error
- `503`: Indexer unavailable

### Funding Analytics API

**Endpoint**: `GET {NEXT_PUBLIC_INDEXER_API_URL}/v1/analytics/funding?period={range}`

**Request Parameters**:
- `period` (query): Time range ("7d", "30d", "90d", "all")

**Response Schema**:
```typescript
interface TokenFunding {
  symbol: string;          // Token symbol (USDC, EURC, XLM)
  amount: number;          // Whole unit amount
  color: string;          // Display color (hex or CSS var)
}

interface DailyFundingBucket {
  date: string;                    // ISO date string (YYYY-MM-DD)
  label: string;                   // Display label (e.g., "Jan 15")
  total_usdc_equiv: number;        // Total funding in USDC equivalent
  invoices_funded: number;         // Count of funded invoices
  tokens: TokenFunding[];          // Token breakdown
}

interface FundingResponse {
  daily: DailyFundingBucket[];
}
```

**Error Responses**:
- `400`: Invalid period parameter
- `500`: Indexer internal error
- `503`: Indexer unavailable

### Leaderboard API (Server-Side)

**Endpoint**: `GET {INDEXER_URL}/leaderboard?type={type}&period={period}`

**Request Parameters**:
- `type` (query): Leaderboard type (e.g., "lp", "freelancer")
- `period` (query): Time period (e.g., "30d", "all")

**Response Schema**:
```typescript
interface LeaderboardEntry {
  address: string;      // Stellar public key
  score: number;        // Leaderboard score
  rank: number;         // Current rank
  [key: string]: unknown; // Additional fields
}
```

**Error Responses**:
- `400`: Invalid parameters
- `500`: Indexer internal error
- `503`: Indexer unavailable

## Timeout Configuration

All indexer API calls MUST include explicit timeout configurations:

| Endpoint Type | Timeout | Rationale |
|---------------|---------|-----------|
| Activity Feed | 10 seconds | Event history is critical for invoice pages |
| Analytics Charts | 15 seconds | Analytics can tolerate slight delays |
| Leaderboard | 10 seconds | Leaderboard data is cached server-side |
| WebSocket | 30 seconds (connection) | Initial connection timeout |

**Implementation**:
```typescript
// Use AbortController for timeout control
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

try {
  const res = await fetch(url, {
    signal: controller.signal,
    cache: 'no-store',
  });
  clearTimeout(timeoutId);
  // Handle response
} catch (error) {
  if (error.name === 'AbortError') {
    // Handle timeout
  }
  // Handle other errors
}
```

## Error Handling & Recovery

### Client-Side Error States

Components MUST implement explicit error states:

1. **Loading State**: Show loading indicator while fetching
2. **Error State**: Show user-friendly error message on failure
3. **Empty State**: Show appropriate message when no data exists
4. **Retry Mechanism**: Provide manual retry option for transient failures

### Error Types & Recovery

| Error Type | User Message | Recovery Action |
|------------|--------------|-----------------|
| Network Error | "Unable to connect to indexer service" | Retry button, check network |
| Timeout | "Request timed out. Please try again." | Retry button |
| 404 Not Found | "Data not found" | No retry, show empty state |
| 500/503 | "Indexer service temporarily unavailable" | Retry button, escalate if persistent |
| Malformed Data | "Received invalid data from indexer" | Log error, show fallback UI, escalate |

### Schema Validation

Components MUST validate indexer responses before rendering:

```typescript
function validateInvoiceEvent(event: unknown): event is RawInvoiceEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  // Allow optional fields but ensure structure
  return true; // Implement specific validation
}
```

### Mock Data Policy

**Development Mode**: Mock data fallbacks are permitted when `NODE_ENV === 'development'`.

**Production Mode**: Mock data fallbacks are PROHIBITED. Components MUST fail explicitly and show error states.

**Audit Required**: The ActivityFeed component currently has a mock data fallback with `|| true` which MUST be removed. See [Issue #1114](https://github.com/Invoice-Liquidity-Network/ILN-Frontend/issues/1114) for resolution.

## Authentication & Authorization

### Current State

The indexer service does not currently implement authentication. Access is based on:

1. **CORS Configuration**: The indexer must allow CORS requests from the ILN frontend domain
2. **Rate Limiting**: The indexer should implement rate limiting to prevent abuse
3. **IP Whitelisting** (Optional): Production indexer may whitelist CI/CD IPs

### Future Auth Requirements

When authentication is added to the indexer:

1. **API Key Authentication**: Use `NEXT_PUBLIC_INDEXER_API_KEY` for client-side requests
2. **Bearer Token**: Include token in Authorization header
3. **Token Rotation**: Implement token rotation mechanism for long-running sessions
4. **Scope-Based Access**: Different endpoints may require different scopes

## Operational Escalation Paths

### Incident Severity Levels

| Severity | Description | Response Time | Escalation |
|----------|-------------|---------------|------------|
| P0 | Indexer completely down, all data unavailable | 15 minutes | Page on-call DevOps |
| P1 | Indexer degraded, partial data unavailable | 1 hour | Create incident, notify team |
| P2 | Indexer slow, timeouts occurring | 4 hours | Create ticket, monitor |
| P3 | Minor data inconsistencies | 1 business day | Create ticket |

### Monitoring & Alerting

The following metrics should be monitored:

1. **Indexer Availability**: Uptime percentage (target: 99.9%)
2. **Response Time**: p50, p95, p99 latency
3. **Error Rate**: 4xx/5xx response percentage
4. **Data Freshness**: Time from on-chain event to indexer availability

### Escalation Contacts

- **On-Call DevOps**: [Contact info in internal docs]
- **Indexer Service Owner**: [Contact info in internal docs]
- **Frontend Team Lead**: [Contact info in internal docs]

## Testing Requirements

### Unit Tests

- Schema validation functions for each API response type
- Error handling logic for each error state
- Timeout configuration verification

### Integration Tests

- Mock indexer server for testing component behavior
- Test malformed data responses
- Test timeout scenarios
- Test retry mechanisms

### E2E Tests

- Verify components display error states correctly
- Verify retry functionality works
- Verify data consistency across components (see [Issue #1114](https://github.com/Invoice-Liquidity-Network/ILN-Frontend/issues/1114))

## Security Considerations

### Data Privacy

- **No Sensitive Data in URLs**: Invoice IDs are public, but ensure no sensitive data is exposed
- **Sanitize User Input**: All user inputs passed to indexer must be sanitized
- **Rate Limiting**: Implement client-side rate limiting to prevent abuse

### Supply Chain Security

- **Lockfile Integrity**: Verify `pnpm-lock.yaml` integrity after dependency updates
- **Dependency Audit**: Run `pnpm audit` regularly (automated in CI)
- **Known Vulnerabilities**: Block merges on moderate or higher severity CVEs

## Compliance & Auditing

### Audit Trail

All indexer API calls should be logged for audit purposes:

- Timestamp
- Endpoint called
- Request parameters
- Response status
- Error details (if applicable)

### Data Retention

- Access logs retained for 90 days
- Error logs retained for 1 year
- Incident reports retained indefinitely

## References

- [Issue #1115](https://github.com/Invoice-Liquidity-Network/ILN-Frontend/issues/1115) - This documentation
- [Issue #1114](https://github.com/Invoice-Liquidity-Network/ILN-Frontend/issues/1114) - Chart and feed consistency testing
- [CI/CD Overview](docs/ci-cd.md) - Workflow and pipeline documentation
- [Incident Response](docs/incident-response.md) - Security incident response process

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-16 | Initial documentation | Devin AI |
