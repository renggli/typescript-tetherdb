import { describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/errors.js';

describe('TetherServerError', () => {
  it('should initialize with code and default message', () => {
    const err = new TetherServerError(TetherServerErrorCode.InvalidInput);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TetherServerError);
    expect(err.name).toBe('TetherServerError');
    expect(err.code).toBe(TetherServerErrorCode.InvalidInput);
    expect(err.message).toBe('Invalid request parameter');
  });

  it('should initialize with custom message', () => {
    const err = new TetherServerError(
      TetherServerErrorCode.NotFound,
      'Resource not found',
    );
    expect(err.code).toBe(TetherServerErrorCode.NotFound);
    expect(err.message).toBe('Resource not found');
  });

  it('should provide default messages for all server error codes', () => {
    const codes = [
      TetherServerErrorCode.InvalidInput,
      TetherServerErrorCode.NotFound,
      TetherServerErrorCode.AlreadyExists,
      TetherServerErrorCode.Unauthorized,
      TetherServerErrorCode.Forbidden,
      TetherServerErrorCode.AuthenticationFailed,
      TetherServerErrorCode.LimitExceeded,
      TetherServerErrorCode.ConfigurationError,
      TetherServerErrorCode.NotSupported,
      TetherServerErrorCode.InternalError,
    ];

    for (const code of codes) {
      const err = new TetherServerError(code);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
