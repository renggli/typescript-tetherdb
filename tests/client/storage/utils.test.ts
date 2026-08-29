import { describe, expect, it } from 'vitest';
import {
  isKeyPathEqual,
  normalizeKeyPath,
  promisifyTransaction,
} from '../../../src/client/storage/utils.js';

describe('isKeyPathEqual', () => {
  it('should compare string keyPaths correctly', () => {
    expect(isKeyPathEqual('title', 'title')).toBe(true);
    expect(isKeyPathEqual('title', 'name')).toBe(false);
  });

  it('should compare array compound keyPaths correctly', () => {
    expect(isKeyPathEqual(['dept', 'role'], ['dept', 'role'])).toBe(true);
    expect(isKeyPathEqual(['dept', 'role'], ['dept', 'level'])).toBe(false);
    expect(isKeyPathEqual(['dept', 'role'], ['dept'])).toBe(false);
    expect(isKeyPathEqual(['dept'], 'dept')).toBe(false);
  });
});

describe('normalizeKeyPath', () => {
  it('should prefix non-metadata paths with data.', () => {
    expect(normalizeKeyPath('title')).toBe('data.title');
    expect(normalizeKeyPath('nested.field')).toBe('data.nested.field');
  });

  it('should preserve reserved metadata field paths', () => {
    expect(normalizeKeyPath('id')).toBe('id');
    expect(normalizeKeyPath('timestamp')).toBe('timestamp');
    expect(normalizeKeyPath('version')).toBe('version');
    expect(normalizeKeyPath('clientId')).toBe('clientId');
    expect(normalizeKeyPath('deleted')).toBe('deleted');
    expect(normalizeKeyPath('userName')).toBe('userName');
  });

  it('should normalize array of compound paths', () => {
    expect(normalizeKeyPath(['id', 'status'])).toEqual(['id', 'data.status']);
  });
});

describe('promisifyTransaction', () => {
  it('should reject on transaction abort event with fallback error if tx.error is null', async () => {
    let onabortHandler: (() => void) | null = null;

    const mockTx = {
      error: null,
      set onabort(fn: () => void) {
        onabortHandler = fn;
      },
      set oncomplete(_fn: () => void) {},
      set onerror(_fn: () => void) {},
    } as unknown as IDBTransaction;

    const promise = promisifyTransaction(mockTx);
    onabortHandler?.();

    await expect(promise).rejects.toThrow('IndexedDB transaction aborted');
  });
});
