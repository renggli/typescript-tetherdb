/**
 * Utility functions for path normalization across client and server.
 */

/**
 * Normalizes a base path ensuring it starts with a leading slash and has no trailing slash.
 * An empty string or single slash normalizes to an empty string.
 *
 * @param path - The base path to normalize.
 * @returns Normalized base path (e.g. '/api' or '').
 */
export function normalizeBasePath(path: string): string {
  if (path === '' || path === '/') return '';
  if (path.endsWith('/')) path = path.slice(0, path.length - 1);
  if (!path.startsWith('/')) path = `/${path}`;
  return path === '/' ? '' : path;
}
