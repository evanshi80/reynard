/**
 * Distribution packager for Reynard
 * Creates a distributable package with all necessary files
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Use fixed folder name to avoid locking issues
const DIST = path.join(ROOT, 'reynard-v2.0.0');
const DATA_DIR = path.join(DIST, 'data');

const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

const EXCLUDE_DIRS = [
  'node_modules/.cache',
  'node_modules/@types',
  'node_modules/typescript',
  'node_modules/ts-node',
  'node_modules/tsx',
  'node_modules/nodemon',
  'node_modules/rimraf',
  'node_modules/@anthropic-ai',
  'node_modules/undici',
  'node_modules/formdata-polyfill',
  'node_modules/webidl-conversions',
  'node_modules/axios',
];

const EXCLUDE_EXT = [
  '.ts',
  '.map',
  '.md',
  '.gitignore',
];

function copyDir(src, dest, options = {}) {
  const { excludeDirs = [], excludeExt = [] } = options;

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded directories
    if (entry.isDirectory()) {
      if (excludeDirs.some(d => srcPath.includes(d))) {
        console.log(`  Skip dir: ${entry.name}`);
        continue;
      }
      copyDir(srcPath, destPath, options);
      continue;
    }

    // Skip excluded extensions
    if (excludeExt.some(ext => entry.name.toLowerCase().endsWith(ext))) {
      console.log(`  Skip file: ${entry.name}`);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    console.log(`  Copy: ${entry.name}`);
  }
}

// Simple recursive copy for dist files (no exclusions)
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyDirSelective(src, dest, excludeDirs, excludeExt) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.some(d => entry.name === d || srcPath.includes(d))) {
        console.log(`  Skip dir: ${entry.name}`);
        continue;
      }
      copyDirSelective(srcPath, destPath, excludeDirs, excludeExt);
      continue;
    }

    if (excludeExt.some(ext => entry.name.toLowerCase().endsWith(ext))) {
      console.log(`  Skip file: ${entry.name}`);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
  }
}

console.log('=== Reynard Distribution Packager ===\n');

// Clean previous dist
console.log('1. Cleaning previous distribution...');
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}

// Copy built JavaScript from dist
console.log('\n2. Copying compiled JavaScript...');
if (fs.existsSync(path.join(ROOT, 'dist'))) {
  copyDir(path.join(ROOT, 'dist'), DIST, { excludeDirs: [], excludeExt: [] });
}

// Copy node_modules
console.log('\n3. Copying node_modules (production only)...');
copyDirSelective(
  path.join(ROOT, 'node_modules'),
  path.join(DIST, 'node_modules'),
  EXCLUDE_DIRS,
  EXCLUDE_EXT
);

// Copy scripts
console.log('\n4. Copying scripts...');
copyDirSelective(
  path.join(ROOT, 'scripts'),
  path.join(DIST, 'scripts'),
  [],
  ['.ts']
);

// Copy skills
console.log('\n5. Copying skills...');
if (fs.existsSync(path.join(ROOT, 'skills'))) {
  copyDirSelective(
    path.join(ROOT, 'skills'),
    path.join(DIST, 'skills'),
    [],
    []
  );
}

// Copy config files
console.log('\n6. Copying config files...');
for (const file of INCLUDE_FILES) {
  const src = path.join(ROOT, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, file));
    console.log(`  Copy: ${file}`);
  }
}

// Copy compiled JavaScript from dist/ to root (flat structure)
console.log('\n6b. Copying compiled JavaScript...');
const distSrc = path.join(ROOT, 'dist');
if (fs.existsSync(distSrc)) {
  copyDirRecursive(distSrc, DIST);
}

// Update package.json for distribution (flat structure, minimal scripts)
console.log('\n6c. Updating package.json for distribution...');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const distPkg = {
  name: pkgJson.name,
  version: pkgJson.version,
  description: pkgJson.description,
  main: 'index.js',
  scripts: {
    start: 'node index.js',
    postinstall: 'node scripts/rebuild-native.js'
  },
  dependencies: pkgJson.dependencies,
  license: pkgJson.license
};
fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify(distPkg, null, 2));

// Create data directories
console.log('\n7. Creating data directories...');
fs.mkdirSync(path.join(DATA_DIR, 'screenshots', 'patrol'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'screenshots', 'checkpoints'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'screenshots', 'vlm'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'attachments'), { recursive: true });

// Create .env from example if exists, otherwise create template
const envExample = path.join(ROOT, '.env.example');
const envTemplate = path.join(ROOT, '.env');

if (fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, path.join(DIST, '.env.example'));
} else if (fs.existsSync(envTemplate)) {
  fs.copyFileSync(envTemplate, path.join(DIST, '.env.example'));
}

// Create .env from template if it doesn't exist in dist
if (!fs.existsSync(path.join(DIST, '.env'))) {
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, path.join(DIST, '.env'));
  }
}

// Create README for distribution
const readmeContent = `# Reynard - WeChat Monitor

## Quick Start

1. Copy this folder to the target computer
2. Install dependencies (if needed):
   \`\`\`
   npm install
   \`\`\`
   This will rebuild native modules for your system.

3. Configure:
   - Copy \`.env.example\` to \`.env\` and edit settings
   - Required: VISION_API_KEY, VISION_PROVIDER

4. Run:
   \`\`\`
   npm run start
   \`\`\`

## Requirements

- Windows 10/11
- Node.js 18+ (LTS recommended)
- WeChat for Windows (desktop version)

## Features

- Screenshot-based message capture (non-invasive)
- VLM OCR for message recognition
- SQLite database for message storage
- Web UI for viewing messages
- Webhook support for notifications

## Troubleshooting

If native modules fail:
\`\`\`
npm run postinstall
\`\`\`

Or rebuild manually:
\`\`\`
node scripts/rebuild-native.js
\`\`\`
`;

fs.writeFileSync(path.join(DIST, 'README.md'), readmeContent);

console.log('\n=== Distribution package created! ===');
console.log(`Location: ${DIST}`);
console.log('\nTo run:');
console.log('  cd dist-package');
console.log('  npm start');
