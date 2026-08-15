import {
  type AuthResult,
  BeamedAuthClient,
  BeamedClientDB,
  SyncStatus,
  type Table,
  type TableChangeEvent,
} from 'beameddb';

/**
 * Todo record data model.
 */
interface TodoItem {
  title: string;
  completed: boolean;
}

/**
 * Filter viewing modes for the todo list.
 */
enum FilterMode {
  All = 'all',
  Active = 'active',
  Completed = 'completed',
}

/**
 * Visual badge categories for the on-screen live event stream.
 */
enum LogCategory {
  Local = 'local',
  Remote = 'remote',
  Sync = 'sync',
}

/**
 * Mode of the authentication dialog modal.
 */
enum AuthMode {
  Login = 'login',
  Register = 'register',
}

// User State from storage
let currentUser: AuthResult | null = (() => {
  const saved = localStorage.getItem('beamed_todo_user');
  if (!saved) return null;
  try {
    return JSON.parse(saved) as AuthResult;
  } catch {
    return null;
  }
})();

// Database & UI State
const db = new BeamedClientDB({ name: 'beamed_todo_app' });
const todosTable: Table<TodoItem> = db.table<TodoItem>('todos');
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
 * Updates the user badge text.
 */
function updateUserUI(): void {
  currentUsernameEl.textContent =
    currentUser?.user?.username ?? 'Offline Guest';
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
    case SyncStatus.Disconnected:
      statusText.textContent = 'Offline (Local Only)';
      break;
    case SyncStatus.Error:
      statusText.textContent = 'Sync Error';
      break;
  }
}

/**
 * Reads records from IndexedDB and renders the list.
 */
async function renderTodos(): Promise<void> {
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

    const MAX_RENDER_ITEMS = 100;
    const itemsToRender = filtered.slice(0, MAX_RENDER_ITEMS);
    const remainingCount = filtered.length - MAX_RENDER_ITEMS;

    for (const item of itemsToRender) {
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
        await todosTable.delete(item.id);
      });

      todoList.appendChild(li);
    }

    if (remainingCount > 0) {
      const moreLi = document.createElement('li');
      moreLi.className = 'todo-item-more';
      moreLi.textContent = `... and ${remainingCount} more`;
      todoList.appendChild(moreLi);
    }
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Add new Todo: writes locally to IndexedDB and automatically queues for sync if enabled
newTodoForm.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const title = newTodoInput.value.trim();
  if (!title) return;

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

// Clear completed todos using batched deleteAll
clearCompletedBtn.addEventListener('click', async () => {
  const allTodos = await todosTable.getAllWithMetadata();
  const completedIds = allTodos
    .filter((item) => item.data.completed)
    .map((item) => item.id);

  if (completedIds.length > 0) {
    await todosTable.deleteAll(completedIds);
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
  const serverUrl = window.location.origin;

  try {
    let result: AuthResult;
    if (authMode === AuthMode.Register) {
      result = await db.register({ serverUrl, username, password });
    } else {
      result = await db.login({ serverUrl, username, password });
    }

    currentUser = result;
    localStorage.setItem('beamed_todo_user', JSON.stringify(currentUser));
    updateUserUI();
    authDialog.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication error';
    authError.textContent = message;
    authError.classList.add('visible');
  }
});

/**
 * Initializes application, reactive table subscribers, and auto-connects sync if token exists.
 */
async function init(): Promise<void> {
  updateUserUI();

  // 1. Subscribe to reactive Table changes
  todosTable.subscribe((events: TableChangeEvent<TodoItem>[]) => {
    for (const { op, id, isRemote, data } of events) {
      const origin = isRemote ? 'Remote Sync' : 'Local IDB';
      const category = isRemote ? LogCategory.Remote : LogCategory.Local;
      const title = data?.title ?? id;
      logEvent(category, origin, `${op.toUpperCase()} "${title}"`);
    }
    renderTodos();
  });

  // 2. Monitor sync connection status changes
  db.onSyncStatusChange((status: SyncStatus) => {
    updateSyncStatusUI(status);
    logEvent(LogCategory.Sync, 'SyncStatus', status.toUpperCase());
  });

  // 3. Connect sync if user previously logged in, or try demo account
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/sync`;

  if (currentUser?.token) {
    db.enableSync({ url: wsUrl, token: currentUser.token });
  } else {
    // Attempt auto-login demo user for instant multi-tab demonstration
    const authClient = new BeamedAuthClient({
      serverUrl: window.location.origin,
    });
    try {
      let auth = await authClient
        .login({ username: 'demo', password: 'password123' })
        .catch(() => null);

      if (!auth) {
        auth = await authClient
          .register({ username: 'demo', password: 'password123' })
          .catch(() => null);
      }

      if (auth) {
        currentUser = auth;
        localStorage.setItem('beamed_todo_user', JSON.stringify(currentUser));
        updateUserUI();
        db.enableSync({ url: wsUrl, token: auth.token });
      }
    } catch {
      // Offline mode
    }
  }

  // Initial render from local IndexedDB
  await renderTodos();
}

init();
