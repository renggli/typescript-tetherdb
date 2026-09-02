import { describe, expect, it } from 'vitest';
import { normalizeHttpPath } from '../../src/shared/path.js';

describe('normalizeHttpPath', () => {
  it('should normalize empty and root paths to empty string', () => {
    expect(normalizeHttpPath('')).toBe('');
    expect(normalizeHttpPath('/')).toBe('');
    expect(normalizeHttpPath('//')).toBe('');
  });

  it('should ensure leading slash and remove trailing slashes', () => {
    expect(normalizeHttpPath('api')).toBe('/api');
    expect(normalizeHttpPath('/api')).toBe('/api');
    expect(normalizeHttpPath('/api/')).toBe('/api');
    expect(normalizeHttpPath('api/v1/')).toBe('/api/v1');
    expect(normalizeHttpPath('/api/v1')).toBe('/api/v1');
    expect(normalizeHttpPath('/api/v1/')).toBe('/api/v1');
  });
});
