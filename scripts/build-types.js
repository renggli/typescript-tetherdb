import * as fs from 'node:fs';
import * as path from 'node:path';

function generateCtsDeclarations(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      generateCtsDeclarations(fullPath);
    } else if (entry.name.endsWith('.d.ts')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const ctsPath = fullPath.replace(/\.d\.ts$/, '.d.cts');
      const updatedContent = content.replace(
        /(['"][^'"]+)\.js(['"])/g,
        '$1.cjs$2',
      );
      fs.writeFileSync(ctsPath, updatedContent, 'utf8');
    }
  }
}

const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distDir)) {
  generateCtsDeclarations(distDir);
}
