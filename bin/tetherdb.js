#!/usr/bin/env node
import { runCli } from '../dist/server/tetherdb.js';

runCli().catch((err) => {
  console.error('Failed to start TetherDB CLI:', err);
  process.exit(1);
});
