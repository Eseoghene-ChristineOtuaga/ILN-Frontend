# Accessibility Exception Process

This document defines the required process for requesting exceptions to accessibility violations in the ILN Frontend. All exceptions must be fully documented and traceable.

## Overview

Accessibility violations should be fixed rather than suppressed. However, rare cases may require temporary exceptions due to:
- Third-party library limitations
- Browser-specific constraints  
- Vendor requirements
- Planned future remediation

All exceptions require explicit owner approval and time-bound remediation tracking.

## Exception Request Template

### Required Metadata

Every exception MUST include:

```json
{
  "id": "a11y-exception-YYYY-MM-DD-001",
  "owner": "team@example.com",
  "violation": "color-contrast",
  "severity": "minor|moderate|major|critical",
  "component": "path/to/component.tsx",
  "reason": "Third-party dropdown library does not support WCAG AA contrast ratios",
  "userImpact": "Button text appears in gray on white background with 3.5:1 contrast. Affects <2% of users with vision deficiency per analytics.",
  "expiryDate": "2025-01-31",
  "remediationPlan": "Upgrade to v3.0 of dropdown library (ETA: 2024-Q4) or implement custom wrapper.",
  "status": "active|resolved|deferred"
}
```

### Field Definitions

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier: `a11y-exception-YYYY-MM-DD-###` |
| `owner` | Yes | Team/person responsible for remediation |
| `violation` | Yes | Lighthouse/axe rule name (e.g., `color-contrast`) |
| `severity` | Yes | WCAG impact level |
| `component` | Yes | File path where violation occurs |
| `reason` | Yes | Technical justification for exception |
| `userImpact` | Yes | Quantified user impact; never "none" |
| `expiryDate` | Yes | Latest date exception remains valid (max 90 days) |
| `remediationPlan` | Yes | Specific steps to fix; not "TBD" |
| `status` | Yes | Current state (active/resolved/deferred) |

## Process Steps

### 1. Identify Violation
Run Lighthouse CI or component tests and identify violations:
```bash
pnpm test:a11y
# or
pnpm lighthouse:ci
```

### 2. Attempt Fix
Before requesting an exception, attempt remediation:
- Update component or dependencies
- Implement wrapper/polyfill if needed
- Check for existing PRs addressing the issue

### 3. Document Exception
If fix is infeasible within sprint, create exception in `.lighthouseci/a11y-exceptions.json`:

```json
{
  "exceptions": [
    {
      "id": "a11y-exception-2024-10-17-001",
      "owner": "design-team",
      "violation": "color-contrast",
      "severity": "minor",
      "component": "src/components/DeprecatedButton.tsx",
      "reason": "Legacy component maintained for backward compatibility. Design system button is the preferred replacement.",
      "userImpact": "Affects users with moderate vision deficiency. Workaround: use new Button component.",
      "expiryDate": "2025-01-31",
      "remediationPlan": "Migrate all call sites to new Button component and remove DeprecatedButton in v2.0.",
      "status": "active"
    }
  ]
}
```

### 4. Add Test Suppression (Minimal)
If exception is approved, suppress violation ONLY in test configuration with inline comment:

```typescript
// Suppressed: a11y-exception-2024-10-17-001
// Button contrast ratio is 3.5:1 due to legacy design system.
// Remediation: migrate to new Button component.
// Expires: 2025-01-31
const { violations } = await axe(container, {
  rules: {
    "color-contrast": { enabled: false }
  }
});
```

### 5. Weekly Review
On Fridays, report active exceptions:
```bash
pnpm run a11y:check-exceptions
```

Output:
```
⚠️  3 active exceptions (2 expiring within 30 days)
  - a11y-exception-2024-10-17-001: expires 2025-01-31 (35 days)
  - a11y-exception-2024-09-20-005: expires 2024-11-20 (13 days) ⏰ URGENT
  - a11y-exception-2024-08-15-003: expired 2024-10-10 ❌ DELINQUENT
```

### 6. Close Exception
Mark as resolved when fixed:

```json
{
  "id": "a11y-exception-2024-10-17-001",
  "status": "resolved",
  "resolvedDate": "2024-11-15",
  "resolutionMethod": "Upgraded dropdown library to v3.0"
}
```

## Monitoring & Enforcement

### CI Gate
Lighthouse CI fails if:
- Violations exist without documented exceptions
- Exceptions are expired (> 90 days)
- Exceptions lack required fields

### Dashboard
Track exception status in `.lighthouseci/exception-dashboard.md`:
- Total active exceptions (target: 0)
- Violations by severity
- Expiring soon (< 30 days)
- Overdue closures

### Escalation
- 30 days to expiry: Slack notification to owner
- 60 days overdue: Block PR merges
- 90 days overdue: Auto-escalate to accessibility lead

## Component Test Alignment

Component tests (vitest/Testing Library) MUST match Lighthouse:

```typescript
describe("Button", () => {
  it("meets WCAG AA color contrast", async () => {
    render(<Button>Click me</Button>);
    const results = await axe(screen.getByRole("button"));
    expect(results.violations).toEqual([]);
  });
});
```

## Severity Levels

| Level | WCAG | Examples | Max Duration |
|-------|------|----------|--------------|
| Minor | AAA only | Focus indicator spacing | 90 days |
| Moderate | Level AA | Color contrast 4.5:1 | 60 days |
| Major | Level A | Missing alt text | 30 days |
| Critical | Unrelated | Total keyboard navigation failure | 7 days |

Critical violations block immediate merge; escalate to engineering lead.

## Examples

### Valid Exception
✅ Clear reason, quantified impact, specific remediation plan

### Invalid Exception
❌ "Users don't care about this"  
❌ "We'll fix it later"  
❌ "This is a third-party library issue" (no remediation plan)

## Questions?

Refer to:
- WCAG Guidelines: https://www.w3.org/WAI/WCAG21/quickref/
- Lighthouse Audits: https://developers.google.com/web/tools/lighthouse
- axe DevTools Rules: https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md
