import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { applyMigrations } from './db/migrations.js';

function verify(db: DatabaseSync) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database integrity verification failed.');
}
export async function backupDatabase(source: string, destination: string) {
  const target = resolve(destination); if (existsSync(target)) throw new Error('Backup destination already exists; choose a new filename.');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(target), '.loomrail-backup-')); const filename = join(temporary,'snapshot.sqlite');
  const db = new DatabaseSync(resolve(source), { readOnly: true });
  try {
    await backup(db,filename); chmodSync(filename,0o600);
    const snapshot = new DatabaseSync(filename);
    try { verify(snapshot); applyMigrations(snapshot); snapshot.exec('DELETE FROM sessions; DELETE FROM worker_lease;'); verify(snapshot); } finally { snapshot.close(); }
    // Exclusive publication: never replace an existing backup, even in a race.
    linkSync(filename,target); unlinkSync(filename); return target;
  } finally { db.close(); rmSync(temporary,{recursive:true,force:true}); }
}
export async function restoreDatabase(source: string, directory: string) {
  const target = resolve(directory);
  if (existsSync(target) && readdirSync(target).length) throw new Error('Restore requires a new or empty data directory. Existing data is never replaced.');
  mkdirSync(target,{recursive:true,mode:0o700}); const filename=join(target,'loomrail.sqlite');
  await backupDatabase(source,filename); return filename;
}
