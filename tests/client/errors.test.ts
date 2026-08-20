import { describe, expect, it } from 'vitest';
import {
  TetherClientError,
  TetherClientErrorCode,
} from '../../src/client/errors.js';

describe('TetherClientError', () => {
  it('should initialize with code and default message', () => {
    const err = new TetherClientError(
      TetherClientErrorCode.MissingConfiguration,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TetherClientError);
    expect(err.name).toBe('TetherClientError');
    expect(err.code).toBe(TetherClientErrorCode.MissingConfiguration);
    expect(err.message).toBe('Missing required configuration option');
  });

  it('should initialize with custom message', () => {
    const err = new TetherClientError(
      TetherClientErrorCode.FetchUnavailable,
      'Custom fetch error',
    );
    expect(err.code).toBe(TetherClientErrorCode.FetchUnavailable);
    expect(err.message).toBe('Custom fetch error');
  });

  it('should provide default messages for all client error codes', () => {
    const codes = [
      TetherClientErrorCode.MissingConfiguration,
      TetherClientErrorCode.InvalidInput,
      TetherClientErrorCode.FetchUnavailable,
      TetherClientErrorCode.NetworkError,
      TetherClientErrorCode.MissingCredentials,
      TetherClientErrorCode.RegistrationFailed,
      TetherClientErrorCode.AuthenticationFailed,
      TetherClientErrorCode.StorageError,
      TetherClientErrorCode.SyncError,
    ];

    for (const code of codes) {
      const err = new TetherClientError(code);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
