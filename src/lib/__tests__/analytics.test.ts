import { describe, expect, it, vi } from 'vitest';
import {
  trackEvent,
  ANALYTICS_EVENT,
  type AnalyticsPayload,
  redactTelemetryPayload,
  redactTelemetryValue,
  REDACTED_ADDRESS,
  REDACTED_NICKNAME,
  REDACTED_PROVIDER_STATE,
} from '../analytics';

describe('analytics telemetry redaction (#1, wave-9)', () => {
  const TEST_WALLET_G = 'GBZXN7PIRZGNMHGA728R46MQ7ONLC3O3PNGGATUACCGWGL72WNZKSCGS';
  const TEST_CONTRACT_C = 'CA3D5KRYMCMCZKPO726DAKGCC6NGDZ6RX5UKST5FD5BH2WC4TDTNXWZX';

  it('dispatches an analytics CustomEvent with name and props', () => {
    const listener = vi.fn();
    window.addEventListener(ANALYTICS_EVENT, listener as EventListener);

    trackEvent('wallet_connected', { provider: 'freighter' });

    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0][0] as CustomEvent<AnalyticsPayload>).detail;
    expect(detail.name).toBe('wallet_connected');
    expect(detail.props).toEqual({ provider: 'freighter' });

    window.removeEventListener(ANALYTICS_EVENT, listener as EventListener);
  });

  describe('Wallet Address Redaction', () => {
    it('redacts wallet address properties to [REDACTED_ADDRESS]', () => {
      const sanitized = redactTelemetryPayload({
        address: TEST_WALLET_G,
        walletAddress: TEST_WALLET_G,
        publicKey: TEST_WALLET_G,
        recipient: TEST_WALLET_G,
        funder: TEST_WALLET_G,
      });

      expect(sanitized).toEqual({
        address: REDACTED_ADDRESS,
        walletAddress: REDACTED_ADDRESS,
        publicKey: REDACTED_ADDRESS,
        recipient: REDACTED_ADDRESS,
        funder: REDACTED_ADDRESS,
      });
    });

    it('redacts embedded Stellar addresses within strings', () => {
      const message = `Payment failed for destination account ${TEST_WALLET_G} on contract ${TEST_CONTRACT_C}`;
      const sanitized = redactTelemetryPayload({ error_message: message });

      expect(sanitized?.error_message).toBe(
        `Payment failed for destination account ${REDACTED_ADDRESS} on contract ${REDACTED_ADDRESS}`
      );
    });

    it('redacts wallet addresses embedded in the event name itself', () => {
      const listener = vi.fn();
      window.addEventListener(ANALYTICS_EVENT, listener as EventListener);

      trackEvent(`invoice_funded_by_${TEST_WALLET_G}`, { amount: 100 });

      expect(listener).toHaveBeenCalledTimes(1);
      const detail = (listener.mock.calls[0][0] as CustomEvent<AnalyticsPayload>).detail;
      expect(detail.name).toBe(`invoice_funded_by_${REDACTED_ADDRESS}`);

      window.removeEventListener(ANALYTICS_EVENT, listener as EventListener);
    });
  });

  describe('Nickname Redaction', () => {
    it('redacts contact and user nicknames to [REDACTED_NICKNAME]', () => {
      const sanitized = redactTelemetryPayload({
        nickname: "Alice's Savings",
        contactName: 'Bob Primary',
        entryNickname: 'Freelancer Charlie',
      });

      expect(sanitized).toEqual({
        nickname: REDACTED_NICKNAME,
        contactName: REDACTED_NICKNAME,
        entryNickname: REDACTED_NICKNAME,
      });
    });
  });

  describe('Provider State Redaction', () => {
    it('redacts provider internal state and credentials to [REDACTED_PROVIDER_STATE]', () => {
      const sanitized = redactTelemetryPayload({
        providerState: { session: 'session-token-123', isConnected: true },
        sessionData: 'wc_session_data_here',
        sessionUri: 'wc:topic123@2?relay-protocol=irn',
        privateKey: 'SSECRET...',
        secretKey: 'SSECRET...',
      });

      expect(sanitized).toEqual({
        providerState: REDACTED_PROVIDER_STATE,
        sessionData: REDACTED_PROVIDER_STATE,
        sessionUri: REDACTED_PROVIDER_STATE,
        privateKey: REDACTED_PROVIDER_STATE,
        secretKey: REDACTED_PROVIDER_STATE,
      });
    });

    it('preserves safe provider string identifiers while redacting complex provider objects', () => {
      const withSafeProvider = redactTelemetryPayload({ provider: 'freighter' });
      expect(withSafeProvider).toEqual({ provider: 'freighter' });

      const withComplexProvider = redactTelemetryPayload({
        provider: { id: 'walletconnect', internalSession: 'xyz' },
      });
      expect(withComplexProvider).toEqual({ provider: REDACTED_PROVIDER_STATE });
    });
  });

  describe('Deep Traversal & Safe Resilience', () => {
    it('redacts sensitive values within nested objects and arrays', () => {
      const complexPayload = {
        metadata: {
          signers: [TEST_WALLET_G, 'non-address-id'],
          details: {
            nickname: 'Alice Secret',
            provider_state: { active: true },
          },
        },
      };

      const sanitized = redactTelemetryPayload(complexPayload);

      expect(sanitized).toEqual({
        metadata: {
          signers: [REDACTED_ADDRESS, 'non-address-id'],
          details: {
            nickname: REDACTED_NICKNAME,
            provider_state: REDACTED_PROVIDER_STATE,
          },
        },
      });
    });

    it('handles circular references without throwing or exceeding call stack', () => {
      const circular: Record<string, unknown> = { key: 'value' };
      circular.self = circular;

      expect(() => redactTelemetryPayload(circular)).not.toThrow();
      const sanitized = redactTelemetryPayload(circular);
      expect((sanitized as Record<string, unknown>).self).toBe('[CIRCULAR]');
    });
  });
});
