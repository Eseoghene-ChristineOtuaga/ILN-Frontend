# Live testnet verification: governance protocol parameters (#844)

The production `fetchProtocolParameters()` implementation already reads governance
contract methods, the governance token, and invoice accepted tokens via Soroban
RPC. This opt-in smoke test verifies that production path against **real testnet
contracts**, without mocking `simulateTransaction`.

## Run

Provide deployed **testnet** contract IDs (not the invoice-contract defaults):

```sh
ILN_LIVE_GOVERNANCE_TESTNET=1 \
NEXT_PUBLIC_STELLAR_NETWORK=testnet \
NEXT_PUBLIC_NETWORK_PASSPHRASE='Test SDF Network ; September 2015' \
NEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org \
NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=<governance-contract-C-address> \
NEXT_PUBLIC_ILN_TOKEN_CONTRACT_ID=<governance-token-C-address> \
pnpm exec vitest run src/lib/governance/__tests__/protocol-parameters.testnet.test.ts
```

The test is **skipped by default** so ordinary CI does not depend on live RPC
availability. When explicitly enabled, missing/invalid contract IDs fail the
test rather than reporting a false success. A successful run checks real
contract-derived balances, quorum, token supply, decimals, and accepted tokens.
Unknown fee/discount rates are allowed: the invoice contract lacks current
rate getters, and historical events may be outside RPC retention.

This test does **not** write to the chain, require a wallet, or prove production
deployment readiness. Record the deployed IDs (public contract addresses),
network, date, and passing command output in the PR before claiming live
verification. Never include signing keys or other credentials.

## Status

Live testnet execution remains **unverified** until the opt-in command is run
with valid deployed governance and token contract IDs.
