import {
  SyncStatus,
  type Table,
  type TableChangeEvent,
  TetherClient,
} from 'tetherdb/client';

/**
 * Model for an individual line in the collaborative document.
 */
export interface DocumentLine {
  order: number;
  text: string;
}

/**
 * Coordinate specifying a line ID and character column offset.
 */
export interface TextPosition {
  lineId: string;
  ch: number;
}

/**
 * Multi-line selection coordinate using stable line IDs.
 */
export interface SelectionCoordinate {
  start: TextPosition;
  end: TextPosition;
}

/**
 * Active participant presence record.
 */
export interface ParticipantPresence {
  id: string;
  name: string;
  color: string;
  cursor?: TextPosition;
  selection?: SelectionCoordinate | null;
  lastActive: number;
}

// -----------------------------------------------------------------------------
// Random Identity Generation
// -----------------------------------------------------------------------------

const ADJECTIVES = [
  'Emerald',
  'Neon',
  'Sapphire',
  'Solar',
  'Velvet',
  'Cosmic',
  'Golden',
  'Swift',
  'Amber',
  'Crimson',
  'Radiant',
  'Silver',
];

const ANIMALS = [
  'Otter',
  'Falcon',
  'Fox',
  'Koala',
  'Panda',
  'Tiger',
  'Dolphin',
  'Badger',
  'Cheetah',
  'Owl',
  'Lynx',
  'Wolf',
];

const COLORS = [
  '#38bdf8',
  '#34d399',
  '#f472b6',
  '#a78bfa',
  '#fbbf24',
  '#fb7185',
  '#22d3ee',
  '#818cf8',
  '#4ade80',
  '#e879f9',
];

function generateParticipant(): { id: string; name: string; color: string } {
  const key = 'tether_editor_user';
  const existing = sessionStorage.getItem(key);
  if (existing) {
    try {
      return JSON.parse(existing);
    } catch {
      // Ignore parse failure
    }
  }

  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const id = `user_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const profile = { id, name: `${adj} ${animal}`, color };
  sessionStorage.setItem(key, JSON.stringify(profile));
  return profile;
}

// -----------------------------------------------------------------------------
// Database & State Management
// -----------------------------------------------------------------------------

const localUser = generateParticipant();
const db = new TetherClient('editor-example');
const docTable: Table<DocumentLine> = db.table<DocumentLine>('document');
const presenceTable: Table<ParticipantPresence> =
  db.table<ParticipantPresence>('presence');

const documentLines = new Map<
  string,
  { id: string; order: number; text: string }
>();
const activePresences = new Map<string, ParticipantPresence>();

const LINE_HEIGHT_PX = 24;
const PADDING_TOP = 12;
const PADDING_LEFT = 16;
let charWidthPx = 9.0;
let isLocalInputting = false;

// DOM References
const statusPill = document.getElementById('statusPill') as HTMLDivElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const collaboratorsList = document.getElementById(
  'collaboratorsList',
) as HTMLDivElement;
const editorGutter = document.getElementById('editorGutter') as HTMLDivElement;
const editorOverlays = document.getElementById(
  'editorOverlays',
) as HTMLDivElement;
const textarea = document.getElementById(
  'editorTextarea',
) as HTMLTextAreaElement;
const previewContent = document.getElementById(
  'previewContent',
) as HTMLDivElement;

// -----------------------------------------------------------------------------
// UI Rendering & Coordinate System
// -----------------------------------------------------------------------------

function updateSyncStatusUI(status: SyncStatus): void {
  statusPill.className = `status-pill status-${SyncStatus[status].toLowerCase()}`;
  switch (status) {
    case SyncStatus.Connected:
      statusText.textContent = 'Live Sync';
      break;
    case SyncStatus.Connecting:
      statusText.textContent = 'Connecting...';
      break;
    case SyncStatus.Disconnected:
      statusText.textContent = 'Offline';
      break;
    case SyncStatus.Error:
      statusText.textContent = 'Sync Error';
      break;
  }
}

function renderCollaborators(): void {
  const now = Date.now();
  const currentActiveIds = new Set<string>();

  // 1. Ensure local user avatar exists at the very right
  let selfAvatar = collaboratorsList.querySelector(
    `[data-user-id="${localUser.id}"]`,
  ) as HTMLElement | null;
  if (!selfAvatar) {
    selfAvatar = createAvatarElement(
      localUser.id,
      localUser.name,
      localUser.color,
      true,
    );
    collaboratorsList.appendChild(selfAvatar);
  }

  // 2. Remote active users (placed before self avatar)
  for (const [id, presence] of activePresences.entries()) {
    if (id === localUser.id || now - presence.lastActive > 10_000) continue;
    currentActiveIds.add(id);

    let chip = collaboratorsList.querySelector(
      `[data-user-id="${id}"]`,
    ) as HTMLElement | null;
    if (!chip) {
      chip = createAvatarElement(id, presence.name, presence.color, false);
      collaboratorsList.insertBefore(chip, selfAvatar);
    }
  }

  // 3. Remove inactive/departed remote users
  const existingChips = collaboratorsList.querySelectorAll(
    '.collaborator-avatar:not(.is-self)',
  );
  for (const chip of existingChips) {
    const el = chip as HTMLElement;
    const uid = el.dataset.userId;
    if (uid && !currentActiveIds.has(uid)) {
      el.remove();
    }
  }
}

function createAvatarElement(
  id: string,
  name: string,
  color: string,
  isSelf: boolean,
): HTMLElement {
  const chip = document.createElement('div');
  chip.className = `collaborator-avatar ${isSelf ? 'is-self' : ''}`;
  chip.dataset.userId = id;
  chip.style.backgroundColor = color;
  chip.style.setProperty('--avatar-color', color);

  const initials = name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('');

  const initialsEl = document.createElement('span');
  initialsEl.className = 'avatar-initials';
  initialsEl.textContent = initials;

  const tooltipEl = document.createElement('span');
  tooltipEl.className = 'avatar-tooltip';
  tooltipEl.textContent = `${name}${isSelf ? ' (You)' : ''}`;

  chip.appendChild(initialsEl);
  chip.appendChild(tooltipEl);
  return chip;
}

function measureCharWidth(): void {
  const span = document.createElement('span');
  span.style.fontFamily = getComputedStyle(textarea).fontFamily || 'monospace';
  span.style.fontSize = getComputedStyle(textarea).fontSize || '15px';
  span.style.letterSpacing =
    getComputedStyle(textarea).letterSpacing || 'normal';
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.style.whiteSpace = 'pre';
  span.textContent = 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM';
  document.body.appendChild(span);
  charWidthPx = span.getBoundingClientRect().width / 40 || 9.0;
  document.body.removeChild(span);
}

/**
 * Transforms a character offset in `oldText` to its corresponding position in `newText`.
 */
function transformOffset(
  oldText: string,
  newText: string,
  offset: number,
): number {
  if (oldText === newText || offset <= 0) {
    return Math.max(0, Math.min(offset, newText.length));
  }

  // Common prefix
  let prefix = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (
    prefix < minLen &&
    oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)
  ) {
    prefix++;
  }

  if (offset <= prefix) {
    return offset;
  }

  // Common suffix
  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldText.charCodeAt(oldSuffix - 1) === newText.charCodeAt(newSuffix - 1)
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const deleteCount = oldSuffix - prefix;
  const insertCount = newSuffix - prefix;

  if (offset <= prefix + deleteCount) {
    return prefix + insertCount;
  }

  const delta = insertCount - deleteCount;
  return Math.max(0, Math.min(offset + delta, newText.length));
}

function syncGutterAndOverlays(): void {
  editorGutter.scrollTop = textarea.scrollTop;
  editorOverlays.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
}

function renderGutter(lineCount: number): void {
  const count = Math.max(lineCount, 1);
  let html = '';
  for (let i = 1; i <= count; i++) {
    html += `<div class="gutter-num">${i}</div>`;
  }
  editorGutter.innerHTML = html;
  editorGutter.scrollTop = textarea.scrollTop;
}

// -----------------------------------------------------------------------------
// Document Synchronization
// -----------------------------------------------------------------------------

function getSortedLines(): Array<{ id: string; order: number; text: string }> {
  return Array.from(documentLines.values()).sort((a, b) => a.order - b.order);
}

function getFullDocumentText(): string {
  const sorted = getSortedLines();
  return sorted.map((l) => l.text).join('\n');
}

/**
 * Pushes local textarea text changes to TetherDB using prefix/suffix line reconciliation.
 */
async function syncLocalTextToDatabase(newText: string): Promise<void> {
  isLocalInputting = true;
  const newLines = newText.split('\n');
  const sorted = getSortedLines();

  // 1. In-place line update when line count is unchanged
  if (newLines.length === sorted.length) {
    for (let i = 0; i < newLines.length; i++) {
      const line = sorted[i];
      if (line.text !== newLines[i]) {
        line.text = newLines[i];
        documentLines.set(line.id, line);
        await docTable.put(line.id, {
          order: line.order,
          text: line.text,
        });
      }
    }
  } else {
    // 2. Line insertion/deletion diffing (retaining untouched line IDs)
    let prefix = 0;
    while (
      prefix < sorted.length &&
      prefix < newLines.length &&
      sorted[prefix].text === newLines[prefix]
    ) {
      prefix++;
    }

    let oldSuffix = sorted.length;
    let newSuffix = newLines.length;
    while (
      oldSuffix > prefix &&
      newSuffix > prefix &&
      sorted[oldSuffix - 1].text === newLines[newSuffix - 1]
    ) {
      oldSuffix--;
      newSuffix--;
    }

    // Delete removed lines
    for (let i = prefix; i < oldSuffix; i++) {
      const line = sorted[i];
      documentLines.delete(line.id);
      await docTable.delete(line.id);
    }

    // Insert new lines with fractional orders
    const prevOrder = prefix > 0 ? sorted[prefix - 1].order : 0;
    const nextOrder =
      oldSuffix < sorted.length
        ? sorted[oldSuffix].order
        : (sorted.length + 1) * 1000;
    const insertedCount = newSuffix - prefix;
    const step = (nextOrder - prevOrder) / (insertedCount + 1);

    for (let i = 0; i < insertedCount; i++) {
      const lineIndex = prefix + i;
      const text = newLines[lineIndex];
      const id = `line_${Date.now()}_${lineIndex}_${Math.random().toString(36).substring(2, 6)}`;
      const order = prevOrder + (i + 1) * step;
      documentLines.set(id, { id, order, text });
      await docTable.put(id, { order, text });
    }
  }

  renderGutter(newLines.length);
  renderMarkdownPreview();
  renderRemoteOverlays();
  isLocalInputting = false;
}

// -----------------------------------------------------------------------------
// Presence & Multi-Line Selection / Cursor Overlays
// -----------------------------------------------------------------------------

function offsetToPosition(
  text: string,
  offset: number,
): { lineIndex: number; ch: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const sub = text.substring(0, clamped);
  const lines = sub.split('\n');
  const lineIndex = lines.length - 1;
  const ch = lines[lineIndex].length;
  return { lineIndex, ch };
}

function captureLocalPresence(): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  const sorted = getSortedLines();

  const startCoords = offsetToPosition(text, start);
  const endCoords = offsetToPosition(text, end);

  const startLine = sorted[startCoords.lineIndex];
  const endLine = sorted[endCoords.lineIndex];

  if (!endLine) return;

  const cursor: TextPosition = {
    lineId: endLine.id,
    ch: endCoords.ch,
  };

  let selection: SelectionCoordinate | null = null;
  if (start !== end && startLine && endLine) {
    selection = {
      start: { lineId: startLine.id, ch: startCoords.ch },
      end: { lineId: endLine.id, ch: endCoords.ch },
    };
  }

  presenceTable
    .put(localUser.id, {
      id: localUser.id,
      name: localUser.name,
      color: localUser.color,
      cursor,
      selection,
      lastActive: Date.now(),
    })
    .catch(() => {});
}

function renderRemoteOverlays(): void {
  const container = document.createElement('div');
  container.className = 'editor-overlays-inner';

  const sorted = getSortedLines();
  const lineToIndex = new Map<string, number>();
  for (let idx = 0; idx < sorted.length; idx++) {
    lineToIndex.set(sorted[idx].id, idx);
  }

  const text = textarea.value;
  const lines = text.split('\n');
  const now = Date.now();

  for (const [id, presence] of activePresences.entries()) {
    if (id === localUser.id || now - presence.lastActive > 10_000) continue;

    // 1. Render multi-line remote selection highlight
    if (presence.selection) {
      const rawStartLine = lineToIndex.get(presence.selection.start.lineId);
      const rawEndLine = lineToIndex.get(presence.selection.end.lineId);

      if (rawStartLine !== undefined && rawEndLine !== undefined) {
        let startLine = rawStartLine;
        let startCh = presence.selection.start.ch;
        let endLine = rawEndLine;
        let endCh = presence.selection.end.ch;

        if (startLine > endLine || (startLine === endLine && startCh > endCh)) {
          startLine = rawEndLine;
          startCh = presence.selection.end.ch;
          endLine = rawStartLine;
          endCh = presence.selection.start.ch;
        }

        if (startLine === endLine) {
          // Single-line selection
          const top = PADDING_TOP + startLine * LINE_HEIGHT_PX;
          const left = PADDING_LEFT + startCh * charWidthPx;
          const width = Math.max((endCh - startCh) * charWidthPx, 4);

          const box = document.createElement('div');
          box.className = 'remote-selection';
          box.style.top = `${top}px`;
          box.style.left = `${left}px`;
          box.style.width = `${width}px`;
          box.style.height = `${LINE_HEIGHT_PX}px`;
          box.style.backgroundColor = presence.color;
          container.appendChild(box);
        } else {
          // Multi-line selection
          for (let l = startLine; l <= endLine; l++) {
            const lineLength = (lines[l] ?? '').length;
            const top = PADDING_TOP + l * LINE_HEIGHT_PX;
            let left = PADDING_LEFT;
            let width = 0;

            if (l === startLine) {
              left = PADDING_LEFT + startCh * charWidthPx;
              width = Math.max((lineLength - startCh + 0.6) * charWidthPx, 4);
            } else if (l === endLine) {
              left = PADDING_LEFT;
              width = Math.max(endCh * charWidthPx, 4);
            } else {
              left = PADDING_LEFT;
              width = Math.max((lineLength + 0.6) * charWidthPx, 8);
            }

            const box = document.createElement('div');
            box.className = 'remote-selection';
            box.style.top = `${top}px`;
            box.style.left = `${left}px`;
            box.style.width = `${width}px`;
            box.style.height = `${LINE_HEIGHT_PX}px`;
            box.style.backgroundColor = presence.color;
            container.appendChild(box);
          }
        }
      }
    }

    // 2. Render remote cursor & floating user name badge
    if (presence.cursor) {
      const lineIdx = lineToIndex.get(presence.cursor.lineId);
      if (lineIdx !== undefined) {
        const top = PADDING_TOP + lineIdx * LINE_HEIGHT_PX;
        const left = PADDING_LEFT + presence.cursor.ch * charWidthPx;

        const isTopLine = lineIdx === 0;
        const tagClass = isTopLine ? 'tag-bottom' : 'tag-top';

        const cursorEl = document.createElement('div');
        cursorEl.className = 'remote-cursor';
        cursorEl.style.top = `${top}px`;
        cursorEl.style.left = `${left}px`;
        cursorEl.style.color = presence.color;
        cursorEl.innerHTML = `
          <div class="remote-cursor-caret" style="background-color: ${presence.color};"></div>
          <div class="remote-name-tag ${tagClass}" style="background-color: ${presence.color};">${escapeHtml(presence.name)}</div>
        `;
        container.appendChild(cursorEl);
      }
    }
  }

  editorOverlays.replaceChildren(container);
  syncGutterAndOverlays();
}

// -----------------------------------------------------------------------------
// Markdown Preview Parser
// -----------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function parseMarkdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        out.push(
          `<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        if (inList) {
          out.push('</ul>');
          inList = false;
        }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(rawLine);
      continue;
    }

    if (/^(\*\*\*|---|___)$/.test(line.trim())) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push('<hr>');
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      const level = headingMatch[1].length;
      out.push(
        `<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`,
      );
      continue;
    }

    const listMatch = line.match(/^[-*]\s+(.*)$/);
    if (listMatch?.[1]) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInlineMarkdown(listMatch[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }

    const quoteMatch = line.match(/^>\s+(.*)$/);
    if (quoteMatch?.[1]) {
      out.push(
        `<blockquote>${formatInlineMarkdown(quoteMatch[1])}</blockquote>`,
      );
      continue;
    }

    if (!line.trim()) continue;
    out.push(`<p>${formatInlineMarkdown(line)}</p>`);
  }

  if (inCodeBlock) {
    out.push(
      `<pre><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`,
    );
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function formatInlineMarkdown(text: string): string {
  let formatted = escapeHtml(text);
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  formatted = formatted.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
  formatted = formatted.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');
  formatted = formatted.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return formatted;
}

function renderMarkdownPreview(): void {
  previewContent.innerHTML = parseMarkdownToHtml(textarea.value);
}

// -----------------------------------------------------------------------------
// App Initialization & Event Wiring
// -----------------------------------------------------------------------------

async function init(): Promise<void> {
  // Reset local tables on start for a fresh session
  await db.clear();

  measureCharWidth();
  window.addEventListener('resize', () => {
    measureCharWidth();
    renderRemoteOverlays();
  });

  window.addEventListener('beforeunload', () => {
    presenceTable.delete(localUser.id).catch(() => {});
    sessionStorage.removeItem('tether_editor_user');
    db.clear().catch(() => {});
  });

  // Textarea input & mouse/key interaction
  textarea.addEventListener('input', () => {
    syncLocalTextToDatabase(textarea.value);
    captureLocalPresence();
  });

  textarea.addEventListener('scroll', syncGutterAndOverlays);

  // Mouse & Selection tracking (mousedown immediately captures accurate position)
  textarea.addEventListener('mousedown', () => {
    requestAnimationFrame(captureLocalPresence);
  });

  textarea.addEventListener('mousemove', (e: MouseEvent) => {
    if (e.buttons === 1) {
      captureLocalPresence();
    }
  });

  textarea.addEventListener('mouseup', captureLocalPresence);
  textarea.addEventListener('select', captureLocalPresence);
  textarea.addEventListener('keyup', captureLocalPresence);
  textarea.addEventListener('focus', captureLocalPresence);

  // Tab key indent support
  textarea.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText('  ', start, end, 'end');

      syncLocalTextToDatabase(textarea.value);
      captureLocalPresence();
    }
  });

  // 1. Subscribe to Document Table changes
  docTable.onChange.register((events: TableChangeEvent<DocumentLine>[]) => {
    for (const { op, id, data } of events) {
      if (op === 'delete') {
        documentLines.delete(id);
      } else if (data) {
        documentLines.set(id, { id, order: data.order, text: data.text });
      }
    }

    if (!isLocalInputting) {
      const fullText = getFullDocumentText();
      const oldText = textarea.value;
      if (oldText !== fullText) {
        const newStart = transformOffset(
          oldText,
          fullText,
          textarea.selectionStart,
        );
        const newEnd = transformOffset(
          oldText,
          fullText,
          textarea.selectionEnd,
        );

        textarea.value = fullText;
        try {
          textarea.setSelectionRange(newStart, newEnd);
        } catch {
          // Ignored
        }
        renderGutter(fullText.split('\n').length);
        renderMarkdownPreview();
        renderRemoteOverlays();
      }
    }
  });

  // 2. Subscribe to Presence Table changes
  presenceTable.onChange.register(
    (events: TableChangeEvent<ParticipantPresence>[]) => {
      for (const { op, id, data } of events) {
        if (op === 'delete') {
          activePresences.delete(id);
        } else if (data) {
          activePresences.set(id, data);
        }
      }
      renderCollaborators();
      renderRemoteOverlays();
    },
  );

  // 3. Monitor Sync Status
  db.onSyncStatusChange.register(updateSyncStatusUI);
  updateSyncStatusUI(db.syncStatus);

  // 4. Load initial records
  const initialLines = await docTable.getAllWithMetadata();
  for (const item of initialLines) {
    documentLines.set(item.id, {
      id: item.id,
      order: item.data.order,
      text: item.data.text,
    });
  }

  const initialPresences = await presenceTable.getAllWithMetadata();
  for (const item of initialPresences) {
    activePresences.set(item.id, item.data);
  }

  const initialFullText = getFullDocumentText();
  textarea.value = initialFullText;
  renderGutter(initialFullText.split('\n').length);
  renderMarkdownPreview();
  renderCollaborators();
  renderRemoteOverlays();

  // 5. Start Heartbeat & Sweep Timers
  captureLocalPresence();
  setInterval(captureLocalPresence, 3000);

  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, presence] of activePresences.entries()) {
      if (now - presence.lastActive > 12_000) {
        activePresences.delete(id);
        changed = true;
        presenceTable.delete(id).catch(() => {});
      }
    }
    if (changed) {
      renderCollaborators();
      renderRemoteOverlays();
    }
  }, 5000);
}

init();
