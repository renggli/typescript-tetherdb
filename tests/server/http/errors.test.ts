import { describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import { getHttpStatusForError } from '../../../src/server/http/errors.js';

describe('getHttpStatusForError', () => {
  it('should map InvalidInput and ConfigurationError to 400', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.InvalidInput, 'bad'),
      ),
    ).toBe(400);
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.ConfigurationError, 'bad'),
      ),
    ).toBe(400);
  });

  it('should map Unauthorized and AuthenticationFailed to 401', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.Unauthorized, 'unauth'),
      ),
    ).toBe(401);
    expect(
      getHttpStatusForError(
        new TetherServerError(
          TetherServerErrorCode.AuthenticationFailed,
          'fail',
        ),
      ),
    ).toBe(401);
  });

  it('should map Forbidden to 403', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.Forbidden, 'forbidden'),
      ),
    ).toBe(403);
  });

  it('should map NotFound to 404', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.NotFound, 'not found'),
      ),
    ).toBe(404);
  });

  it('should map AlreadyExists to 409', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.AlreadyExists, 'exists'),
      ),
    ).toBe(409);
  });

  it('should map LimitExceeded to 413', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.LimitExceeded, 'too large'),
      ),
    ).toBe(413);
  });

  it('should map NotSupported to 501', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(
          TetherServerErrorCode.NotSupported,
          'unsupported',
        ),
      ),
    ).toBe(501);
  });

  it('should map InternalError and non-Tether errors to 500', () => {
    expect(
      getHttpStatusForError(
        new TetherServerError(TetherServerErrorCode.InternalError, 'internal'),
      ),
    ).toBe(500);
    expect(getHttpStatusForError(new Error('generic error'))).toBe(500);
    expect(getHttpStatusForError('unknown string error')).toBe(500);
  });
});
