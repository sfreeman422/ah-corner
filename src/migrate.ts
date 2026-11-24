import {runMigrations} from './store.ts';

try{
 await runMigrations();
 console.log('AH Corner database migrations are current.');
}catch(error){
 console.error(`Migration failed: ${(error as Error).message}`);
 process.exitCode=1;
}
