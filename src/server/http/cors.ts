import type * as http from 'node:http';

/**
 * Options for configuring Cross-Origin Resource Sharing (CORS) on HTTP endpoints.
 */
export interface CorsOptions {
  /**
   * Allowed origin(s). Can be `'*'` for unrestricted access, a specific origin string (e.g. `'https://example.com'`),
   * an array of allowed origin strings, `true` to reflect the request's `Origin` header, or `false` to disable CORS headers.
   * Defaults to `'*'`.
   */
  origin?: string | string[] | boolean;
  /** Whether to set `Access-Control-Allow-Credentials: true` (defaults to false). */
  credentials?: boolean;
  /** Allowed request headers for preflight OPTIONS checks (defaults to `['Content-Type', 'Authorization', 'X-Admin-Secret']`). */
  allowedHeaders?: string[];
  /** Exposed response headers (Access-Control-Expose-Headers). */
  exposedHeaders?: string[];
  /** Maximum age in seconds to cache preflight responses (Access-Control-Max-Age). */
  maxAge?: number;
}

/**
 * Computes standard CORS headers for an incoming HTTP request based on configuration.
 *
 * @param corsConfig - CORS configuration options or `null` if disabled.
 * @param req - Optional incoming HTTP request.
 * @returns Map of HTTP header names to values.
 */
export function getCorsHeaders(
  corsConfig: CorsOptions | null,
  req?: http.IncomingMessage,
): Record<string, string> {
  if (!corsConfig) return {};

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': (
      corsConfig.allowedHeaders ?? [
        'Content-Type',
        'Authorization',
        'X-Admin-Secret',
      ]
    ).join(', '),
  };

  if (corsConfig.exposedHeaders && corsConfig.exposedHeaders.length > 0) {
    headers['Access-Control-Expose-Headers'] =
      corsConfig.exposedHeaders.join(', ');
  }

  if (corsConfig.maxAge !== undefined) {
    headers['Access-Control-Max-Age'] = String(corsConfig.maxAge);
  }

  const reqOrigin = req?.headers.origin;
  const origin = corsConfig.origin ?? '*';

  if (origin === '*') {
    if (corsConfig.credentials) {
      if (reqOrigin) {
        headers['Access-Control-Allow-Origin'] = reqOrigin;
        headers.Vary = 'Origin';
      }
    } else {
      headers['Access-Control-Allow-Origin'] = '*';
    }
  } else if (typeof origin === 'string') {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  } else if (Array.isArray(origin)) {
    if (reqOrigin && origin.includes(reqOrigin)) {
      headers['Access-Control-Allow-Origin'] = reqOrigin;
      headers.Vary = 'Origin';
    }
  } else if (origin === true && reqOrigin) {
    headers['Access-Control-Allow-Origin'] = reqOrigin;
    headers.Vary = 'Origin';
  }

  if (corsConfig.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

/**
 * Responds to a CORS preflight OPTIONS request with a 204 No Content status.
 *
 * @param req - Incoming HTTP request.
 * @param res - Server HTTP response.
 * @param corsConfig - CORS configuration options.
 */
export function handleCorsPreflight(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsConfig: CorsOptions | null,
): void {
  res.writeHead(204, getCorsHeaders(corsConfig, req));
  res.end();
}
