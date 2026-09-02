import type * as http from 'node:http';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import { type CorsOptions, getCorsHeaders } from './cors.js';

/** Maximum payload size allowed for standard JSON requests (1MB). */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Sends a JSON HTTP response with appropriate Content-Type and CORS headers.
 *
 * @param res - Server HTTP response.
 * @param status - HTTP status code.
 * @param data - Payload data object to serialize.
 * @param corsConfig - CORS configuration options.
 * @param req - Optional incoming HTTP request.
 */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  corsConfig: CorsOptions | null,
  req?: http.IncomingMessage,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...getCorsHeaders(corsConfig, req),
  });
  res.end(JSON.stringify(data));
}

/**
 * Reads and parses a JSON body from an incoming HTTP request stream.
 *
 * @param req - Incoming HTTP request stream.
 * @param maxBytes - Maximum allowed payload size in bytes.
 * @returns Parsed JSON body object.
 * @throws TetherServerError if payload exceeds max size or is malformed JSON.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(
          new TetherServerError(
            TetherServerErrorCode.LimitExceeded,
            'Payload exceeds maximum allowed size',
          ),
        );
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(
          new TetherServerError(
            TetherServerErrorCode.InvalidInput,
            'Invalid JSON payload',
          ),
        );
      }
    });
    req.on('error', reject);
  });
}
