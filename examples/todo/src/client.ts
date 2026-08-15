import {
  BeamedClientDB,
  type OperationType,
  SyncStatus,
  type Table,
} from 'beameddb';

/**
 * Todo record payload model stored in BeamedDB.
 */
export interface TodoItem {
  /** The todo item title. */
  title: string;
  /** Completion status flag. */
  completed: boolean;
}

/**
 * Filter view mode for todo items.
 */
export enum FilterMode {
  All = 'all',
  Active = 'active',
  Completed = 'completed',
}

/**
 * Account modal authentication mode.
 */
export enum AuthMode {
  Login = 'login',
  Register = 'register',
}

/**
 * Log entry origin category.
 */
export enum LogCategory {
  Local = 'local',
  Remote = 'remote',
  Sync = 'sync',
}

interface UserSession {
  user: {
    id: string;
    username: string;
  };
  token?: string;
}

// Application & Auth State
let currentUser: UserSession | null = (() => {
  const saved = localStorage.getItem('beamed_todo_user');
  if (!saved) return null;
  try {
    return JSON.parse(saved) as UserSession;
  } catch {
    return null;
  }
})();

let db: BeamedClientDB | null = null;
let todosTable: Table<TodoItem> | null = null;
let currentFilter: FilterMode = FilterMode.All;
let authMode: AuthMode = AuthMode.Login;

// DOM References
const currentUsernameEl = document.getElementById(
  'currentUsername',
) as HTMLSpanElement;
const userBadgeBtn = document.getElementById(
  'userBadgeBtn',
) as HTMLButtonElement;
const statusPill = document.getElementById('statusPill') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const itemCountEl = document.getElementById('itemCount') as HTMLSpanElement;
const newTodoForm = document.getElementById('newTodoForm') as HTMLFormElement;
const newTodoInput = document.getElementById(
  'newTodoInput',
) as HTMLInputElement;
const todoList = document.getElementById('todoList') as HTMLUListElement;
const emptyState = document.getElementById('emptyState') as HTMLDivElement;
const clearCompletedBtn = document.getElementById(
  'clearCompletedBtn',
) as HTMLButtonElement;
const filterBtns = document.querySelectorAll<HTMLButtonElement>('.filter-btn');
const activityLog = document.getElementById('activityLog') as HTMLDivElement;

const authDialog = document.getElementById('authDialog') as HTMLDialogElement;
const closeAuthModalBtn = document.getElementById(
  'closeAuthModalBtn',
) as HTMLButtonElement;
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

/**
 * Appends an event to the on-screen live event stream.
 *
 * @param category - The log entry category.
 * @param tag - Tag name describing the event source.
 * @param message - Informational message to display.
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
  activityLog.prepend(div);
}

/**
 * Initializes authentication and sets up the BeamedDB database connection.
 */
async function initApp(): Promise<void> {
  if (!currentUser) {
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'demo', password: 'password123' }),
      });
      if (res.ok) {
        currentUser = (await res.json()) as UserSession;
      } else {
        const regRes = await fetch('/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'demo', password: 'password123' }),
        });
        if (regRes.ok) {
          currentUser = (await regRes.json()) as UserSession;
        }
      }
      if (currentUser) {
        localStorage.setItem('beamed_todo_user', JSON.stringify(currentUser));
      }
    } catch (_err) {
      currentUser = { user: { id: 'offline_user', username: 'offline' } };
    }
  }

  updateUserUI();
  await setupDatabase();
}

/**
 * Updates the user badge text.
 */
function updateUserUI(): void {
  currentUsernameEl.textContent = currentUser?.user?.username ?? 'Guest';
}

/**
 * Configures the BeamedClientDB instance and sets up reactive subscriptions.
 */
async function setupDatabase(): Promise<void> {
  if (db) {
    await db.close();
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/sync`;

  // 1. Initialize BeamedClientDB with local IndexedDB and sync options
  db = new BeamedClientDB({
    name: `beamed-todo-${currentUser?.user?.id ?? 'guest'}`,
    stores: ['todos'],
    sync: currentUser?.token
      ? {
          url: wsUrl,
          token: currentUser.token,
        }
      : undefined,
  });

  // 2. Obtain typed Table<TodoItem> reference
  todosTable = db.table<TodoItem>('todos');

  logEvent(LogCategory.Sync, 'Init', `Opened local IndexedDB table "todos"`);

  // 3. Subscribe to reactive Table changes (both local mutations and remote WebSocket broadcasts)
  todosTable.subscribe(
    ({
      op,
      id,
      isRemote,
      data,
    }: {
      op: OperationType;
      id: string;
      isRemote?: boolean;
      data?: TodoItem;
    }) => {
      const origin = isRemote ? 'Remote Sync' : 'Local IDB';
      const category = isRemote ? LogCategory.Remote : LogCategory.Local;
      const title = data?.title ?? id;
      logEvent(category, origin, `${op.toUpperCase()} "${title}"`);
      renderTodos();
    },
  );

  // 4. Monitor synchronization connection status
  if (db.sync) {
    db.sync.onStatusChange(async (status: SyncStatus) => {
      updateSyncStatusUI(status);
      logEvent(LogCategory.Sync, 'SyncStatus', status.toUpperCase());

      // If token expired or server secret changed, re-authenticate demo user
      if (
        status === SyncStatus.Error &&
        currentUser?.user?.username === 'demo'
      ) {
        try {
          const res = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'demo', password: 'password123' }),
          });
          if (res.ok) {
            currentUser = (await res.json()) as UserSession;
            localStorage.setItem(
              'beamed_todo_user',
              JSON.stringify(currentUser),
            );
            updateUserUI();
            await setupDatabase();
          }
        } catch {
          // Server offline
        }
      }
    });
  } else {
    updateSyncStatusUI(SyncStatus.Disconnected);
  }

  await renderTodos();
}

/**
 * Updates the sync status badge in the header.
 */
function updateSyncStatusUI(status: SyncStatus): void {
  statusPill.className = `status-pill status-${status}`;
  switch (status) {
    case SyncStatus.Connected:
      statusText.textContent = 'Connected & Live';
      break;
    case SyncStatus.Connecting:
      statusText.textContent = 'Connecting...';
      break;
    case SyncStatus.Syncing:
      statusText.textContent = 'Syncing...';
      break;
    case SyncStatus.Disconnected:
      statusText.textContent = 'Offline';
      break;
    case SyncStatus.Error:
      statusText.textContent = 'Sync Error';
      break;
  }
}

/**
 * Reads records from IndexedDB via `todosTable.getAllWithMetadata()` and renders the list.
 */
async function renderTodos(): Promise<void> {
  if (!todosTable) return;
  const allTodos = await todosTable.getAllWithMetadata();

  allTodos.sort((a, b) => a.timestamp - b.timestamp);

  const filtered = allTodos.filter((item) => {
    if (currentFilter === FilterMode.Active) return !item.data.completed;
    if (currentFilter === FilterMode.Completed) return item.data.completed;
    return true;
  });

  const activeCount = allTodos.filter((t) => !t.data.completed).length;
  itemCountEl.textContent = `${activeCount} ${activeCount === 1 ? 'item' : 'items'} left`;

  todoList.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.style.display = 'block';
    emptyState.textContent =
      allTodos.length === 0
        ? 'No todos yet. Add one above!'
        : `No ${currentFilter} todos found.`;
  } else {
    emptyState.style.display = 'none';

    for (const item of filtered) {
      const li = document.createElement('li');
      li.className = `todo-item ${item.data.completed ? 'completed' : ''}`;
      li.dataset.id = item.id;

      li.innerHTML = `
        <div class="todo-left">
          <input type="checkbox" class="todo-checkbox" ${item.data.completed ? 'checked' : ''}>
          <span class="todo-text">${escapeHtml(item.data.title)}</span>
        </div>
        <button type="button" class="delete-btn" title="Delete todo">✕</button>
      `;

      // Checkbox toggle: saves locally & triggers background sync via todosTable.put()
      const checkbox = li.querySelector(
        '.todo-checkbox',
      ) as HTMLInputElement | null;
      checkbox?.addEventListener('change', async () => {
        if (!todosTable) return;
        await todosTable.put(item.id, {
          ...item.data,
          completed: checkbox.checked,
        });
      });

      // Delete: creates tombstone locally & triggers background sync via todosTable.delete()
      const deleteBtn = li.querySelector(
        '.delete-btn',
      ) as HTMLButtonElement | null;
      deleteBtn?.addEventListener('click', async () => {
        if (!todosTable) return;
        await todosTable.delete(item.id);
      });

      todoList.appendChild(li);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Add new Todo: writes locally to IndexedDB and queues for background sync
newTodoForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const title = newTodoInput.value.trim();
  if (!title || !todosTable) return;

  const id = `todo_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  await todosTable.put(id, {
    title,
    completed: false,
  });

  newTodoInput.value = '';
});

// Filter controls
filterBtns.forEach((btn: HTMLButtonElement) => {
  btn.addEventListener('click', () => {
    filterBtns.forEach((b: HTMLButtonElement) => {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    currentFilter = (btn.dataset.filter as FilterMode) ?? FilterMode.All;
    renderTodos();
  });
});

// Clear completed todos
clearCompletedBtn.addEventListener('click', async () => {
  if (!todosTable) return;
  const allTodos = await todosTable.getAllWithMetadata();
  for (const item of allTodos) {
    if (item.data.completed) {
      await todosTable.delete(item.id);
    }
  }
});

// Auth Modal
userBadgeBtn.addEventListener('click', () => {
  authError.classList.remove('visible');
  authUsername.value = '';
  authPassword.value = '';
  authDialog.showModal();
});

closeAuthModalBtn.addEventListener('click', () => {
  authDialog.close();
});

tabLogin.addEventListener('click', () => {
  authMode = AuthMode.Login;
  tabLogin.classList.add('active');
  tabRegister.classList.remove('active');
  authSubmitBtn.textContent = 'Login';
  authError.classList.remove('visible');
});

tabRegister.addEventListener('click', () => {
  authMode = AuthMode.Register;
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
    const endpoint =
      authMode === AuthMode.Register ? '/auth/register' : '/auth/login';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = (await res.json()) as UserSession & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? 'Authentication failed');
    }

    currentUser = data;
    localStorage.setItem('beamed_todo_user', JSON.stringify(currentUser));
    updateUserUI();
    authDialog.close();
    await setupDatabase();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication error';
    authError.textContent = message;
    authError.classList.add('visible');
  }
});

// Start the app
initApp();
