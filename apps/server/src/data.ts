import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { csvImportSchema, knowledgeImportSchema, knowledgeSearchSchema, defaultAgent, type JsonValue, type WorkflowGraph } from '@loomrail/contracts';
import { StoreError, type RunStore } from './store.js';
import { AgentStore, searchKnowledge } from './agents.js';

export class DataStore {
  constructor(readonly store: RunStore) {}
  records() { return this.store.db.prepare('SELECT * FROM records ORDER BY sku LIMIT 1000').all().map(row => ({ sku: String(row.sku), revision: Number(row.revision), data: JSON.parse(String(row.data_json)) as Record<string, JsonValue> })); }
  record(sku: string) {
    const row = this.store.db.prepare('SELECT * FROM records WHERE sku=?').get(sku);
    if (!row) throw new StoreError(404, 'Record not found.');
    return { sku: String(row.sku), revision: Number(row.revision), data: JSON.parse(String(row.data_json)) as Record<string, JsonValue>, reviews: this.store.db.prepare("SELECT data_json FROM approvals WHERE json_extract(data_json,'$.payload.sku')=? ORDER BY rowid DESC").all(sku).map(row => JSON.parse(String(row.data_json))) };
  }
  parseCsv(value: unknown): Record<string, JsonValue>[] {
    const { csv } = csvImportSchema.parse(value);
    if (Buffer.byteLength(csv) > 250000) throw new StoreError(413, 'CSV import exceeds 250 KB.');
    let rows: string[][];
    try { rows = parse(csv, { bom: true, skip_empty_lines: true, trim: true, max_record_size: 20000, relax_column_count: false }) as string[][]; }
    catch { throw new StoreError(400, 'Malformed CSV. Check quoting, consistent columns, and row size.'); }
    const headers = rows.shift();
    if (!headers || headers.length > 20 || new Set(headers).size !== headers.length || headers.some(key => !/^[a-z][a-z0-9_]{0,59}$/.test(key) || /password|secret|authorization|cookie|token|api_?key|__proto__|constructor|prototype/i.test(key)) || !['sku','name','price'].every(key => headers.includes(key))) throw new StoreError(400, 'Use unique safe headers including sku, name, and price. Credential fields are not accepted.');
    if (!rows.length || rows.length > 500) throw new StoreError(400, 'Import between 1 and 500 records at a time.');
    const skus = new Set<string>();
    return rows.map((row, index) => {
      const data: Record<string, JsonValue> = Object.fromEntries(headers.map((key, i) => [key, row[i] ?? '']));
      if (typeof data.sku !== 'string' || !/^[\w.-]{1,120}$/.test(data.sku) || !data.name || String(data.name).length > 240 || skus.has(data.sku)) throw new StoreError(400, `Row ${index + 2}: unique SKU and nonempty name are required.`);
      skus.add(data.sku);
      if (data.price === '') data.price = null;
      else if (typeof data.price === 'string' && /^\d+(\.\d{1,2})?$/.test(data.price) && Number.isFinite(Number(data.price)) && Number(data.price) <= 1_000_000_000) data.price = Number(data.price);
      else throw new StoreError(400, `Row ${index + 2}: price must be blank or a nonnegative decimal with at most two fraction digits.`);
      return data;
    });
  }
  importCsv(value: unknown) {
    const records = this.parseCsv(value);
    return this.store.transaction(() => {
      for (const record of records) if (this.store.db.prepare('SELECT sku FROM records WHERE sku=?').get(String(record.sku))) throw new StoreError(409, `SKU ${String(record.sku)} already exists. Import creates records; reviewed workflow actions update them.`);
      for (const record of records) this.store.db.prepare('INSERT INTO records VALUES (?,1,?)').run(String(record.sku), JSON.stringify(record));
      return { imported: records.length, records };
    });
  }
  sources() { return this.store.db.prepare('SELECT id,source_id AS sourceId,version,name,content_hash AS contentHash,created_at AS createdAt FROM knowledge_versions ORDER BY rowid DESC').all(); }
  source(id: string) {
    const source = this.store.db.prepare('SELECT id,source_id AS sourceId,version,name,content_hash AS contentHash,text,created_at AS createdAt FROM knowledge_versions WHERE id=?').get(id);
    if (!source) throw new StoreError(404, 'Knowledge version not found.');
    return { id: String(source.id), sourceId: String(source.sourceId), version: Number(source.version), name: String(source.name), contentHash: String(source.contentHash), text: String(source.text), createdAt: String(source.createdAt), chunks: this.store.db.prepare('SELECT id,ordinal,text FROM knowledge_chunks WHERE version_id=? ORDER BY ordinal').all(id), indexing: 'ready', retrieval: 'lexical' };
  }
  importSource(value: unknown) {
    const source = knowledgeImportSchema.parse(value);
    if (Buffer.byteLength(source.text) > 100000) throw new StoreError(413, 'Source exceeds 100 KB.');
    return this.store.transaction(() => {
      if (source.sourceId && !this.store.db.prepare('SELECT id FROM knowledge_versions WHERE source_id=?').get(source.sourceId)) throw new StoreError(404, 'Source identity not found.');
      const sourceId = source.sourceId ?? randomUUID(); const id = randomUUID();
      const version = Number(this.store.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM knowledge_versions WHERE source_id=?').get(sourceId)!.next);
      this.store.db.prepare('INSERT INTO knowledge_versions VALUES (?,?,?,?,?,?,?)').run(id, sourceId, version, source.name, createHash('sha256').update(source.text).digest('hex'), source.text, new Date(this.store.now()).toISOString());
      // Exact character windows are stable source locations; no network, embeddings, or model required.
      for (let offset = 0, ordinal = 0; offset < source.text.length; offset += 1000, ordinal++) this.store.db.prepare('INSERT INTO knowledge_chunks VALUES (?,?,?,?)').run(`${id}_${ordinal}`, id, ordinal, source.text.slice(offset, offset + 1000));
      return this.source(id);
    });
  }
  search(value: unknown) { const input = knowledgeSearchSchema.parse(value); for (const id of input.versionIds) this.source(id); return { retrieval: 'lexical', sources: searchKnowledge(this.store, input.versionIds, input.query) }; }
  createCatalogue() {
    const versions = this.sources();
    const latest = new Map<string, string>(); for (const source of versions) if (!latest.has(String(source.sourceId))) latest.set(String(source.sourceId), String(source.id));
    if (latest.size > 20) throw new StoreError(400, 'The starter supports at most 20 sources. Choose sources explicitly in an agent.');
    const agent = new AgentStore(this.store).publish({ ...defaultAgent, knowledgeVersionIds: [...latest.values()] });
    const graph: WorkflowGraph = { schemaVersion: 1, nodes: [
      { id: 'start', name: 'Selected record', type: 'manual_trigger', config: {} },
      { id: 'draft', name: 'Draft with guidelines', type: 'agent', config: { agentVersionId: agent.id, input: { source: 'input', path: ['record'] } } },
      { id: 'proposal', name: 'Propose listing fields', type: 'mapping', config: { fields: { sku: { source: 'input', path: ['record','sku'] }, expectedRevision: { source: 'input', path: ['revision'] }, changes: { source: 'step', nodeId: 'draft', path: [] } } } },
      { id: 'review', name: 'Review and apply', type: 'record_update', config: { proposal: { source: 'step', nodeId: 'proposal', path: [] } } },
      { id: 'output', name: 'Approved listing artifact', type: 'output', config: { fields: { result: { source: 'step', nodeId: 'review', path: [] } } } },
    ], edges: ['start','draft','proposal','review'].map((source, index) => ({ id: `edge${index}`, source, target: ['draft','proposal','review','output'][index]!, port: 'next' })) };
    // SKU is part of the model output contract but immutable record identity is outside changes.
    const mapping = graph.nodes.find(node => node.type === 'mapping')!;
    const changes = { id: 'changes', name: 'Select editable fields', type: 'mapping' as const, config: { fields: Object.fromEntries(['title','description','price','sourceReferences','flags'].map(key => [key, { source: 'step' as const, nodeId: 'draft', path: [key] }])) } };
    graph.nodes.splice(2,0,changes); graph.edges.find(edge => edge.source === 'draft')!.target = 'changes'; graph.edges.push({ id: 'editable', source: 'changes', target: 'proposal', port: 'next' }); mapping.config.fields.changes = { source: 'step', nodeId: 'changes', path: [] };
    const workflow = this.store.createWorkflow({ name: 'Catalogue · draft, review, apply' });
    const saved = this.store.saveDraft(workflow.id, { schemaVersion: 1, name: workflow.name, revision: 0, layout: {}, graph });
    return this.store.publish(workflow.id, { revision: saved.revision });
  }
}
