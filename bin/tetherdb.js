#!/usr/bin/env node
import { runCli } from '../dist/cli/index.js';

runCli().catch((err) => {
  console.error('Failed to start TetherDB CLI:', err);
  process.exit(1);
});
