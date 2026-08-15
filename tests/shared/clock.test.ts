import { describe, expect, it } from 'vitest';
import { generateClientId, shouldOverwrite } from '../../src/shared/clock.js';

describe('src/shared/clock.ts', () => {
  describe('shouldOverwrite', () => {
    it('should overwrite when no existing record exists', () => {
      expect(
        shouldOverwrite({ timestamp: 1000, clientId: 'c1' }, undefined),
      ).toBe(true);
    });

    it('should overwrite when incoming timestamp is greater', () => {
      expect(
        shouldOverwrite(
          { timestamp: 2000, clientId: 'c1' },
          { timestamp: 1000, version: 1, clientId: 'c2' },
        ),
      ).toBe(true);
    });

    it('should NOT overwrite when incoming timestamp is smaller', () => {
      expect(
        shouldOverwrite(
          { timestamp: 1000, clientId: 'c1' },
          { timestamp: 2000, version: 1, clientId: 'c2' },
        ),
      ).toBe(false);
    });

    it('should break ties deterministically when timestamps are equal using clientId', () => {
      // 'c2' > 'c1'
      expect(
        shouldOverwrite(
          { timestamp: 1000, clientId: 'c2' },
          { timestamp: 1000, version: 1, clientId: 'c1' },
        ),
      ).toBe(true);

      // 'c1' < 'c2'
      expect(
        shouldOverwrite(
          { timestamp: 1000, clientId: 'c1' },
          { timestamp: 1000, version: 1, clientId: 'c2' },
        ),
      ).toBe(false);

      // equal clientIds
      expect(
        shouldOverwrite(
          { timestamp: 1000, clientId: 'c1' },
          { timestamp: 1000, version: 1, clientId: 'c1' },
        ),
      ).toBe(true);
    });
  });

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
