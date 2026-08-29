/**
 * Utility functions for path normalization across client and server.
 */

/**
 * Normalizes an HTTP URL prefix path ensuring it starts with a leading slash and has no trailing slash.
 * An empty string or single slash normalizes to an empty string.
 *
 * @param path - The HTTP path prefix to normalize.
 * @returns Normalized path (e.g. '/api' or '').
 */
export function normalizeHttpPath(path: string): string {
  if (path === '' || path === '/') return '';
  if (path.endsWith('/')) path = path.slice(0, path.length - 1);
  if (!path.startsWith('/')) path = `/${path}`;
  return path === '/' ? '' : path;
}
