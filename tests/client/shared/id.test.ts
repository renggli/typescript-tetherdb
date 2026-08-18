import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from '../../../src/client/shared/id.js';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomUUID', () => {
  const originalCrypto = globalThis.crypto;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should generate valid UUID v4 with native crypto.randomUUID', () => {
    const randomUUIDSpy = vi.fn(() => {
      return originalCrypto.randomUUID();
    });

    vi.stubGlobal('crypto', {
      randomUUID: randomUUIDSpy,
    });

    const id1 = randomUUID();
    const id2 = randomUUID();

    expect(randomUUIDSpy).toHaveBeenCalled();
    expect(id1).toMatch(UUID_V4_REGEX);
    expect(id2).toMatch(UUID_V4_REGEX);
    expect(id1).not.toBe(id2);
  });

  it('should fallback to crypto.getRandomValues when crypto.randomUUID is not available', () => {
    const getRandomValuesSpy = vi.fn((arr: ArrayBufferView<ArrayBuffer>) => {
      return originalCrypto.getRandomValues(arr);
    });

    vi.stubGlobal('crypto', {
      getRandomValues: getRandomValuesSpy,
    });

    const id1 = randomUUID();
    const id2 = randomUUID();

    expect(getRandomValuesSpy).toHaveBeenCalled();
    expect(id1).toMatch(UUID_V4_REGEX);
    expect(id2).toMatch(UUID_V4_REGEX);
    expect(id1).not.toBe(id2);
  });

  it('should fallback to Math.random when crypto is undefined', () => {
    vi.stubGlobal('crypto', undefined);

    const mathRandomSpy = vi.spyOn(Math, 'random');

    const id1 = randomUUID();
    const id2 = randomUUID();

    expect(mathRandomSpy).toHaveBeenCalled();
    expect(id1).toMatch(UUID_V4_REGEX);
    expect(id2).toMatch(UUID_V4_REGEX);
    expect(id1).not.toBe(id2);
  });

  it('should fallback to Math.random when crypto is present but has no getRandomValues or randomUUID', () => {
    vi.stubGlobal('crypto', {});

    const mathRandomSpy = vi.spyOn(Math, 'random');

    const id1 = randomUUID();
    const id2 = randomUUID();

    expect(mathRandomSpy).toHaveBeenCalled();
    expect(id1).toMatch(UUID_V4_REGEX);
    expect(id2).toMatch(UUID_V4_REGEX);
    expect(id1).not.toBe(id2);
  });
});
