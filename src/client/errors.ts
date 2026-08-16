/**
 * Error codes identifying broader client-side error categories.
 */
export enum TetherClientErrorCode {
  /** A required configuration option or parameter is missing. */
  MissingConfiguration,
  /** An invalid parameter or argument was provided to a client method. */
  InvalidInput,
  /** No suitable fetch implementation is available in the runtime environment. */
  FetchUnavailable,
  /** Network or connection failure when communicating with the server. */
  NetworkError,
  /** No valid credentials or session available for authentication. */
  MissingCredentials,
  /** User registration failed. */
  RegistrationFailed,
  /** User authentication / login failed. */
  AuthenticationFailed,
  /** Local storage operation failed. */
  StorageError,
  /** Real-time synchronization encountered an error. */
  SyncError,
}

/**
 * Dedicated error class for TetherDB client errors.
 * Error messages are user-safe and contain no internal technical details.
 */
export class TetherClientError extends Error {
  /** Error category code identifying the broad error type. */
  readonly code: TetherClientErrorCode;

  /**
   * Initializes a new `TetherClientError`.
   *
   * @param code - The error category code.
   * @param message - User-safe error description message.
   */
  constructor(code: TetherClientErrorCode, message?: string) {
    super(message ?? getDefaultClientErrorMessage(code));
    this.name = 'TetherClientError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// -- Private Helpers --------------------------------------------------------

function getDefaultClientErrorMessage(code: TetherClientErrorCode): string {
  switch (code) {
    case TetherClientErrorCode.MissingConfiguration:
      return 'Missing required configuration option.';
    case TetherClientErrorCode.InvalidInput:
      return 'Invalid input parameter provided.';
    case TetherClientErrorCode.FetchUnavailable:
      return 'No fetch implementation available.';
    case TetherClientErrorCode.NetworkError:
      return 'Network communication error.';
    case TetherClientErrorCode.MissingCredentials:
      return 'Missing authentication credentials.';
    case TetherClientErrorCode.RegistrationFailed:
      return 'Registration failed.';
    case TetherClientErrorCode.AuthenticationFailed:
      return 'Authentication failed.';
    case TetherClientErrorCode.StorageError:
      return 'Local storage operation failed.';
    case TetherClientErrorCode.SyncError:
      return 'Synchronization error.';
  }
}
