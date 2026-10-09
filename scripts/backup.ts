import { resolve } from 'node:path';
import { backupDatabase, restoreDatabase } from '../apps/server/src/backup.js';
import { repositoryDirectory } from '../apps/server/src/runtime.js';
const [command,source,destination]=process.argv.slice(2);
if(command==='backup'&&source&&!destination){const file=await backupDatabase(resolve(process.env.LOOMRAIL_DATA_DIR??resolve(repositoryDirectory,'data'),'loomrail.sqlite'),source);console.log(`Verified backup saved: ${file}`);}
else if(command==='restore'&&source&&destination){const file=await restoreDatabase(source,destination);console.log(`Verified database restored to a separate directory: ${file}`);}
else throw new Error('Usage: npm run backup -- /absolute/path/new-backup.sqlite OR npm run restore -- /absolute/path/backup.sqlite /absolute/path/new-data-directory');
