import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';
import { backupDatabase, restoreDatabase } from '../src/backup.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('backs up a live WAL database, restores into a separate directory, clears sessions, and resumes queued work',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'loomrail-backup-'));dirs.push(directory);const filename=join(directory,'loomrail.sqlite');const db=openDatabase(filename);applyMigrations(db);const store=new RunStore(db);store.seedSample();const run=store.create({workflowVersionId:'catalogue-v1',requestId:randomUUID(),input:{sku:'TEST',name:'Fictional',price:24}});db.prepare('INSERT INTO sessions VALUES (?,?)').run('not-a-real-session',Date.now()+10000);store.claim('old');store.advance(run.id,'old');
 const path=join(directory,'backup.sqlite');execFileSync(process.execPath,['--import','tsx','scripts/backup.ts','backup',path],{env:{...process.env,LOOMRAIL_DATA_DIR:directory},timeout:10000});expect(store.steps(run.id).filter(step=>step.status==='succeeded')).toHaveLength(1);db.close();
 execFileSync(process.execPath,['--import','tsx','scripts/backup.ts','restore',path,join(directory,'restored')],{timeout:10000});const restored=join(directory,'restored','loomrail.sqlite');const restoredDb=openDatabase(restored);const resumed=new RunStore(restoredDb);
 try{expect(restoredDb.prepare('SELECT count(*) AS count FROM sessions').get()!.count).toBe(0);expect(resumed.claim('new')).toBe(run.id);while(resumed.advance(run.id,'new')){/* resume */}expect(resumed.get(run.id).status).toBe('succeeded');expect(resumed.events(run.id).filter(event=>event.type==='step_succeeded'&&event.nodeId==='start')).toHaveLength(1);}finally{restoredDb.close();}
 await expect(restoreDatabase(path,join(directory,'restored'))).rejects.toThrow('never replaced');await expect(backupDatabase(path,path)).rejects.toThrow('already exists');
});
