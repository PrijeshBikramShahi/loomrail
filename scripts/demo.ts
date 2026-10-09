import { sampleCatalogueGraph, sampleCatalogueInput } from '@loomrail/contracts';
import { executeDeterministicGraph } from '@loomrail/engine';

console.log('Loomrail M0 deterministic demonstration. No AI inference or persisted run.');
for (const price of [24, 0]) {
  console.log(JSON.stringify(executeDeterministicGraph(sampleCatalogueGraph, { ...sampleCatalogueInput, price }), null, 2));
}
