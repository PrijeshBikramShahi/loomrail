import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

it('starts health checks without credentials, a database, or a model', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'loomrail', schemaVersion: 1 });
    expect((await app.inject({ method: 'POST', url: '/runs', payload: {} })).statusCode).toBe(404);
  } finally { await app.close(); }
});
