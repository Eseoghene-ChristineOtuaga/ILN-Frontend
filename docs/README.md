# Documentation Index

This directory contains the main contributor and operations documentation for the ILN Frontend project. Use this page as the starting point when you need context on architecture, testing, CI, accessibility, or implementation details.

## Core Guides

- **[architecture.md](architecture.md)** - Frontend architecture overview covering design decisions, folder structure, and major data-flow patterns.
- **[data-fetching-architecture.md](data-fetching-architecture.md)** - Consolidated TanStack Query data-fetching architecture, key factories, caching defaults, and mutation patterns.
- **[developer-quickstart.md](developer-quickstart.md)** - End-to-end setup guide from a fresh clone through local development and initial verification.
- **[testing.md](testing.md)** - Testing strategy and conventions for Vitest, Playwright, and other quality checks.
- **[ci-cd.md](ci-cd.md)** - GitHub Actions, deployment flow, and CI/CD runner guidance.

## Quality and Performance

- **[as-any-cast-inventory.md](as-any-cast-inventory.md)** - Complete audit and categorization of all 66 `as any` type casts outside test suites and the prioritized elimination roadmap.
- **[type-safety-report.md](type-safety-report.md)** - Before/after report for the `as any` hardening pass (66 → 30 casts, strictness flags, lint gate).
- **[slos.md](slos.md)** - Frontend Service Level Objectives (SLOs), SLIs, and concrete monitoring signals for performance, availability, and financial journeys.
- **[LIGHTHOUSE_CI.md](LIGHTHOUSE_CI.md)** - Lighthouse CI performance budgets, thresholds, and report review guidance.
- **[VISUAL_REGRESSION_WORKFLOW.md](VISUAL_REGRESSION_WORKFLOW.md)** - Chromatic visual regression workflow and approval process.
- **[frontend-trust-surface-rollback-runbook.md](frontend-trust-surface-rollback-runbook.md)** - Rollback and verification runbook for wallet, governance, and indexer trust surfaces.
- **[accessibility-audit-toast-notifications.md](accessibility-audit-toast-notifications.md)** - Accessibility audit notes for toast and notification flows.
- **[accessibility-implementation-summary.md](accessibility-implementation-summary.md)** - Summary of accessibility implementation work and supporting details.
- **[screen-reader-testing-guide.md](screen-reader-testing-guide.md)** - Manual testing checklist for screen-reader and keyboard accessibility.
- **[accessibility-conformance-statement.md](accessibility-conformance-statement.md)** - Public-facing WCAG 2.1 AA target, verification summary, and known limitations.
- **[bundle-size.md](bundle-size.md)** - Bundle size tracking strategy, threshold policy, and how to interpret CI's bundle-size PR comments.
- **[performance-monitoring.md](performance-monitoring.md)** - Real-user Core Web Vitals (RUM) capture and review, complementing the synthetic Lighthouse CI budgets.
- **[load-testing.md](load-testing.md)** - Large-scale load testing procedures and results for mainnet-scale invoice volumes.

## Product and Domain Documentation

- **[api-routes.md](api-routes.md)** - Reference for the API routes that power the frontend experience.
- **[contract-fixtures.md](contract-fixtures.md)** - Fixture and integration-test context for Stellar contract interactions.
- **[error-codes.md](error-codes.md)** - Error code catalog and troubleshooting notes.
- **[feature-flags.md](feature-flags.md)** - Overview of feature flags and current rollout settings.
- **[i18n.md](i18n.md)** - Internationalization setup and translation workflow details.
- **[indexer-data-boundary.md](indexer-data-boundary.md)** - Documentation of the browser/indexer data boundary, including schema contracts, authentication, timeout configuration, and operational escalation paths.
- **[repo-size-audit.md](repo-size-audit.md)** - Repository size analysis and optimization recommendations.
- **[supabase-setup.md](supabase-setup.md)** - Supabase configuration and local setup notes.
- **[backend-checklist-cross-link-coordination.md](backend-checklist-cross-link-coordination.md)** - Coordination record for cross-linking the smart-contract repo's mainnet launch checklist to the frontend readiness checklist.
- **[mainnet-frontend-readiness-checklist.md](mainnet-frontend-readiness-checklist.md)** - Consolidated frontend mainnet readiness checklist tying every category's closing artifact together for the go/no-go decision.
- **[notifications-surface-readiness-report.md](notifications-surface-readiness-report.md)** - Readiness of the `/notifications` route and real-time surface: category filtering, failure handling, and accepted risks.
- **[status-page-incident-tooling-readiness-report.md](status-page-incident-tooling-readiness-report.md)** - Readiness of the status page and incident tooling: what is automated, what is still manual, and open gaps.
- **[batch-closing-summary-scf-deliverable.md](batch-closing-summary-scf-deliverable.md)** - Category-by-category point tally and completion status for the current frontend hardening batch, as the SCF-facing deliverable record.
- **[contract-integration-status.md](contract-integration-status.md)** - Which frontend features are backed by live on-chain contracts versus stubbed, derived, or deferred.
- **[cross-repo-contract-sync-readiness.md](cross-repo-contract-sync-readiness.md)** - Readiness report for the joint frontend/backend contract-sync rehearsal.
- **[graphql-query-guidelines.md](graphql-query-guidelines.md)** - Guidelines for implementing GraphQL queries if/when the indexer's GraphQL endpoint is adopted.
- **[notifications-service.md](notifications-service.md)** - Failure modes for the two backend notifications-service surfaces the frontend consumes.
- **[payer-routes.md](payer-routes.md)** - Audit of payer-related routes.
- **[route-map.md](route-map.md)** - Every canonical page route, its purpose, primary consumer, and active redirects.
- **[pwa-manifest-audit.md](pwa-manifest-audit.md)** - Production-readiness audit of the PWA manifest, icons, and install-prompt `<head>` tags.
- **[trust-critical-surface-walkthrough.md](trust-critical-surface-walkthrough.md)** - Live maintainer walkthrough script and sign-off record for vote casting, dark-feature flags, and admin actions.
- **[good-first-issue-candidates.md](good-first-issue-candidates.md)** - Curated list of self-contained issues suited to newcomers.
- **[doc-drift-prevention-report.md](doc-drift-prevention-report.md)** - Consolidated record of documentation drift found across this batch (route-map, testing.md, launch-notes, slos.md, contact-matrix), the fix applied to each, and the CI gate or process change that now prevents recurrence.

## Mainnet Launch Readiness: Dark-Feature Re-enablement

These runbooks define the step-by-step sequence for safely re-enabling each feature that ships dark at mainnet launch. Each runbook covers the readiness gate, flag flip, smoke test, visual regression check, and rollback plan, and cross-links the corresponding backend readiness work. All three features require both frontend and backend gates to be complete before the flag is flipped.

- **[insurance-pool-widget-reenablement-runbook.md](insurance-pool-widget-reenablement-runbook.md)** - Re-enablement checklist for the Insurance Pool widget (`NEXT_PUBLIC_INSURANCE_POOL_ENABLED`); cross-links the backend insurance pool contract audit gate.
- **[oracle-verification-badge-reenablement-runbook.md](oracle-verification-badge-reenablement-runbook.md)** - Re-enablement checklist for the Oracle Verification badge (`NEXT_PUBLIC_ORACLE_ENABLED`); cross-links the backend oracle_registry mainnet-readiness work.
- **[nft-display-reenablement-runbook.md](nft-display-reenablement-runbook.md)** - Re-enablement checklist for the Invoice NFT display (`NEXT_PUBLIC_NFT_ENABLED`); cross-links the backend ADR-007 NFT invoice representation work.

## Operations, Security, and Incident Readiness

- **[mainnet-deployment-runbook.md](mainnet-deployment-runbook.md)** - Frontend-specific counterpart to the smart-contract mainnet deployment process; covers the continuous-deploy model.
- **[mainnet-launch-notes.md](mainnet-launch-notes.md)** - User-facing mainnet launch narrative: what changes at cutover and what to expect.
- **[monitoring-runbook.md](monitoring-runbook.md)** - Monitoring strategy and its integration with backend services.
- **[incident-response.md](incident-response.md)** - Official frontend security incident response process.
- **[cross-repo-incident-coordination.md](cross-repo-incident-coordination.md)** - Protocol for coordinating incidents across frontend, smart contracts, indexer, and notifications.
- **[backend-mock-closure-audit.md](backend-mock-closure-audit.md)** - Sample audit of ILN-Smart-Contract issues closed as "replace/implement real/wire live" against the backend's current code, with proposed backend follow-ups.
- **[status-page-runbook.md](status-page-runbook.md)** - Status page setup and Communications Lead runbook.
- **[alert-routing-integration.md](alert-routing-integration.md)** - Wires frontend status-page component health into the shared alert-routing path.
- **[governance-mock-regression-retrospective.md](governance-mock-regression-retrospective.md)** - Post-mortem on governance write paths being closed as live while still mock-backed, and the controls added in response.
- **[game-day-exercise-report.md](game-day-exercise-report.md)** - Report from the frontend-focused incident game-day exercise (SEV-1/SEV-2 scenarios).
- **[compromised-dependency-playbook.md](compromised-dependency-playbook.md)** - Incident response steps for a compromised npm dependency scenario.
- **[indexer-downtime.md](indexer-downtime.md)** - How the frontend behaves, and which features fall back, when the indexer is down or degraded.
- **[security.md](security.md)** - Frontend security, SRI, wallet isolation, and transaction hardening policy.
- **[localstorage-sensitivity-audit.md](localstorage-sensitivity-audit.md)** - Audit of every localStorage key written by the frontend and its privacy/security classification.
- **[sentry-integration.md](sentry-integration.md)** - Production error tracking integration: source maps, alerting, and CSP violation feed.
- **[troubleshooting.md](troubleshooting.md)** - Common local setup issues, symptoms, and resolution steps.

## Hooks and Examples

- **[hooks/](hooks/)** - Detailed documentation for custom React hooks, including the authenticated-wallet hook reference.
- **[examples/](examples/)** - Example assets and snippets used across the documentation set.

---

Keep this index updated whenever new documentation is added to the docs directory so contributors can find it quickly.
