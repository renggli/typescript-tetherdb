import { describe, expect, it } from 'vitest';
import { generateClientId } from '../../../src/client/shared/id.js';

describe('src/client/shared/id.ts', () => {
  describe('generateClientId', () => {
    it('should produce distinct non-empty client identifiers', () => {
      const id1 = generateClientId();
      const id2 = generateClientId();
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(5);
      expect(id1).not.toBe(id2);
    });
  });
});
