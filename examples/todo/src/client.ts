import {
  AuthStatus,
  SyncStatus,
  type Table,
  type TableChangeEvent,
  TetherClient,
} from 'tetherdb/client';

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

// Database & UI State — initialize with unified backend URL
const db = new TetherClient('todo-example', {
  url: window.location.origin,
});
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
 * Escapes HTML characters in user-provided strings.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Updates the user badge text.
 */
function updateUserUI(): void {
  currentUsernameEl.textContent =
    db.authStatus === AuthStatus.SignedIn
      ? (db.username ?? 'Authenticated User')
      : 'Offline Guest';
}

/**
 * Updates the sync status badge in the header.
 */
function updateSyncStatusUI(status: SyncStatus): void {
  statusPill.className = `status-pill status-${SyncStatus[status].toLowerCase()}`;
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
      statusText.textContent =
        db.authStatus === AuthStatus.SignedIn ? 'Sync Error' : 'Auth Required';
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

      const todoLeft = document.createElement('div');
      todoLeft.className = 'todo-left';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'todo-checkbox';
      checkbox.checked = item.data.completed;
      checkbox.addEventListener('change', async () => {
        await todosTable.put(item.id, {
          title: item.data.title,
          completed: checkbox.checked,
        });
      });

      const span = document.createElement('span');
      span.className = 'todo-text';
      span.textContent = item.data.title;

      todoLeft.appendChild(checkbox);
      todoLeft.appendChild(span);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'delete-btn';
      deleteBtn.setAttribute('aria-label', `Delete "${item.data.title}"`);
      deleteBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;
      deleteBtn.addEventListener('click', async () => {
        await todosTable.delete(item.id);
      });

      li.appendChild(todoLeft);
      li.appendChild(deleteBtn);
      todoList.appendChild(li);
    }

    if (remainingCount > 0) {
      const moreLi = document.createElement('li');
      moreLi.className = 'todo-item-more';
      moreLi.textContent = `... and ${remainingCount} more items`;
      todoList.appendChild(moreLi);
    }
  }
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
    let success = false;
    if (authMode === AuthMode.Register) {
      success = await db.register({
        username,
        password,
        remember: true,
      });
    } else {
      success = await db.login({
        username,
        password,
        remember: true,
      });
    }

    if (success) {
      authDialog.close();
    } else {
      throw new Error('Authentication failed. Please check credentials.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Authentication error';
    authError.textContent = message;
    authError.classList.add('visible');
  }
});

/**
 * Initializes application, reactive table subscribers, and auto-connects sync.
 */
async function init(): Promise<void> {
  // 1. Subscribe to reactive Table changes
  todosTable.onChange.register((events: TableChangeEvent<TodoItem>[]) => {
    for (const { op, id, isRemote, data } of events) {
      const origin = isRemote ? 'Remote Sync' : 'Local IDB';
      const category = isRemote ? LogCategory.Remote : LogCategory.Local;
      const title = data?.title ?? id;
      logEvent(category, origin, `${op.toUpperCase()} "${title}"`);
    }
    renderTodos();
  });

  // 2. React to Auth status changes
  db.onAuthStatusChange.register((status) => {
    updateUserUI();
    renderTodos();
    logEvent(LogCategory.Sync, 'Auth', `AuthStatus: ${AuthStatus[status]}`);
  });

  // 3. React to Sync status changes
  db.onSyncStatusChange.register((status) => {
    updateSyncStatusUI(status);
    logEvent(
      LogCategory.Sync,
      'SyncStatus',
      `SyncStatus: ${SyncStatus[status]}`,
    );
  });

  // 4. Initial UI rendering
  updateUserUI();
  updateSyncStatusUI(db.syncStatus);
  await renderTodos();

  // 5. Restore existing session or authenticate with the default demo account
  if (db.authStatus !== AuthStatus.SignedIn) {
    const restored = await db.login();
    if (!restored) {
      await db
        .login({
          username: 'demo',
          password: 'password123',
          remember: true,
        })
        .catch(() => null);
    }
  }
}

init();
