import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TETHER_VERSION } from '../../src/shared/version.js';

describe('TETHER_VERSION', () => {
  it('should match the version declared in package.json', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      version: string;
    };
    expect(TETHER_VERSION).toBe(pkg.version);
  });
});
