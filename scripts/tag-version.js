import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageJsonPath = path.resolve(process.cwd(), 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const tag = `v${pkg.version}`;

try {
  const existingTags = execSync('git tag -l', { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

  if (existingTags.includes(tag)) {
    console.log(`Git tag ${tag} already exists.`);
  } else {
    execSync(`git tag -a ${tag} -m "Release ${tag}"`, { stdio: 'inherit' });
    console.log(`Successfully tagged git repository with ${tag}`);
  }
} catch (err) {
  console.error(`Failed to tag git repository with ${tag}:`, err.message);
  process.exit(1);
}
