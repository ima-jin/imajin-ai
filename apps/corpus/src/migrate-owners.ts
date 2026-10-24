import { migrateCorpusOwner } from './lib/owner-migration';

/** Run on the corpus host with its normal vault bootstrap configuration, with the daemon stopped. */
console.log(JSON.stringify(await migrateCorpusOwner(process.argv.slice(2))));
