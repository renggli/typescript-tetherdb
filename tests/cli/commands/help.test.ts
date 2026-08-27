import { describe, expect, it } from 'vitest';
import { printHelp } from '../../../src/cli/commands/help.js';
import { testLogger } from '../../logger.js';

describe('printHelp', () => {
  it('should print usage instructions to console.log', () => {
    printHelp();
    expect(testLogger.hasMessage('TetherDB CLI')).toBe(true);
    expect(testLogger.hasMessage('serve (default)')).toBe(true);
    expect(testLogger.hasMessage('status')).toBe(true);
    expect(testLogger.hasMessage('stop')).toBe(true);
    expect(testLogger.hasMessage('maintenance checkpoint')).toBe(true);
    expect(testLogger.hasMessage('tables [list]')).toBe(true);
    expect(testLogger.hasMessage('records list')).toBe(true);
    expect(testLogger.hasMessage('users [list]')).toBe(true);
  });
});
