import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rendererDir = path.resolve(__dirname, '../../renderer');
const electronDir = __dirname;

const vite = spawn('pnpm', ['run', 'dev'], { cwd: rendererDir, shell: true, stdio: 'inherit' });

setTimeout(() => {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch {
    electronPath = 'electron';
  }

  const electron = spawn(electronPath, [path.join(electronDir, '../dist/main.js')], {
    cwd: electronDir,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: 'inherit'
  });

  electron.on('close', () => {
    vite.kill();
    process.exit();
  });

  process.on('SIGINT', () => {
    electron.kill();
    vite.kill();
    process.exit();
  });
}, 5000);
