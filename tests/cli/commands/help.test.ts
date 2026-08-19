import { describe, expect, it, vi } from 'vitest';
import { printHelp } from '../../../src/cli/commands/help.js';

describe('printHelp', () => {
  it('should print usage instructions to console.log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHelp();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('TetherDB CLI'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('serve (default)'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('apps [list]'));
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('tables [list]'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('users [list]'),
    );
    logSpy.mockRestore();
  });
});
