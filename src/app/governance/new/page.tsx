// The routed page lives in `app/governance/new/page.tsx` (the root `app/`
// directory takes precedence over `src/app/`). This module re-exports it so
// the two copies cannot drift apart again; the previous copy here carried a
// hard-coded balance and a mock signer (#1055).
export { default } from '@/app/governance/new/page';
