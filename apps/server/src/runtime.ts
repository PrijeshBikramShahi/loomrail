import { AgentStore } from './agents.js';
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db/database.js';
import { applyMigrations } from './db/migrations.js';
import { RunStore } from './store.js';

export const repositoryDirectory = fileURLToPath(new URL('../../../', import.meta.url));
export function secretPath() { return resolve(process.env.LOOMRAIL_OPERATOR_SECRET_FILE ?? resolve(homedir(), '.config/loomrail/operator.key')); }
function assertOutsideRepository(filename: string) {
  const relativePath = relative(realpathSync(repositoryDirectory), filename);
  if (relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) throw new Error('The operator secret must be stored outside the repository.');
}
export function initializeOperatorSecret() {
  const filename = secretPath(); assertOutsideRepository(filename);
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  assertOutsideRepository(resolve(realpathSync(dirname(filename)), basename(filename)));
  if (!existsSync(filename)) writeFileSync(filename, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  loadOperatorSecret();
  return filename;
}
export function loadOperatorSecret() {
  const filename = secretPath();
  if (!existsSync(filename)) throw new Error('Operator secret missing. Run npm run operator:init first.');
  assertOutsideRepository(realpathSync(filename));
  if (process.platform !== 'win32' && (statSync(filename).mode & 0o077) !== 0) throw new Error('Operator secret permissions must be 0600 or stricter.');
  const secret = readFileSync(filename, 'utf8').trim();
  if (secret.length < 32 || secret.length > 256) throw new Error('Operator secret must contain 32–256 characters.');
  return secret;
}
export function openStore() {
  if (process.env.LOOMRAIL_DATA_DIR?.trim() === '') throw new Error('LOOMRAIL_DATA_DIR must not be empty.');
  const directory = resolve(process.env.LOOMRAIL_DATA_DIR ?? resolve(repositoryDirectory, 'data'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = resolve(directory, 'loomrail.sqlite');
  const db = openDatabase(filename);
  try {
    chmodSync(filename, 0o600); applyMigrations(db);
    const store = new RunStore(db); store.seedSample(); new AgentStore(store).seed(); return store;
  } catch (error) { db.close(); throw error; }
}
