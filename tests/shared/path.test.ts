import { describe, expect, it } from 'vitest';
import { normalizeBasePath } from '../../src/shared/path.js';

describe('src/shared/path.ts', () => {
  describe('normalizeBasePath', () => {
    it('should normalize empty string and slash to empty string', () => {
      expect(normalizeBasePath('')).toBe('');
      expect(normalizeBasePath('/')).toBe('');
    });

    it('should prepend leading slash and trim trailing slash', () => {
      expect(normalizeBasePath('api')).toBe('/api');
      expect(normalizeBasePath('/api')).toBe('/api');
      expect(normalizeBasePath('/api/')).toBe('/api');
      expect(normalizeBasePath('api/v1/')).toBe('/api/v1');
      expect(normalizeBasePath('/api/v1')).toBe('/api/v1');
    });
  });
});
