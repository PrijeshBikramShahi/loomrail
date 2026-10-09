import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { applyMigrations } from './migrations.js';

const directory = process.env.LOOMRAIL_DATA_DIR;
if (directory !== undefined && directory.trim() === '') throw new Error('LOOMRAIL_DATA_DIR must not be empty.');
const dataDirectory = directory ? resolve(directory) : fileURLToPath(new URL('../../../../data', import.meta.url));
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const filename = resolve(dataDirectory, 'loomrail.sqlite');
const db = openDatabase(filename);
try {
  chmodSync(filename, 0o600);
  const installed = applyMigrations(db);
  console.log(installed.length ? `Applied migration(s): ${installed.join(', ')}` : 'Database is up to date.');
} finally {
  db.close();
}
