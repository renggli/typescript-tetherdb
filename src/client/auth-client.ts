/**
 * Result returned upon successful user registration or login.
 */
export interface AuthResult {
  /** Authenticated user details. */
  user: {
    /** Unique user identifier (UUID). */
    id: string;
    /** User's unique username. */
    username: string;
  };
  /** Signed session authentication token for sync and API calls. */
  token: string;
}

/**
 * Credentials payload for registering or logging in.
 */
export interface AuthCredentials {
  /** Unique username. */
  username: string;
  /** Account password. */
  password: string;
}

/**
 * Options for configuring a TetherAuthClient.
 */
export interface AuthClientOptions {
  /** Base HTTP URL of the TetherDB server (e.g. 'http://localhost:8080'). */
  serverUrl: string;
  /** Optional custom fetch implementation. */
  fetch?: typeof fetch;
}

/**
 * Lightweight HTTP client for TetherDB authentication endpoints (`/auth/register`, `/auth/login`, `/health`).
 */
export class TetherAuthClient {
  private serverUrl: string;
  private fetchFn: typeof fetch;

  /**
   * Initializes a new TetherAuthClient instance.
   *
   * @param options - Configuration options.
   */
  constructor(options: AuthClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    const rawFetch =
      options.fetch ??
      (typeof globalThis !== 'undefined' && globalThis.fetch
        ? globalThis.fetch
        : typeof fetch !== 'undefined'
          ? fetch
          : undefined);

    if (!rawFetch) {
      throw new Error('No fetch implementation available');
    }
    this.fetchFn = rawFetch.bind(globalThis);
  }

  /**
   * Registers a new user account and returns an authenticated session with token.
   *
   * @param credentials - Username and password for the new account.
   * @returns A promise resolving to the authentication result.
   */
  async register(credentials: AuthCredentials): Promise<AuthResult> {
    const res = await this.fetchFn(`${this.serverUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    const data = (await res.json()) as AuthResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? 'Registration failed');
    }
    return data;
  }

  /**
   * Authenticates an existing user account and returns an authenticated session with token.
   *
   * @param credentials - Username and password credentials.
   * @returns A promise resolving to the authentication result.
   */
  async login(credentials: AuthCredentials): Promise<AuthResult> {
    const res = await this.fetchFn(`${this.serverUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    const data = (await res.json()) as AuthResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? 'Authentication failed');
    }
    return data;
  }

  /**
   * Checks the health status of the server.
   *
   * @returns A promise resolving to `true` if server is healthy.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.serverUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
