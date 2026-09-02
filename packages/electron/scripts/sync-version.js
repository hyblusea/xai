import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkgPath = resolve(__dirname, '../../../package.json');
const electronPkgPath = resolve(__dirname, '../package.json');

const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
const electronPkg = JSON.parse(readFileSync(electronPkgPath, 'utf-8'));

if (electronPkg.version !== rootPkg.version) {
  electronPkg.version = rootPkg.version;
  writeFileSync(electronPkgPath, JSON.stringify(electronPkg, null, 2));
  console.log(`Updated electron package version to ${rootPkg.version}`);
} else {
  console.log(`Version is already ${rootPkg.version}, no update needed`);
}