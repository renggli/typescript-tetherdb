import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import { readJsonBody, sendJson } from '../../../src/server/http/json.js';

describe('sendJson', () => {
  it('should serialize payload and set content-type header', () => {
    let statusCode = 0;
    const sentHeaders: Record<string, string> = {};
    let sentBody = '';

    const res = {
      writeHead: (code: number, headers: Record<string, string>) => {
        statusCode = code;
        Object.assign(sentHeaders, headers);
      },
      end: (data: string) => {
        sentBody = data;
      },
    } as unknown as http.ServerResponse;

    sendJson(res, 201, { success: true }, true);
    expect(statusCode).toBe(201);
    expect(sentHeaders['Content-Type']).toBe('application/json');
    expect(JSON.parse(sentBody)).toEqual({ success: true });
  });
});

describe('readJsonBody', () => {
  it('should parse valid JSON from request stream', async () => {
    const emitter = new EventEmitter() as unknown as http.IncomingMessage;
    const promise = readJsonBody(emitter);

    (emitter as unknown as EventEmitter).emit(
      'data',
      JSON.stringify({ name: 'alice' }),
    );
    (emitter as unknown as EventEmitter).emit('end');

    const result = await promise;
    expect(result).toEqual({ name: 'alice' });
  });

  it('should return empty object on empty stream body', async () => {
    const emitter = new EventEmitter() as unknown as http.IncomingMessage;
    const promise = readJsonBody(emitter);

    (emitter as unknown as EventEmitter).emit('end');

    const result = await promise;
    expect(result).toEqual({});
  });

  it('should reject when payload exceeds max size', async () => {
    const emitter = new EventEmitter() as unknown as http.IncomingMessage;
    const promise = readJsonBody(emitter, 10);

    (emitter as unknown as EventEmitter).emit('data', '1234567890123');

    await expect(promise).rejects.toThrow(TetherServerError);
    await expect(promise).rejects.toMatchObject({
      code: TetherServerErrorCode.LimitExceeded,
    });
  });

  it('should reject on malformed JSON payload', async () => {
    const emitter = new EventEmitter() as unknown as http.IncomingMessage;
    const promise = readJsonBody(emitter);

    (emitter as unknown as EventEmitter).emit('data', '{invalid json');
    (emitter as unknown as EventEmitter).emit('end');

    await expect(promise).rejects.toThrow(TetherServerError);
    await expect(promise).rejects.toMatchObject({
      code: TetherServerErrorCode.InvalidInput,
    });
  });
});
