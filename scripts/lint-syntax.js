/**
 * Syntax check all JS files in src/ using node --check
 */
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execSync } from 'node:child_process';

function walkJsFiles(dir) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkJsFiles(fullPath));
      } else if (entry.isFile() && extname(entry.name) === '.js') {
        results.push(fullPath);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

const srcDir = join(process.cwd(), 'src');
const files = walkJsFiles(srcDir);
let errors = 0;

for (const file of files) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
  } catch (err) {
    console.error(`SYNTAX ERROR: ${file}`);
    console.error(err.stderr?.toString() || err.message);
    errors++;
  }
}

if (errors === 0) {
  console.log(`All ${files.length} files passed syntax check.`);
} else {
  console.error(`\n${errors} file(s) failed syntax check.`);
  process.exit(1);
}
