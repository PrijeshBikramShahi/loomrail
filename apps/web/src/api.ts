export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request(path: string, method = 'GET', body?: unknown, csrf?: string): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result: unknown;
  try { result = await response.json(); } catch { throw new ApiError('The API is unavailable. Start the Loomrail server and try again.', response.status); }
  if (!response.ok) throw new ApiError((result as { error?: string }).error ?? 'Request failed.', response.status);
  return result;
}
