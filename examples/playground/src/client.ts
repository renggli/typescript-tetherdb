import {
  AuthStatus,
  IndexRange,
  SyncStatus,
  type Table,
  type TableChangeEvent,
  type TablePutEntry,
  TetherClient,
} from 'tetherdb/client';

/**
 * Log categories for the on-screen live event stream.
 */
enum LogCategory {
  Local = 'local',
  Remote = 'remote',
  Sync = 'sync',
  Index = 'index',
  Bench = 'bench',
  Error = 'error',
}

/**
 * Benchmark configuration.
 */
interface BenchmarkConfig {
  name: string;
  mode: 'putAll' | 'putSeq' | 'getSeq' | 'getAll' | 'mixed' | 'deleteAll';
  count: number;
  batchSize?: number;
}

/**
 * Benchmark summary record.
 */
interface BenchmarkRecord {
  time: string;
  scenario: string;
  ops: number;
  durationMs: number;
  throughput: number;
  avgLatencyMs: number;
}

// -----------------------------------------------------------------------------
// Database & UI State
// -----------------------------------------------------------------------------

const db = new TetherClient({
  name: 'playground-example',
  url: window.location.origin,
});

let currentTableName = 'items';
let activeTable: Table<Record<string, unknown>> = db.table(currentTableName);
let isBenchRunning = false;
let shouldStopBench = false;
const benchHistory: BenchmarkRecord[] = [];

// -----------------------------------------------------------------------------
// DOM References
// -----------------------------------------------------------------------------

// Header & Navigation
const currentUsernameEl = document.getElementById(
  'currentUsername',
) as HTMLSpanElement;
const userBadgeBtn = document.getElementById(
  'userBadgeBtn',
) as HTMLButtonElement;
const statusPill = document.getElementById('statusPill') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const toggleSyncBtn = document.getElementById(
  'toggleSyncBtn',
) as HTMLButtonElement;
const activeTableLabel = document.getElementById(
  'activeTableLabel',
) as HTMLElement;
const errorBanner = document.getElementById('errorBanner') as HTMLDivElement;
const errorMessageEl = document.getElementById(
  'errorMessage',
) as HTMLSpanElement;
const closeErrorBtn = document.getElementById(
  'closeErrorBtn',
) as HTMLButtonElement;
const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

// Playground Controls
const fillSampleBtn = document.getElementById(
  'fillSampleBtn',
) as HTMLButtonElement;
const tableSelect = document.getElementById('tableSelect') as HTMLSelectElement;
const recordIdInput = document.getElementById('recordId') as HTMLInputElement;
const recordDataInput = document.getElementById(
  'recordData',
) as HTMLTextAreaElement;
const putRecordBtn = document.getElementById(
  'putRecordBtn',
) as HTMLButtonElement;
const getRecordBtn = document.getElementById(
  'getRecordBtn',
) as HTMLButtonElement;
const deleteRecordBtn = document.getElementById(
  'deleteRecordBtn',
) as HTMLButtonElement;
const getAllRecordsBtn = document.getElementById(
  'getAllRecordsBtn',
) as HTMLButtonElement;
const countRecordsBtn = document.getElementById(
  'countRecordsBtn',
) as HTMLButtonElement;
const clearTableBtn = document.getElementById(
  'clearTableBtn',
) as HTMLButtonElement;

// Index Controls
const indexKeyPathInput = document.getElementById(
  'indexKeyPath',
) as HTMLInputElement;
const indexUniqueCheckbox = document.getElementById(
  'indexUnique',
) as HTMLInputElement;
const indexMultiEntryCheckbox = document.getElementById(
  'indexMultiEntry',
) as HTMLInputElement;
const registerIndexBtn = document.getElementById(
  'registerIndexBtn',
) as HTMLButtonElement;
const queryIndexSelect = document.getElementById(
  'queryIndexSelect',
) as HTMLSelectElement;
const queryRangeType = document.getElementById(
  'queryRangeType',
) as HTMLSelectElement;
const queryValue1Input = document.getElementById(
  'queryValue1',
) as HTMLInputElement;
const queryValue2Input = document.getElementById(
  'queryValue2',
) as HTMLInputElement;
const queryValue2Group = document.getElementById(
  'queryValue2Group',
) as HTMLDivElement;
const queryIndexGetAllBtn = document.getElementById(
  'queryIndexGetAllBtn',
) as HTMLButtonElement;
const queryIndexCountBtn = document.getElementById(
  'queryIndexCountBtn',
) as HTMLButtonElement;
const queryIndexKeysBtn = document.getElementById(
  'queryIndexKeysBtn',
) as HTMLButtonElement;

// Results & Logs
const resultMetaEl = document.getElementById('resultMeta') as HTMLElement;
const jsonOutputEl = document.getElementById('jsonOutput') as HTMLPreElement;
const activityLogEl = document.getElementById('activityLog') as HTMLDivElement;
const clearLogBtn = document.getElementById('clearLogBtn') as HTMLButtonElement;

// Benchmarks Controls
const presetBtns = document.querySelectorAll<HTMLButtonElement>('.preset-btn');
const stopBenchBtn = document.getElementById(
  'stopBenchBtn',
) as HTMLButtonElement;
const benchStatusBadge = document.getElementById(
  'benchStatusBadge',
) as HTMLElement;
const benchProgressBar = document.getElementById(
  'benchProgressBar',
) as HTMLDivElement;
const metricOpsEl = document.getElementById('metricOps') as HTMLElement;
const metricDurationEl = document.getElementById(
  'metricDuration',
) as HTMLElement;
const metricThroughputEl = document.getElementById(
  'metricThroughput',
) as HTMLElement;
const metricAvgLatencyEl = document.getElementById(
  'metricAvgLatency',
) as HTMLElement;
const benchHistoryBody = document.getElementById(
  'benchHistoryBody',
) as HTMLTableSectionElement;

// Auth Modal
const authDialog = document.getElementById('authDialog') as HTMLDialogElement;
const closeAuthModalBtn = document.getElementById(
  'closeAuthModalBtn',
) as HTMLButtonElement;
const sessionSection = document.getElementById(
  'sessionSection',
) as HTMLDivElement;
const modalUsername = document.getElementById(
  'modalUsername',
) as HTMLSpanElement;
const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement;
const tabLogin = document.getElementById('tabLogin') as HTMLButtonElement;
const tabRegister = document.getElementById('tabRegister') as HTMLButtonElement;
const authForm = document.getElementById('authForm') as HTMLFormElement;
const authUsername = document.getElementById(
  'authUsername',
) as HTMLInputElement;
const authPassword = document.getElementById(
  'authPassword',
) as HTMLInputElement;
const authSubmitBtn = document.getElementById(
  'authSubmitBtn',
) as HTMLButtonElement;
const authError = document.getElementById('authError') as HTMLDivElement;
let authMode: 'login' | 'register' = 'login';

// -----------------------------------------------------------------------------
// UI Error & Alert Handling
// -----------------------------------------------------------------------------

/**
 * Displays an error banner in the UI and logs to the activity stream.
 */
function showError(message: string): void {
  errorMessageEl.textContent = message;
  errorBanner.style.display = 'flex';
  logEvent(LogCategory.Error, 'Error', message);
}

/**
 * Hides the error banner.
 */
function hideError(): void {
  errorBanner.style.display = 'none';
}

closeErrorBtn.addEventListener('click', hideError);

// -----------------------------------------------------------------------------
// Live Activity Logging & JSON Inspector
// -----------------------------------------------------------------------------

/**
 * Appends an entry to the live reactive event stream.
 */
function logEvent(category: LogCategory, tag: string, message: string): void {
  const time = new Date().toLocaleTimeString().split(' ')[0];
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-tag ${category}">[${tag}]</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  activityLogEl.prepend(div);
}

/**
 * Escapes characters for HTML safe rendering.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Renders JSON result with elapsed execution time.
 */
function displayResult(title: string, data: unknown, durationMs: number): void {
  hideError();
  resultMetaEl.textContent = `${durationMs.toFixed(1)} ms`;
  jsonOutputEl.textContent = `// ${title}\n${JSON.stringify(data, null, 2)}`;
}

// -----------------------------------------------------------------------------
// Table Management & Subscriptions
// -----------------------------------------------------------------------------

let tableUnsubscribe: (() => void) | undefined;

/**
 * Switches the active table and updates event subscriptions.
 */
function switchTable(name: string): void {
  currentTableName = name;
  activeTable = db.table(currentTableName);
  activeTableLabel.textContent = currentTableName;

  if (tableUnsubscribe) {
    tableUnsubscribe();
  }

  tableUnsubscribe = activeTable.onChange.register(
    (events: TableChangeEvent<Record<string, unknown>>[]) => {
      for (const { op, id, isRemote } of events) {
        const origin = isRemote ? 'Remote Sync' : 'Local IDB';
        const cat = isRemote ? LogCategory.Remote : LogCategory.Local;
        logEvent(cat, origin, `${op.toUpperCase()} ${currentTableName}/${id}`);
      }
    },
  );

  // Auto-declare default indexes for demonstration
  activeTable.index('category');
  activeTable.index('score');
  activeTable.index('title');

  refreshIndexDropdown();
  logEvent(
    LogCategory.Local,
    'Table',
    `Active table switched to "${currentTableName}"`,
  );
}

/**
 * Updates index selector dropdown.
 */
function refreshIndexDropdown(): void {
  queryIndexSelect.innerHTML = '';
  const indexes = activeTable.indexes;

  if (indexes.length === 0) {
    queryIndexSelect.innerHTML =
      '<option value="">-- No indexes declared --</option>';
    return;
  }

  for (const idx of indexes) {
    const opt = document.createElement('option');
    opt.value = idx.name;
    opt.textContent = `${idx.name} (keyPath: ${String(idx.keyPath)})`;
    queryIndexSelect.appendChild(opt);
  }
}

// -----------------------------------------------------------------------------
// Playground CRUD Actions
// -----------------------------------------------------------------------------

fillSampleBtn.addEventListener('click', () => {
  const categories = ['books', 'electronics', 'clothing', 'garden'];
  const cat = categories[Math.floor(Math.random() * categories.length)];
  const score = Math.floor(Math.random() * 100) + 1;
  const num = Math.floor(Math.random() * 900) + 100;

  recordIdInput.value = `${currentTableName.slice(0, 4)}_${num}`;
  recordDataInput.value = JSON.stringify(
    {
      title: `Sample ${cat} item ${num}`,
      category: cat,
      score,
      tags: [cat, score > 50 ? 'featured' : 'standard'],
      createdAt: Date.now(),
    },
    null,
    2,
  );
});

putRecordBtn.addEventListener('click', async () => {
  try {
    const id =
      recordIdInput.value.trim() ||
      `item_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const raw = recordDataInput.value.trim();
    const data = raw ? JSON.parse(raw) : { title: 'New Item', score: 10 };

    const start = performance.now();
    await activeTable.put(id, data);
    const duration = performance.now() - start;

    recordIdInput.value = id;
    displayResult(`Put record: ${id}`, { id, ...data }, duration);
  } catch (err) {
    showError(
      `Put failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

getRecordBtn.addEventListener('click', async () => {
  try {
    const id = recordIdInput.value.trim();
    if (!id) {
      showError('Please enter a Record ID to fetch.');
      return;
    }

    const start = performance.now();
    const record = await activeTable.getWithMetadata(id);
    const duration = performance.now() - start;

    if (!record) {
      displayResult(`Get record: ${id}`, 'Record not found', duration);
    } else {
      displayResult(`Get record: ${id}`, record, duration);
    }
  } catch (err) {
    showError(
      `Get failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

deleteRecordBtn.addEventListener('click', async () => {
  try {
    const id = recordIdInput.value.trim();
    if (!id) {
      showError('Please enter a Record ID to delete.');
      return;
    }

    const start = performance.now();
    await activeTable.delete(id);
    const duration = performance.now() - start;

    displayResult(`Delete record: ${id}`, { id, deleted: true }, duration);
  } catch (err) {
    showError(
      `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

getAllRecordsBtn.addEventListener('click', async () => {
  try {
    const start = performance.now();
    const all = await activeTable.getAllWithMetadata();
    const duration = performance.now() - start;
    displayResult(
      `Get All Records (${all.length} items in ${currentTableName})`,
      all,
      duration,
    );
  } catch (err) {
    showError(
      `Get All failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

countRecordsBtn.addEventListener('click', async () => {
  try {
    const start = performance.now();
    const count = await activeTable.count();
    const duration = performance.now() - start;
    displayResult(
      `Total count for table "${currentTableName}"`,
      { count },
      duration,
    );
  } catch (err) {
    showError(
      `Count failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

clearTableBtn.addEventListener('click', async () => {
  try {
    if (
      !confirm(
        `Are you sure you want to clear all records from "${currentTableName}"?`,
      )
    )
      return;
    const start = performance.now();
    await activeTable.clear();
    const duration = performance.now() - start;
    displayResult(
      `Cleared all records in "${currentTableName}"`,
      { cleared: true },
      duration,
    );
  } catch (err) {
    showError(
      `Clear failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Index Operations
// -----------------------------------------------------------------------------

registerIndexBtn.addEventListener('click', () => {
  try {
    const keyPath = indexKeyPathInput.value.trim();
    if (!keyPath) {
      showError('Please enter a field path to index (e.g. "category").');
      return;
    }

    const unique = indexUniqueCheckbox.checked;
    const multiEntry = indexMultiEntryCheckbox.checked;

    const idx = activeTable.index(keyPath, { unique, multiEntry });
    refreshIndexDropdown();
    queryIndexSelect.value = idx.name;

    logEvent(
      LogCategory.Index,
      'IndexCreated',
      `Registered index "${idx.name}" on ${currentTableName}`,
    );
    displayResult(
      `Registered Index "${idx.name}"`,
      { name: idx.name, keyPath, unique, multiEntry },
      0,
    );
  } catch (err) {
    showError(
      `Index creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

queryRangeType.addEventListener('change', () => {
  queryValue2Group.style.display =
    queryRangeType.value === 'between' ? 'block' : 'none';
});

/**
 * Builds key range query from UI inputs.
 */
function buildIndexQuery(): IDBValidKey | IDBKeyRange | undefined {
  const type = queryRangeType.value;
  const val1Str = queryValue1Input.value.trim();
  const val2Str = queryValue2Input.value.trim();

  const parseVal = (str: string): IDBValidKey => {
    if (!Number.isNaN(Number(str)) && str !== '') return Number(str);
    return str;
  };

  switch (type) {
    case 'all':
      return undefined;
    case 'exact':
      return val1Str ? parseVal(val1Str) : undefined;
    case 'startsWith':
      return IndexRange.startsWith(val1Str);
    case 'greaterThan':
      return IndexRange.greaterThan(parseVal(val1Str), false);
    case 'lessThan':
      return IndexRange.lessThan(parseVal(val1Str), false);
    case 'between':
      return IndexRange.between(parseVal(val1Str), parseVal(val2Str), true);
    default:
      return undefined;
  }
}

queryIndexGetAllBtn.addEventListener('click', async () => {
  try {
    const indexName = queryIndexSelect.value;
    if (!indexName) {
      showError('Please select an index to query.');
      return;
    }

    const idx = activeTable.index(indexName);
    const query = buildIndexQuery();

    const start = performance.now();
    const results = await idx.getAllWithMetadata(query);
    const duration = performance.now() - start;

    displayResult(
      `Index Query "${indexName}" (${results.length} items)`,
      results,
      duration,
    );
    logEvent(
      LogCategory.Index,
      'Query',
      `Queried "${indexName}" -> returned ${results.length} items in ${duration.toFixed(1)}ms`,
    );
  } catch (err) {
    showError(
      `Index Query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

queryIndexCountBtn.addEventListener('click', async () => {
  try {
    const indexName = queryIndexSelect.value;
    if (!indexName) {
      showError('Please select an index to count.');
      return;
    }

    const idx = activeTable.index(indexName);
    const query = buildIndexQuery();

    const start = performance.now();
    const count = await idx.count(query);
    const duration = performance.now() - start;

    displayResult(`Index Count for "${indexName}"`, { count }, duration);
  } catch (err) {
    showError(
      `Index Count failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

queryIndexKeysBtn.addEventListener('click', async () => {
  try {
    const indexName = queryIndexSelect.value;
    if (!indexName) {
      showError('Please select an index.');
      return;
    }

    const idx = activeTable.index(indexName);
    const query = buildIndexQuery();

    const start = performance.now();
    const primaryKeys = await idx.getPrimaryKeys(query);
    const duration = performance.now() - start;

    displayResult(
      `Primary Keys for "${indexName}" (${primaryKeys.length} keys)`,
      primaryKeys,
      duration,
    );
  } catch (err) {
    showError(
      `Primary Keys failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

// -----------------------------------------------------------------------------
// Stress & Benchmark Suite
// -----------------------------------------------------------------------------

presetBtns.forEach((btn) => {
  btn.addEventListener('click', async () => {
    const preset = btn.dataset.preset;
    switch (preset) {
      case 'putAll-1000':
        await runBenchmark({
          name: '1,000 Bulk Put (putAll)',
          mode: 'putAll',
          count: 1000,
          batchSize: 250,
        });
        break;
      case 'putAll-5000':
        await runBenchmark({
          name: '5,000 Bulk Put (putAll)',
          mode: 'putAll',
          count: 5000,
          batchSize: 500,
        });
        break;
      case 'putSeq-100':
        await runBenchmark({
          name: '100 Sequential Put (put)',
          mode: 'putSeq',
          count: 100,
        });
        break;
      case 'putSeq-500':
        await runBenchmark({
          name: '500 Sequential Put (put)',
          mode: 'putSeq',
          count: 500,
        });
        break;
      case 'getSeq-500':
        await runBenchmark({
          name: '500 Sequential Get (get)',
          mode: 'getSeq',
          count: 500,
        });
        break;
      case 'getAll-table':
        await runBenchmark({
          name: 'Table Scan (getAll x20)',
          mode: 'getAll',
          count: 20,
        });
        break;
      case 'mixed-500':
        await runBenchmark({
          name: '500 Mixed Ops (R/W/D)',
          mode: 'mixed',
          count: 500,
        });
        break;
      case 'deleteAll-1000':
        await runBenchmark({
          name: '1,000 Bulk Delete (deleteAll)',
          mode: 'deleteAll',
          count: 1000,
          batchSize: 250,
        });
        break;
    }
  });
});

stopBenchBtn.addEventListener('click', () => {
  shouldStopBench = true;
  stopBenchBtn.disabled = true;
});

/**
 * Runs an automated stress test against the benchmarks table.
 */
async function runBenchmark(config: BenchmarkConfig): Promise<void> {
  if (isBenchRunning) return;
  isBenchRunning = true;
  shouldStopBench = false;
  hideError();

  stopBenchBtn.style.display = 'inline-flex';
  stopBenchBtn.disabled = false;
  benchStatusBadge.textContent = 'Running...';
  benchProgressBar.style.width = '0%';

  const benchTable = db.table('benchmarks');
  const startTime = performance.now();
  let completedOps = 0;

  const updateMetrics = () => {
    const pct = Math.min(
      100,
      Math.round((completedOps / Math.max(1, config.count)) * 100),
    );
    benchProgressBar.style.width = `${pct}%`;
    metricOpsEl.textContent = completedOps.toLocaleString();
    const elapsed = performance.now() - startTime;
    metricDurationEl.textContent = `${elapsed.toFixed(0)} ms`;
    const tput = elapsed > 0 ? Math.round(completedOps / (elapsed / 1000)) : 0;
    metricThroughputEl.textContent = `${tput.toLocaleString()} ops/s`;
    const latency =
      completedOps > 0 ? (elapsed / completedOps).toFixed(2) : '0';
    metricAvgLatencyEl.textContent = `${latency} ms`;
  };

  logEvent(
    LogCategory.Bench,
    'Benchmark',
    `Started: ${config.name} (${config.count} operations)...`,
  );

  try {
    switch (config.mode) {
      case 'putAll': {
        const batchSize = config.batchSize ?? 250;
        let batchIdx = 0;
        while (completedOps < config.count && !shouldStopBench) {
          const chunk = Math.min(batchSize, config.count - completedOps);
          const entries: TablePutEntry<Record<string, unknown>>[] = [];
          for (let i = 0; i < chunk; i++) {
            entries.push({
              id: `b_${batchIdx}_${i}`,
              data: {
                title: `Bench Record ${completedOps + i}`,
                score: (completedOps + i) % 100,
                category: 'benchmark',
                timestamp: Date.now(),
              },
            });
          }
          await benchTable.putAll(entries);
          completedOps += chunk;
          batchIdx++;
          updateMetrics();
        }
        break;
      }

      case 'putSeq': {
        for (let i = 0; i < config.count && !shouldStopBench; i++) {
          await benchTable.put(`seq_${i}`, {
            title: `Seq Item ${i}`,
            score: i,
          });
          completedOps++;
          if (i % 25 === 0 || i === config.count - 1) {
            updateMetrics();
          }
        }
        break;
      }

      case 'getSeq': {
        // Seed 50 items first
        const seeds: TablePutEntry<Record<string, unknown>>[] = [];
        for (let i = 0; i < 50; i++) {
          seeds.push({ id: `seed_${i}`, data: { idx: i } });
        }
        await benchTable.putAll(seeds);

        for (let i = 0; i < config.count && !shouldStopBench; i++) {
          await benchTable.get(`seed_${i % 50}`);
          completedOps++;
          if (i % 50 === 0 || i === config.count - 1) {
            updateMetrics();
          }
        }
        break;
      }

      case 'getAll': {
        for (let i = 0; i < config.count && !shouldStopBench; i++) {
          await benchTable.getAll();
          completedOps++;
          updateMetrics();
        }
        break;
      }

      case 'mixed': {
        const seedIds = Array.from({ length: 30 }, (_, i) => `mix_${i}`);
        await benchTable.putAll(
          seedIds.map((id, idx) => ({ id, data: { idx } })),
        );

        for (let i = 0; i < config.count && !shouldStopBench; i++) {
          const target = seedIds[i % seedIds.length];
          const rand = Math.random();
          if (rand < 0.7) {
            await benchTable.get(target);
          } else if (rand < 0.9) {
            await benchTable.put(target, { idx: i, updated: Date.now() });
          } else {
            await benchTable.delete(target);
          }
          completedOps++;
          if (i % 25 === 0 || i === config.count - 1) {
            updateMetrics();
          }
        }
        break;
      }

      case 'deleteAll': {
        const batchSize = config.batchSize ?? 250;
        const idsToDelete: string[] = [];
        const entries: TablePutEntry<Record<string, unknown>>[] = [];
        for (let i = 0; i < config.count; i++) {
          const id = `del_${i}_${Date.now()}`;
          idsToDelete.push(id);
          entries.push({ id, data: { i } });
        }
        await benchTable.putAll(entries);

        let delIdx = 0;
        while (delIdx < idsToDelete.length && !shouldStopBench) {
          const chunk = idsToDelete.slice(delIdx, delIdx + batchSize);
          await benchTable.deleteAll(chunk);
          delIdx += chunk.length;
          completedOps = delIdx;
          updateMetrics();
        }
        break;
      }
    }
  } catch (err) {
    showError(
      `Benchmark encountered an error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    const finalElapsed = performance.now() - startTime;
    const finalTput =
      finalElapsed > 0 ? Math.round(completedOps / (finalElapsed / 1000)) : 0;
    const finalLatency = completedOps > 0 ? finalElapsed / completedOps : 0;

    isBenchRunning = false;
    stopBenchBtn.style.display = 'none';
    benchStatusBadge.textContent = shouldStopBench ? 'Stopped' : 'Completed';
    benchProgressBar.style.width = '100%';

    const rec: BenchmarkRecord = {
      time: new Date().toLocaleTimeString(),
      scenario: config.name,
      ops: completedOps,
      durationMs: finalElapsed,
      throughput: finalTput,
      avgLatencyMs: finalLatency,
    };

    recordBenchmarkResult(rec);
    logEvent(
      LogCategory.Bench,
      'BenchDone',
      `Completed ${config.name}: ${completedOps} ops in ${finalElapsed.toFixed(0)}ms (${finalTput.toLocaleString()} ops/s)`,
    );
  }
}

/**
 * Adds benchmark result to history table.
 */
function recordBenchmarkResult(rec: BenchmarkRecord): void {
  benchHistory.unshift(rec);
  if (benchHistory.length > 8) benchHistory.pop();

  benchHistoryBody.innerHTML = '';
  for (const r of benchHistory) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.time}</td>
      <td><strong>${escapeHtml(r.scenario)}</strong></td>
      <td>${r.ops.toLocaleString()}</td>
      <td>${r.durationMs.toFixed(0)} ms</td>
      <td style="color: var(--primary); font-weight: bold;">${r.throughput.toLocaleString()} ops/s</td>
      <td>${r.avgLatencyMs.toFixed(2)} ms</td>
    `;
    benchHistoryBody.appendChild(tr);
  }
}

// -----------------------------------------------------------------------------
// Tabs & Controls Setup
// -----------------------------------------------------------------------------

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => {
      b.classList.remove('active');
    });
    tabContents.forEach((c) => {
      c.classList.remove('active');
    });

    btn.classList.add('active');
    const targetId = `${btn.dataset.tab}Tab`;
    const targetEl = document.getElementById(targetId);
    if (targetEl) targetEl.classList.add('active');
  });
});

tableSelect.addEventListener('change', () => {
  switchTable(tableSelect.value);
});

clearLogBtn.addEventListener('click', () => {
  activityLogEl.innerHTML = '';
});

toggleSyncBtn.addEventListener('click', () => {
  if (db.syncStatus === SyncStatus.Connected) {
    db.disconnect();
    toggleSyncBtn.textContent = 'Connect';
    logEvent(
      LogCategory.Sync,
      'Sync',
      'Disconnected WebSocket sync (offline mode)',
    );
  } else {
    db.connect();
    toggleSyncBtn.textContent = 'Disconnect';
    logEvent(LogCategory.Sync, 'Sync', 'Reconnected WebSocket sync');
  }
});

// -----------------------------------------------------------------------------
// Authentication Modal
// -----------------------------------------------------------------------------

function updateUserUI(): void {
  currentUsernameEl.textContent =
    db.authStatus === AuthStatus.SignedIn
      ? (db.username ?? 'Authenticated User')
      : 'Offline Guest';
}

function updateSyncStatusUI(status: SyncStatus): void {
  statusPill.className = `status-pill status-${SyncStatus[status].toLowerCase()}`;
  switch (status) {
    case SyncStatus.Connected:
      statusText.textContent = 'Connected & Live';
      toggleSyncBtn.textContent = 'Disconnect';
      break;
    case SyncStatus.Connecting:
      statusText.textContent = 'Connecting...';
      break;
    case SyncStatus.Disconnected:
      statusText.textContent = 'Offline (Local Only)';
      toggleSyncBtn.textContent = 'Connect';
      break;
    case SyncStatus.Error:
      statusText.textContent =
        db.authStatus === AuthStatus.SignedIn ? 'Sync Error' : 'Auth Required';
      break;
  }
}

userBadgeBtn.addEventListener('click', () => {
  authError.classList.remove('visible');
  authUsername.value = '';
  authPassword.value = '';

  if (db.authStatus === AuthStatus.SignedIn) {
    sessionSection.style.display = 'block';
    modalUsername.textContent = db.username ?? 'User';
  } else {
    sessionSection.style.display = 'none';
  }

  authDialog.showModal();
});

closeAuthModalBtn.addEventListener('click', () => {
  authDialog.close();
});

logoutBtn.addEventListener('click', async () => {
  await db.logout();
  authDialog.close();
});

tabLogin.addEventListener('click', () => {
  authMode = 'login';
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  authSubmitBtn.textContent = 'Login';
  authError.classList.remove('visible');
});

tabRegister.addEventListener('click', () => {
  authMode = 'register';
  tabRegister.classList.add('active');
  tabLogin.classList.remove('active');
  authSubmitBtn.textContent = 'Register';
  authError.classList.remove('visible');
});

authForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  authError.classList.remove('visible');

  const username = authUsername.value.trim();
  const password = authPassword.value;

  try {
    let success = false;
    if (authMode === 'register') {
      success = await db.register({ username, password, remember: true });
    } else {
      success = await db.login({ username, password, remember: true });
    }

    if (success) {
      authDialog.close();
    } else {
      throw new Error('Authentication failed.');
    }
  } catch (err) {
    authError.textContent = err instanceof Error ? err.message : 'Auth error';
    authError.classList.add('visible');
  }
});

// -----------------------------------------------------------------------------
// App Initialization
// -----------------------------------------------------------------------------

async function init(): Promise<void> {
  // Sync and Auth event listeners
  db.onAuthStatusChange.register((status) => {
    updateUserUI();
    logEvent(LogCategory.Sync, 'Auth', `AuthStatus: ${AuthStatus[status]}`);
  });

  db.onSyncStatusChange.register((status) => {
    updateSyncStatusUI(status);
    logEvent(LogCategory.Sync, 'Sync', `SyncStatus: ${SyncStatus[status]}`);
  });

  // Client error listener
  db.onError.register((err) => {
    showError(`Sync error: ${err.message}`);
  });

  // Initialize table & UI
  switchTable('items');
  updateUserUI();
  updateSyncStatusUI(db.syncStatus);

  // Pre-fill sample inputs
  fillSampleBtn.click();

  // Restore session or login as demo
  if (db.authStatus !== AuthStatus.SignedIn) {
    const restored = await db.login();
    if (!restored) {
      await db
        .login({ username: 'demo', password: 'password123', remember: true })
        .catch(() => null);
    }
  }
}

init();
