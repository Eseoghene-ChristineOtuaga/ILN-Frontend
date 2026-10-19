/**
 * SEP-10 session lifecycle management.
 *
 * Tracks session expiry, handles refresh or reauthentication, and clears
 * expired credentials without leaking them across page loads.
 *
 * #1075: Add SEP-10 session expiry handling
 */

export interface Sep10Session {
  /** JWT issued by the server after a successful SEP-10 challenge/response. */
  token: string;
  /** Stellar account address the session was issued for. */
  accountId: string;
  /** Unix timestamp (seconds) when this session expires. */
  expiresAt: number;
  /** Home domain that issued the challenge for this session. */
  homeDomain: string;
}

export type SessionExpiredReason = 'token_expired' | 'explicit_logout' | 'account_changed';

export type ReauthCallback = () => Promise<Sep10Session | null>;

const SESSION_STORAGE_KEY = 'iln:sep10:session';

// ─── Storage helpers (sessionStorage so sessions don't survive tab close) ────

function writeSession(session: Sep10Session): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable (SSR, private mode) — hold only in memory
  }
}

function readPersistedSession(): Sep10Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Sep10Session;
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.accountId === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      typeof parsed.homeDomain === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearPersistedSession(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ─── Session manager ─────────────────────────────────────────────────────────

export class Sep10SessionManager {
  private session: Sep10Session | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiredListeners: Array<(reason: SessionExpiredReason) => void> = [];

  constructor() {
    // Hydrate from sessionStorage on construction (client only)
    if (typeof window !== 'undefined') {
      const persisted = readPersistedSession();
      if (persisted && !this.isExpired(persisted)) {
        this.session = persisted;
        this.scheduleExpiry(persisted);
      } else if (persisted) {
        clearPersistedSession();
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getSession(): Sep10Session | null {
    if (!this.session) return null;
    if (this.isExpired(this.session)) {
      this.expire('token_expired');
      return null;
    }
    return this.session;
  }

  /** Returns the Bearer token if the session is valid, otherwise null. */
  getToken(): string | null {
    return this.getSession()?.token ?? null;
  }

  /** Returns true if a non-expired session exists for the given account. */
  hasValidSession(accountId?: string): boolean {
    const s = this.getSession();
    if (!s) return false;
    if (accountId && s.accountId !== accountId) return false;
    return true;
  }

  /** Store a newly issued session, replacing any prior one. */
  setSession(session: Sep10Session): void {
    this.clearExpiry();
    this.session = session;
    writeSession(session);
    this.scheduleExpiry(session);
  }

  /** Explicitly invalidate the current session (e.g. user logout). */
  clearSession(reason: SessionExpiredReason = 'explicit_logout'): void {
    this.clearExpiry();
    this.session = null;
    clearPersistedSession();
    this.notifyExpired(reason);
  }

  /**
   * Attempt to refresh an expiring session.
   *
   * If `reauthCallback` returns a new session, it is stored and returned.
   * If it returns null or throws, the current session is cleared.
   */
  async refresh(reauthCallback: ReauthCallback): Promise<Sep10Session | null> {
    try {
      const newSession = await reauthCallback();
      if (newSession) {
        this.setSession(newSession);
        return newSession;
      }
      this.clearSession('token_expired');
      return null;
    } catch {
      this.clearSession('token_expired');
      return null;
    }
  }

  /** Register a listener called whenever the session expires for any reason. */
  onExpired(cb: (reason: SessionExpiredReason) => void): () => void {
    this.expiredListeners.push(cb);
    return () => {
      this.expiredListeners = this.expiredListeners.filter((l) => l !== cb);
    };
  }

  /** True if the session token has passed its expiry timestamp. */
  isExpired(session: Sep10Session): boolean {
    return Math.floor(Date.now() / 1000) >= session.expiresAt;
  }

  /**
   * Seconds remaining before the session expires.
   * Returns 0 if expired or no session.
   */
  secondsUntilExpiry(): number {
    const s = this.session;
    if (!s) return 0;
    return Math.max(0, s.expiresAt - Math.floor(Date.now() / 1000));
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private scheduleExpiry(session: Sep10Session): void {
    this.clearExpiry();
    const msRemaining = (session.expiresAt - Math.floor(Date.now() / 1000)) * 1000;
    if (msRemaining <= 0) {
      this.expire('token_expired');
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expire('token_expired');
    }, msRemaining);
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private expire(reason: SessionExpiredReason): void {
    this.clearExpiry();
    this.session = null;
    clearPersistedSession();
    this.notifyExpired(reason);
  }

  private notifyExpired(reason: SessionExpiredReason): void {
    for (const cb of this.expiredListeners) {
      try {
        cb(reason);
      } catch {
        // listener errors must not break session management
      }
    }
  }
}

/** Singleton session manager shared across the application. */
export const sep10Session = new Sep10SessionManager();
