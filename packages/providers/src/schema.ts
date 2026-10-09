import { Ajv } from 'ajv';
import { LoomrailError, jsonObjectSchema, type JsonValue } from '@loomrail/contracts';

const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'description', 'anyOf', 'title']);
export function assertOutputSchema(schema: unknown): asserts schema is Record<string, JsonValue> {
  const parsed = jsonObjectSchema.safeParse(schema);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(schema)) > 30_000) throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Output schema must be a JSON object under 30 KB.', retryable: false });
  let count = 0;
  function inspect(value: unknown, depth: number) {
    if (++count > 1000 || depth > 12 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Schema complexity exceeded');
    for (const [key, item] of Object.entries(value)) {
      if (!keywords.has(key)) throw new Error('Unsupported schema keyword');
      if (key === 'properties') { if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid properties'); for (const child of Object.values(item)) inspect(child, depth + 1); }
      if (key === 'items' || (key === 'additionalProperties' && typeof item === 'object')) inspect(item, depth + 1);
      if (key === 'anyOf') { if (!Array.isArray(item)) throw new Error('Invalid anyOf'); for (const child of item) inspect(child, depth + 1); }
    }
  }
  try { inspect(schema, 0); new Ajv({ strict: true, allErrors: false, validateFormats: false }).compile(parsed.data); }
  catch { throw new LoomrailError({ code: 'INVALID_INPUT', message: 'Output schema is invalid or uses unsupported keywords. References and regular expressions are not supported.', retryable: false }); }
}
export function validateStructuredOutput(schema: unknown, output: unknown): void {
  assertOutputSchema(schema);
  const validate = new Ajv({ strict: true, allErrors: true, validateFormats: false }).compile(schema);
  if (!validate(output)) throw new LoomrailError({ code: 'INVALID_OUTPUT', message: 'Model output does not satisfy the configured JSON Schema.', retryable: false });
}
