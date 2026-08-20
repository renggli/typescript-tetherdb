/**
 * Error codes identifying broader server-side error categories.
 */
export enum TetherServerErrorCode {
  /** The requested input or parameter is invalid or malformed. */
  InvalidInput,
  /** The requested resource (user, application, or table) was not found. */
  NotFound,
  /** The resource (user, application, or table) already exists. */
  AlreadyExists,
  /** Authentication is missing, invalid, or expired. */
  Unauthorized,
  /** The provided credentials are invalid. */
  AuthenticationFailed,
  /** A storage capacity or payload size limit was exceeded. */
  LimitExceeded,
  /** Configuration or command-line option is invalid. */
  ConfigurationError,
  /** The requested operation is not supported by this backend or engine. */
  NotSupported,
  /** An unexpected internal server error occurred. */
  InternalError,
}

/**
 * Dedicated error class for TetherDB server errors.
 * Error messages are user-safe and contain no internal technical details.
 */
export class TetherServerError extends Error {
  /** Error category code identifying the broad error type. */
  readonly code: TetherServerErrorCode;

  /**
   * Initializes a new `TetherServerError`.
   *
   * @param code - The error category code.
   * @param message - User-safe error description message.
   */
  constructor(code: TetherServerErrorCode, message?: string) {
    super(message ?? getDefaultServerErrorMessage(code));
    this.name = 'TetherServerError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// -- Private Helpers --------------------------------------------------------

function getDefaultServerErrorMessage(code: TetherServerErrorCode): string {
  switch (code) {
    case TetherServerErrorCode.InvalidInput:
      return 'Invalid request parameter';
    case TetherServerErrorCode.NotFound:
      return 'Requested resource not found';
    case TetherServerErrorCode.AlreadyExists:
      return 'Resource already exists';
    case TetherServerErrorCode.Unauthorized:
      return 'Authentication required';
    case TetherServerErrorCode.AuthenticationFailed:
      return 'Authentication failed';
    case TetherServerErrorCode.LimitExceeded:
      return 'Request or resource limit exceeded';
    case TetherServerErrorCode.ConfigurationError:
      return 'Server configuration error';
    case TetherServerErrorCode.NotSupported:
      return 'Operation not supported';
    case TetherServerErrorCode.InternalError:
      return 'Internal server error';
  }
}
