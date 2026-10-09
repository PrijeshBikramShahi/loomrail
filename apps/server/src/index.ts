import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadOperatorSecret, openStore } from './runtime.js';

const port = Number(process.env.LOOMRAIL_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LOOMRAIL_PORT must be an integer from 1 to 65535.');
const operatorSecret = loadOperatorSecret();
const store = openStore();
const app = buildApp({ store, operatorSecret, origin: process.env.LOOMRAIL_ORIGIN ?? 'http://127.0.0.1:5173', apiPort: port });
if (process.env.LOOMRAIL_SERVE_WEB === 'true') app.addHook('onSend', async (_request, reply) => { reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); });
if (process.env.LOOMRAIL_SERVE_WEB === 'true') await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web/dist/', import.meta.url)), dotfiles: 'deny', index: ['index.html'], wildcard: false });
app.addHook('onClose', async () => { store.db.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ host: '127.0.0.1', port });
console.log(`Loomrail API listening on http://127.0.0.1:${port}`);
