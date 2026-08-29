import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_PERMISSIONS,
  Permission,
  PUBLIC_READ_PERMISSIONS,
  PUBLIC_READ_WRITE_PERMISSIONS,
  SHARED_PERMISSIONS,
  USER_PRIVATE_PERMISSIONS,
} from '../../src/shared/types.js';

describe('Permission', () => {
  it('should define USER_PRIVATE_PERMISSIONS matching defaults', () => {
    expect(USER_PRIVATE_PERMISSIONS).toEqual({
      create: Permission.Authenticated,
      read: Permission.Owner,
      update: Permission.Owner,
      delete: Permission.Owner,
    });
    expect(DEFAULT_TABLE_PERMISSIONS).toBe(USER_PRIVATE_PERMISSIONS);
  });

  it('should define PUBLIC_READ_PERMISSIONS for public-read tables', () => {
    expect(PUBLIC_READ_PERMISSIONS).toEqual({
      create: Permission.Authenticated,
      read: Permission.Everybody,
      update: Permission.Owner,
      delete: Permission.Owner,
    });
  });

  it('should define PUBLIC_READ_WRITE_PERMISSIONS for collaborative tables', () => {
    expect(PUBLIC_READ_WRITE_PERMISSIONS).toEqual({
      create: Permission.Everybody,
      read: Permission.Everybody,
      update: Permission.Everybody,
      delete: Permission.Everybody,
    });
  });

  it('should define SHARED_PERMISSIONS for team/group tables', () => {
    expect(SHARED_PERMISSIONS).toEqual({
      create: Permission.Authenticated,
      read: Permission.Authenticated,
      update: Permission.Owner,
      delete: Permission.Owner,
    });
  });
});
