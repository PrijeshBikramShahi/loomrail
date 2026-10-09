import { tickExternal } from './external.js';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { openStore } from './runtime.js';
import { tickAgent, providersFromEnvironment } from './agents.js';
import { StoreError } from './store.js';

const store = openStore();
const token = randomUUID();
let stopping = false;
const shutdown = new AbortController();
const providers = providersFromEnvironment();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; shutdown.abort(); });
console.log('Loomrail sequential worker started.');
try {
  while (!stopping) {
    try {
      const id = store.claim(token);
      if (id && store.advance(id, token)) { await tickAgent(store, id, token, providers, shutdown.signal); await tickExternal(store, id, token, shutdown.signal); }
    } catch (error) {
      if (!(error instanceof StoreError && error.statusCode === 409)) throw error;
    }
    // Yield between committed steps so commands and shutdown can be handled promptly.
    await setTimeout(100);
  }
} finally { store.release(token); store.db.close(); }
