import { describe, expect, it } from 'vitest';
import {
  isValidTableName,
  TABLE_NAME_MAX_LENGTH,
  TABLE_NAME_PATTERN,
  type ValidTableName,
} from '../../src/shared/validate.js';

describe('isValidTableName', () => {
  it('should return true for valid alphanumeric table names', () => {
    expect(isValidTableName('users')).toBe(true);
    expect(isValidTableName('todos_123')).toBe(true);
    expect(isValidTableName('chat-messages')).toBe(true);
    expect(isValidTableName('A')).toBe(true);
    expect(isValidTableName('1')).toBe(true);
    expect(isValidTableName('_')).toBe(true);
    expect(isValidTableName('-')).toBe(true);
    expect(isValidTableName('app_state_v2-prod')).toBe(true);
  });

  it('should return true for maximum allowed length of 64 characters', () => {
    const maxName = 'a'.repeat(TABLE_NAME_MAX_LENGTH);
    expect(maxName.length).toBe(64);
    expect(isValidTableName(maxName)).toBe(true);
  });

  it('should return false for empty or non-string values', () => {
    expect(isValidTableName('')).toBe(false);
    expect(isValidTableName(null)).toBe(false);
    expect(isValidTableName(undefined)).toBe(false);
    expect(isValidTableName(123)).toBe(false);
    expect(isValidTableName({})).toBe(false);
    expect(isValidTableName([])).toBe(false);
  });

  it('should return false for names exceeding 64 characters', () => {
    const tooLong = 'a'.repeat(TABLE_NAME_MAX_LENGTH + 1);
    expect(tooLong.length).toBe(65);
    expect(isValidTableName(tooLong)).toBe(false);
  });

  it('should return false for names containing whitespace or invalid symbols', () => {
    expect(isValidTableName('my table')).toBe(false);
    expect(isValidTableName('table ')).toBe(false);
    expect(isValidTableName(' table')).toBe(false);
    expect(isValidTableName('table\nname')).toBe(false);
    expect(isValidTableName('table\tname')).toBe(false);
    expect(isValidTableName('users.meta')).toBe(false);
    expect(isValidTableName('users/profile')).toBe(false);
    expect(isValidTableName('users\\profile')).toBe(false);
    expect(isValidTableName('users:id')).toBe(false);
    expect(isValidTableName('users*')).toBe(false);
    expect(isValidTableName('users?')).toBe(false);
    expect(isValidTableName('users@mail')).toBe(false);
    expect(isValidTableName('users#tag')).toBe(false);
  });

  it('should return false for path traversal attempts', () => {
    expect(isValidTableName('.')).toBe(false);
    expect(isValidTableName('..')).toBe(false);
    expect(isValidTableName('../tables')).toBe(false);
    expect(isValidTableName('..\\tables')).toBe(false);
    expect(isValidTableName('/etc/passwd')).toBe(false);
  });

  it('should return false for unicode characters', () => {
    expect(isValidTableName('rézeptario')).toBe(false);
    expect(isValidTableName('таблица')).toBe(false);
    expect(isValidTableName('テーブル')).toBe(false);
    expect(isValidTableName('📁')).toBe(false);
  });

  it('should export TABLE_NAME_PATTERN and match the same criteria', () => {
    expect(TABLE_NAME_PATTERN.test('valid_name')).toBe(true);
    expect(TABLE_NAME_PATTERN.test('invalid name')).toBe(false);
    expect(TABLE_NAME_PATTERN.test('')).toBe(false);
  });
});

describe('ValidTableName', () => {
  it('should accept valid literal table names at compile time', () => {
    const valid1: ValidTableName<'users'> = 'users';
    const valid2: ValidTableName<'todos_123-prod'> = 'todos_123-prod';
    const validDynamic: ValidTableName<string> = 'dynamic_string' as string;

    expect(valid1).toBe('users');
    expect(valid2).toBe('todos_123-prod');
    expect(validDynamic).toBe('dynamic_string');
  });

  it('should reject invalid literal table names with error types at compile time', () => {
    type EmptyError = ValidTableName<''>;
    type SpaceError = ValidTableName<'users table'>;
    type TraversalError = ValidTableName<'../traversal'>;

    const emptyErr: EmptyError = 'Error: Table name cannot be empty';
    const spaceErr: SpaceError =
      'Error: Table name must only contain alphanumeric characters, underscores, and hyphens';
    const travErr: TraversalError =
      'Error: Table name must only contain alphanumeric characters, underscores, and hyphens';

    expect(emptyErr).toContain('Error');
    expect(spaceErr).toContain('Error');
    expect(travErr).toContain('Error');
  });
});
