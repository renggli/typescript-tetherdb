import { TetherServerError, TetherServerErrorCode } from '../errors.js';

/**
 * Maps a TetherServerError (or unknown error) to an appropriate HTTP status code.
 *
 * @param err - Error instance.
 * @returns HTTP status code (e.g. 400, 401, 403, 404, 409, 413, 500, 501).
 */
export function getHttpStatusForError(err: unknown): number {
  if (err instanceof TetherServerError) {
    switch (err.code) {
      case TetherServerErrorCode.InvalidInput:
      case TetherServerErrorCode.ConfigurationError:
        return 400;
      case TetherServerErrorCode.Unauthorized:
      case TetherServerErrorCode.AuthenticationFailed:
        return 401;
      case TetherServerErrorCode.Forbidden:
        return 403;
      case TetherServerErrorCode.NotFound:
        return 404;
      case TetherServerErrorCode.AlreadyExists:
        return 409;
      case TetherServerErrorCode.LimitExceeded:
        return 413;
      case TetherServerErrorCode.NotSupported:
        return 501;
      case TetherServerErrorCode.InternalError:
        return 500;
    }
  }
  return 500;
}
