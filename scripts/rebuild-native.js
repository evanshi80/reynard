/**
 * Rebuild native modules for current platform
 * Use this after copying to a new computer
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Native modules that need rebuilding
const NATIVE_MODULES = [
  'robotjs',
  'koffi',
  'better-sqlite3',
  'sharp',
];

console.log('=== Rebuilding Native Modules ===\n');

// Rebuild each module
for (const mod of NATIVE_MODULES) {
  console.log(`Rebuilding ${mod}...`);
  try {
    execSync(`npm rebuild ${mod}`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log(`  ${mod} rebuilt successfully\n`);
  } catch (err) {
    console.error(`  Failed to rebuild ${mod}:`, err.message, '\n');
  }
}

console.log('=== Rebuild Complete ===');
