import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldOverwrite } from '../../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
  type TableSettings,
} from '../../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import { getOrCreateKeyfileSecret, hashPassword } from '../../shared/crypto.js';
import { readServerLock } from '../../shared/lock.js';
import {
  getUserBucket,
  normalizeUserName,
  validatePassword,
  validateTableName,
  validateUserId,
  validateUserName,
} from '../../shared/validate.js';
import {
  applyChangeToRecord,
  assertCanMutate,
  BaseStorage,
  canRead,
  isPrivateTable,
  isSnapshotRequired,
  validateBatchChanges,
} from '../base/index.js';
import type { MaintenanceResult, StorageOptions } from '../storage.js';
import { BackendType } from '../storage.js';
import type { ApplyChangesOptions, TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import { TableFileStorage } from './table.js';
import { UserFileStorage } from './user.js';

export interface FileUserData {
  userId: string;
  userName: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface FileTableData {
  name: string;
  settings?: Partial<TableSettings>;
  createdAt: number;
}

export interface FileStorageOptions extends StorageOptions {
  baseDir?: string;
}

/**
 * Filesystem-backed implementation of `Storage`.
 */
export class FileStorage extends BaseStorage {
  readonly backend = BackendType.File;
  readonly baseDir: string;
  readonly secret: string;
  override readonly options: FileStorageOptions;
  private locks: Map<string, Promise<unknown>> = new Map();

  constructor(options: FileStorageOptions = {}) {
    super(options);
    this.options = options;
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.secret = options.secret ?? getOrCreateKeyfileSecret(this.baseDir);
  }

  async createTable(
    name: string,
    settings: Partial<TableSettings> = {},
  ): Promise<TableStorage> {
    assertNoActiveServerLock(this.baseDir);
    const safeName = validateTableName(name);
    return this.withLock('__tables__', async () => {
      const tables = await this.readTablesFile();
      if (tables.has(safeName)) {
        throw new TetherServerError(
          TetherServerErrorCode.AlreadyExists,
          'Table already exists',
        );
      }

      const now = Date.now();
      tables.set(safeName, { name: safeName, settings, createdAt: now });
      await this.writeTablesFile(tables);

      return new TableFileStorage(safeName, this, settings);
    });
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    const tables = await this.readTablesFile();
    const data = tables.get(safeName);
    if (data) {
      return new TableFileStorage(data.name, this, data.settings);
    }
    return undefined;
  }

  async getTables(): Promise<TableStorage[]> {
    const tables = await this.readTablesFile();
    return Array.from(tables.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => new TableFileStorage(t.name, this, t.settings));
  }

  async createUser(userName: string, password: string): Promise<UserStorage> {
    assertNoActiveServerLock(this.baseDir);
    const safeUserName = validateUserName(userName);
    const validPassword = validatePassword(password);
    const passwordHash = await hashPassword(validPassword);
    const userId = crypto.randomUUID();

    return this.withLock('__users__', async () => {
      const users = await this.readUsersFile();

      for (const u of users.values()) {
        if (u.userName.toLowerCase() === safeUserName.toLowerCase()) {
          throw new TetherServerError(
            TetherServerErrorCode.AlreadyExists,
            'Username is already registered',
          );
        }
      }

      const userData: FileUserData = {
        userId,
        userName: safeUserName,
        passwordHash,
        createdAt: Date.now(),
      };

      users.set(userId, userData);
      await this.writeUsersFile(users);
      return new UserFileStorage(userData, this);
    });
  }

  async getUser(userId: string): Promise<UserStorage | undefined> {
    const safeUserId = validateUserId(userId);
    const data = await this.findUserDataById(safeUserId);
    if (data) {
      return new UserFileStorage(data, this);
    }
    return undefined;
  }

  async getUserByUserName(userName: string): Promise<UserStorage | undefined> {
    const safeUserName = normalizeUserName(userName);
    if (!safeUserName) return undefined;
    const users = await this.readUsersFile();
    for (const u of users.values()) {
      if (u.userName.toLowerCase() === safeUserName) {
        return new UserFileStorage(u, this);
      }
    }
    return undefined;
  }

  async getUsers(): Promise<UserStorage[]> {
    const users = await this.readUsersFile();
    return Array.from(users.values()).map(
      (data) => new UserFileStorage(data, this),
    );
  }

  async applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
    options?: ApplyChangesOptions,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const defaultMaxRecords = this.options.maxRecords ?? 10_000;
    const defaultMaxRecordSize = this.options.maxRecordSizeBytes ?? 512 * 1024;
    const defaultMaxHistory = this.options.maxHistoryEntries ?? 1000;

    // Phase 1: Pre-validate
    await validateBatchChanges(this, changes, defaultMaxRecordSize);

    // Phase 2: Lock and apply changes
    return this.withLock('__apply_changes__', async () => {
      const appliedList: (ChangeRecord & { seq: number })[] = [];
      let maxNewSeq = 0;

      // Group changes by partition
      const partitionChanges = new Map<string, ChangeRecord[]>();
      for (const change of changes) {
        const table = await this.getTable(change.table);
        if (!table) continue;
        const isPrivate = isPrivateTable(table);
        const partitionId = isPrivate
          ? (user?.userId ?? '__shared__')
          : '__shared__';
        if (isPrivate && !user && !options?.skipPermissionCheck) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            `Authentication required for private table "${change.table}"`,
          );
        }
        if (!partitionId) continue;
        let list = partitionChanges.get(partitionId);
        if (!list) {
          list = [];
          partitionChanges.set(partitionId, list);
        }
        list.push(change);
      }

      for (const [partitionId, pChanges] of partitionChanges.entries()) {
        const partitionDir = this.resolvePartitionDir(partitionId);
        const metaFile = path.join(partitionDir, 'meta.json');
        const syncFile = path.join(partitionDir, 'sync.jsonl');

        let meta = { currentSeq: 0, minSeq: 0 };
        try {
          const metaContent = await fs.readFile(metaFile, 'utf-8');
          meta = JSON.parse(metaContent);
        } catch {
          // Initialize new partition
        }

        const tableMaps = new Map<string, Map<string, StoredRecord>>();
        const newChangelogLines: string[] = [];

        for (const change of pChanges) {
          const tableName = change.table;
          const table = await this.getTable(tableName);
          if (!table) continue;
          const maxRecords = table.settings.maxRecords ?? defaultMaxRecords;

          let map = tableMaps.get(tableName);
          if (!map) {
            map = await this.readTableRecords(partitionId, tableName);
            tableMaps.set(tableName, map);
          }

          const existing = map.get(change.id);
          if (!options?.skipPermissionCheck) {
            assertCanMutate(table, user, change, existing);
          }

          if (
            change.op === OperationType.Put &&
            (!existing || existing.deleted) &&
            map.size >= maxRecords
          ) {
            throw new TetherServerError(
              TetherServerErrorCode.LimitExceeded,
              `Table record limit reached (${maxRecords} records)`,
            );
          }

          const shouldApply = !existing || shouldOverwrite(change, existing);
          if (shouldApply) {
            meta.currentSeq++;
            if (meta.minSeq === 0) meta.minSeq = 1;
            const assignedSeq = meta.currentSeq;

            const { updatedRecord, appliedChange } = applyChangeToRecord(
              change,
              existing,
              assignedSeq,
              user,
            );

            map.set(change.id, updatedRecord);
            appliedList.push(appliedChange);
            newChangelogLines.push(JSON.stringify(appliedChange));
            maxNewSeq = Math.max(maxNewSeq, assignedSeq);
          }
        }

        // Save records per table
        for (const [tableName, map] of tableMaps.entries()) {
          const recordsFile = path.join(
            partitionDir,
            tableName,
            'records.json',
          );
          await writeFileAtomic(
            recordsFile,
            JSON.stringify(Array.from(map.values()), null, 2),
          );
        }

        // Append to sync.jsonl
        if (newChangelogLines.length > 0) {
          const appendContent = `${newChangelogLines.join('\n')}\n`;
          await fs.mkdir(partitionDir, { recursive: true });
          await fs.appendFile(syncFile, appendContent, 'utf-8');
        }

        // Save updated meta
        await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));

        // Auto-pruning with hysteresis buffer (+50)
        await this.prunePartitionSyncFile(
          partitionDir,
          defaultMaxHistory,
          defaultMaxHistory + 50,
        );
      }

      return { applied: appliedList, newSeq: maxNewSeq };
    });
  }

  async getChangesSince(
    user: UserStorage | undefined,
    fromSeq: number,
    tableFilters?: string[],
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const partitions: string[] = ['__shared__'];
    if (user) partitions.push(user.userId);

    let maxCurrentSeq = 0;
    let minSeq = 0;
    const allChanges: (ChangeRecord & { seq: number })[] = [];

    for (const partitionId of partitions) {
      const partitionDir = this.resolvePartitionDir(partitionId);
      const metaFile = path.join(partitionDir, 'meta.json');
      const syncFile = path.join(partitionDir, 'sync.jsonl');

      try {
        const metaContent = await fs.readFile(metaFile, 'utf-8');
        const meta = JSON.parse(metaContent) as {
          currentSeq: number;
          minSeq: number;
        };
        maxCurrentSeq = Math.max(maxCurrentSeq, meta.currentSeq);
        minSeq = Math.max(minSeq, meta.minSeq);
      } catch {
        continue;
      }

      try {
        const content = await fs.readFile(syncFile, 'utf-8');
        const lines = content
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          const rec = JSON.parse(line) as ChangeRecord & { seq: number };
          if (rec.seq > fromSeq) {
            allChanges.push(rec);
          }
        }
      } catch {}
    }

    if (isSnapshotRequired(fromSeq, minSeq, maxCurrentSeq)) {
      return {
        changes: [],
        currentSeq: maxCurrentSeq,
        requiresSnapshot: true,
      };
    }

    allChanges.sort((a, b) => a.seq - b.seq);

    const filtered: ChangeRecord[] = [];
    for (const c of allChanges) {
      const table = await this.getTable(c.table);
      if (!table || !canRead(table, user)) continue;
      if (tableFilters && !tableFilters.includes(c.table)) continue;
      filtered.push(c);
    }

    return {
      changes: filtered,
      currentSeq: maxCurrentSeq,
      requiresSnapshot: false,
    };
  }

  async getCurrentSeq(user?: UserStorage): Promise<number> {
    const partitions: string[] = ['__shared__'];
    if (user) partitions.push(user.userId);
    let maxSeq = 0;

    for (const partitionId of partitions) {
      const partitionDir = this.resolvePartitionDir(partitionId);
      const metaFile = path.join(partitionDir, 'meta.json');
      try {
        const metaContent = await fs.readFile(metaFile, 'utf-8');
        const meta = JSON.parse(metaContent) as { currentSeq: number };
        maxSeq = Math.max(maxSeq, meta.currentSeq);
      } catch {
        // Ignore
      }
    }

    return maxSeq;
  }

  async checkpoint(tableName?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Checkpoint operation is not supported by file storage${tableName ? ` (table: ${tableName})` : ''}`,
    );
  }

  async vacuum(): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      'Vacuum operation is not supported by file storage',
    );
  }

  async prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult> {
    const keep = keepCount ?? this.options.maxHistoryEntries ?? 1000;
    const users = await this.getUsers();
    const partitions = ['__shared__', ...users.map((u) => u.userId)];
    let totalPruned = 0;

    for (const partitionId of partitions) {
      await this.withLock(partitionId, async () => {
        const partitionDir = this.resolvePartitionDir(partitionId);
        const pruned = await this.prunePartitionSyncFile(partitionDir, keep);
        totalPruned += pruned;
      });
    }

    return {
      action: 'prune',
      backend: BackendType.File,
      tableName,
      affectedCount: totalPruned,
      message: `Prune completed successfully. Removed ${totalPruned} changelog record(s)`,
    };
  }

  async close(): Promise<void> {
    this.locks.clear();
  }

  protected override getBaseDir(): string | undefined {
    return this.baseDir;
  }

  private get usersFile(): string {
    return path.join(this.baseDir, 'users.json');
  }

  private get tablesFile(): string {
    return path.join(this.baseDir, 'tables.json');
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prevLock = this.locks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.locks.set(
      key,
      prevLock.then(() => currentLock),
    );

    try {
      await prevLock;
      return await fn();
    } finally {
      releaseLock();
      if (this.locks.get(key) === currentLock) {
        this.locks.delete(key);
      }
    }
  }

  private async prunePartitionSyncFile(
    partitionDir: string,
    maxHistory: number,
    threshold = maxHistory,
  ): Promise<number> {
    try {
      const syncFile = path.join(partitionDir, 'sync.jsonl');
      const metaFile = path.join(partitionDir, 'meta.json');

      const content = await fs.readFile(syncFile, 'utf-8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length > threshold) {
        const pruneCount = lines.length - maxHistory;
        const keptLines = lines.slice(pruneCount);
        const firstKept = JSON.parse(keptLines[0]) as { seq: number };
        await writeFileAtomic(syncFile, `${keptLines.join('\n')}\n`);

        try {
          const metaContent = await fs.readFile(metaFile, 'utf-8');
          const meta = JSON.parse(metaContent) as {
            currentSeq: number;
            minSeq: number;
          };
          meta.minSeq = firstKept.seq;
          await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
        } catch {
          // Ignore
        }
        return pruneCount;
      }
    } catch {
      // Ignore
    }
    return 0;
  }

  private async readUsersFile(): Promise<Map<string, FileUserData>> {
    try {
      const content = await fs.readFile(this.usersFile, 'utf-8');
      const list = JSON.parse(content) as FileUserData[];
      const map = new Map<string, FileUserData>();
      for (const u of list) {
        map.set(u.userId, u);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async writeUsersFile(
    users: Map<string, FileUserData>,
  ): Promise<void> {
    await writeFileAtomic(
      this.usersFile,
      JSON.stringify(Array.from(users.values()), null, 2),
    );
  }

  private async readTablesFile(): Promise<Map<string, FileTableData>> {
    try {
      const content = await fs.readFile(this.tablesFile, 'utf-8');
      const list = JSON.parse(content) as FileTableData[];
      const map = new Map<string, FileTableData>();
      for (const t of list) {
        map.set(t.name, t);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async writeTablesFile(
    tables: Map<string, FileTableData>,
  ): Promise<void> {
    await writeFileAtomic(
      this.tablesFile,
      JSON.stringify(Array.from(tables.values()), null, 2),
    );
  }

  async updateTableSettingsInFile(
    name: string,
    settings: TableSettings,
  ): Promise<void> {
    assertNoActiveServerLock(this.baseDir);
    return this.withLock('__tables__', async () => {
      const tables = await this.readTablesFile();
      const existing = tables.get(name);
      if (existing) {
        existing.settings = settings;
        await this.writeTablesFile(tables);
      }
    });
  }

  private resolvePartitionDir(effectiveUserId: string): string {
    if (effectiveUserId === '__shared__') {
      return path.join(this.baseDir, 'shared');
    }
    const bucket = getUserBucket(effectiveUserId);
    return path.join(this.baseDir, 'users', bucket, effectiveUserId);
  }

  async readTableRecords(
    effectiveUserId: string,
    tableName: string,
  ): Promise<Map<string, StoredRecord>> {
    const partitionDir = this.resolvePartitionDir(effectiveUserId);
    const recordsFile = path.join(partitionDir, tableName, 'records.json');
    try {
      const content = await fs.readFile(recordsFile, 'utf-8');
      const list = JSON.parse(content) as StoredRecord[];
      const map = new Map<string, StoredRecord>();
      for (const r of list) {
        map.set(r.id, r);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  async findUserDataById(userId: string): Promise<FileUserData | undefined> {
    const users = await this.readUsersFile();
    return users.get(userId);
  }

  async updateUserData(
    userId: string,
    update: Partial<FileUserData>,
  ): Promise<void> {
    assertNoActiveServerLock(this.baseDir);
    return this.withLock('__users__', async () => {
      const users = await this.readUsersFile();
      const existing = users.get(userId);
      if (!existing) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          'User not found',
        );
      }
      users.set(userId, { ...existing, ...update });
      await this.writeUsersFile(users);
    });
  }

  async deleteTable(name: string): Promise<boolean> {
    assertNoActiveServerLock(this.baseDir);
    const safeName = validateTableName(name);
    return this.withLock('__tables__', async () => {
      const tables = await this.readTablesFile();
      const deleted = tables.delete(safeName);
      if (deleted) {
        await this.writeTablesFile(tables);
        // Clean up shared table directory
        try {
          await fs.rm(path.join(this.baseDir, 'shared', safeName), {
            recursive: true,
            force: true,
          });
        } catch {
          // Ignore
        }
        // Clean up user table directories
        try {
          const usersBase = path.join(this.baseDir, 'users');
          const buckets = await fs
            .readdir(usersBase)
            .catch(() => [] as string[]);
          for (const b of buckets) {
            const bucketDir = path.join(usersBase, b);
            const userDirs = await fs
              .readdir(bucketDir)
              .catch(() => [] as string[]);
            for (const u of userDirs) {
              await fs
                .rm(path.join(bucketDir, u, safeName), {
                  recursive: true,
                  force: true,
                })
                .catch(() => {});
            }
          }
        } catch {
          // Ignore
        }
      }
      return deleted;
    });
  }

  async deleteUser(userId: string): Promise<boolean> {
    assertNoActiveServerLock(this.baseDir);
    const safeUserId = validateUserId(userId);
    return this.withLock('__users__', async () => {
      let deleted = false;
      const bucket = getUserBucket(safeUserId);
      const userDir = path.join(this.baseDir, 'users', bucket, safeUserId);
      try {
        await fs.rm(userDir, { recursive: true, force: true });
        deleted = true;
      } catch {
        // Ignore
      }

      const users = await this.readUsersFile();
      if (users.has(safeUserId)) {
        users.delete(safeUserId);
        await this.writeUsersFile(users);
        deleted = true;
      }

      return deleted;
    });
  }
}

// -- Private Helpers --------------------------------------------------------

/**
 * Validates that no external TetherDB server process is actively running on this data directory.
 *
 * @param baseDir - Storage base directory.
 * @throws TetherServerError if an active server lock is held by another process.
 */
export function assertNoActiveServerLock(baseDir: string): void {
  const lock = readServerLock(baseDir);
  if (lock && lock.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Cannot modify file storage directly while server is running (PID ${lock.pid})`,
    );
  }
}

/**
 * Writes data atomically to a file using a unique temp file and atomic rename.
 *
 * @param filePath - The destination file path.
 * @param content - File content to write.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}
