import type { TableRow } from 'tetherdb/server';

/**
 * Model for an individual line in the collaborative document.
 */
export interface DocumentLine {
  order: number;
  text: string;
}

const INITIAL_DOCUMENT = `# Welcome to TetherDB Collaborative Editor 🚀

This is a **real-time collaborative markdown editor** powered by [TetherDB](https://github.com/renggli/typescript-tetherdb).

### How It Works
- **Zero Sign-In**: Unauthenticated guests join immediately with a random name and vibrant color.
- **Live Presence**: Real-time cursor positions, text selections, and collaborator status are synced instantly.
- **Local-First & Offline-Ready**: Every keystroke persists to local IndexedDB before syncing over WebSockets.
- **Public Permissions**: Configured with \`Permission.Everybody\` for full read/write access.

### Try It Now! 👥
Open this page in a **second browser window or tab** to see real-time multi-cursor collaboration and live typing!

\`\`\`typescript
// Zero-config public table sync in TetherDB:
const db = new TetherClient({ name: 'editor-example' });
const docTable = db.table('document');
const presenceTable = db.table('presence');
\`\`\``;

/**
 * Initial seed rows for the collaborative document.
 */
export const documentRows: TableRow<DocumentLine>[] = INITIAL_DOCUMENT.split(
  '\n',
).map((text, index) => ({
  id: `line_${String(index + 1).padStart(3, '0')}`,
  data: {
    order: (index + 1) * 100,
    text,
  },
}));
