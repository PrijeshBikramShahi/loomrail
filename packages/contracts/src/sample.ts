import { workflowGraphSchema } from './graph.js';

export const sampleCatalogueGraph = workflowGraphSchema.parse({
  schemaVersion: 1,
  nodes: [
    { id: 'start', name: 'Select supplier record', type: 'manual_trigger', config: {} },
    { id: 'prepare', name: 'Prepare listing fields', type: 'mapping', config: { fields: {
      sku: { source: 'input', path: ['sku'] }, title: { source: 'input', path: ['name'] }, price: { source: 'input', path: ['price'] },
    } } },
    { id: 'check_price', name: 'Price is positive', type: 'condition', config: {
      operator: 'greater_than', left: { source: 'step', nodeId: 'prepare', path: ['price'] }, right: { source: 'literal', value: 0 },
    } },
    { id: 'ready', name: 'Ready for drafting', type: 'output', config: { fields: {
      status: { source: 'literal', value: 'ready_for_drafting' }, listing: { source: 'step', nodeId: 'prepare', path: [] },
    } } },
    { id: 'review', name: 'Needs price review', type: 'output', config: { fields: {
      status: { source: 'literal', value: 'needs_price_review' }, sku: { source: 'step', nodeId: 'prepare', path: ['sku'] },
    } } },
  ],
  edges: [
    { id: 'start_prepare', source: 'start', target: 'prepare', port: 'next' },
    { id: 'prepare_check', source: 'prepare', target: 'check_price', port: 'next' },
    { id: 'check_ready', source: 'check_price', target: 'ready', port: 'true' },
    { id: 'check_review', source: 'check_price', target: 'review', port: 'false' },
  ],
});
export const sampleCatalogueInput = { sku: 'DEMO-001', name: 'Fictional canvas tote', price: 24 };
