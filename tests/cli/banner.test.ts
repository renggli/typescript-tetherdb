import { describe, expect, it } from 'vitest';
import { getBanner } from '../../src/cli/banner.js';

describe('getBanner', () => {
  it('should return ASCII art containing brand name and subtitle', () => {
    const banner = getBanner();
    expect(banner).toContain('/_  __/__');
    expect(banner).toContain('⚡ Local-first real-time database');
  });
});
