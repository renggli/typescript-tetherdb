import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  getCorsHeaders,
  handleCorsPreflight,
} from '../../../src/server/http/cors.js';

describe('getCorsHeaders', () => {
  it('should return default permissive CORS headers when enabled without config', () => {
    const headers = getCorsHeaders(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('should return empty headers when cors is false', () => {
    const headers = getCorsHeaders(false);
    expect(headers).toEqual({});
  });

  it('should handle custom origin and allowCredentials', () => {
    const headers = getCorsHeaders(
      {
        origin: 'https://example.com',
        credentials: true,
        maxAge: 3600,
      },
      undefined,
    );
    expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers['Access-Control-Max-Age']).toBe('3600');
  });

  it('should match dynamic request origin against allowed list', () => {
    const req = {
      headers: { origin: 'https://app.example.com' },
    } as unknown as http.IncomingMessage;

    const headers = getCorsHeaders(
      {
        origin: ['https://app.example.com', 'https://admin.example.com'],
      },
      req,
    );
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    );
  });

  it('should not set allow-origin if request origin is not in allowed list', () => {
    const req = {
      headers: { origin: 'https://unknown.com' },
    } as unknown as http.IncomingMessage;
    const headers = getCorsHeaders(
      {
        origin: ['https://app.example.com'],
      },
      req,
    );
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('should reflect request origin when origin is true or credentials are enabled', () => {
    const req = {
      headers: { origin: 'https://client.example.com' },
    } as unknown as http.IncomingMessage;
    const headersWithCreds = getCorsHeaders(
      {
        origin: true,
        credentials: true,
      },
      req,
    );
    expect(headersWithCreds['Access-Control-Allow-Origin']).toBe(
      'https://client.example.com',
    );
    expect(headersWithCreds['Access-Control-Allow-Credentials']).toBe('true');
  });
});

describe('handleCorsPreflight', () => {
  it('should write 204 status and CORS headers on preflight', () => {
    let statusCode = 0;
    const sentHeaders: Record<string, string> = {};
    let ended = false;

    const res = {
      writeHead: (code: number, headers: Record<string, string>) => {
        statusCode = code;
        Object.assign(sentHeaders, headers);
      },
      end: () => {
        ended = true;
      },
    } as unknown as http.ServerResponse;

    const req = {
      headers: {},
    } as unknown as http.IncomingMessage;

    handleCorsPreflight(req, res, true);
    expect(statusCode).toBe(204);
    expect(sentHeaders['Access-Control-Allow-Origin']).toBe('*');
    expect(ended).toBe(true);
  });
});
