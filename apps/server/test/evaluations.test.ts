import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EvaluationCase } from '@loomrail/contracts';
import { openDatabase } from '../src/db/database.js';
import { applyMigrations } from '../src/db/migrations.js';
import { RunStore } from '../src/store.js';
import { DataStore } from '../src/data.js';
import { AgentStore } from '../src/agents.js';
import { EvaluationStore, catalogueCases } from '../src/evaluations.js';
const stores: RunStore[] = [];
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const store of stores.splice(0))store.db.close();});
function setup(){const db=openDatabase(':memory:');applyMigrations(db);const store=new RunStore(db);stores.push(store);store.seedSample();const data=new DataStore(store);data.importSource({name:'Guide',text:'Listing guidelines require verified facts and source references.'});const starter=data.createCatalogue();return{store,data,version:starter.version,evaluations:new EvaluationStore(store)};}
describe('isolated saved evaluations',()=>{
  it('substitutes prompted-JSON OpenRouter agents with fixtures without accessing credentials or the network', async () => {
    const { store, version, evaluations } = setup(); const graph = structuredClone(version.graph); const node = graph.nodes.find(node => node.type === 'agent')!;
    const agents = new AgentStore(store); const original = agents.get(node.config.agentVersionId);
    node.config.agentVersionId = agents.publish({ ...original.definition, model: { provider: 'openrouter', model: 'poolside/laguna-s-2.1:free', mode: 'remote' }, outputMode: 'prompt_json' }).id;
    const workflow = store.workflow(version.workflowId); const draft = store.saveDraft(workflow.id, { schemaVersion: 1, name: workflow.name, layout: {}, revision: workflow.revision, graph }); const candidate = store.publish(workflow.id, { revision: draft.revision }).version;
    const fetcher = vi.fn(() => { throw new Error('No live inference in evaluations'); }); vi.stubGlobal('fetch', fetcher); vi.stubEnv('OPENROUTER_API_KEY', 'never-use-this'); vi.stubEnv('LOOMRAIL_REMOTE_ENABLED', 'true');
    expect((await evaluations.execute(candidate.id, catalogueCases()[0]!)).passed).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });
  it('passes at least twenty representative and adversarial catalogue cases with no network or live record writes',async()=>{
    const {store,data,version,evaluations}=setup();data.importCsv({csv:'sku,name,price\nEVAL-001,Live record,999'});const fetcher=vi.fn(()=>{throw new Error('Network forbidden in evaluations');});vi.stubGlobal('fetch',fetcher);vi.stubEnv('OPENAI_API_KEY','must-not-be-used');vi.stubEnv('LOOMRAIL_REMOTE_ENABLED','true');
    const cases=catalogueCases().map(item=>evaluations.saveCase(item));expect(cases.length).toBeGreaterThanOrEqual(20);
    const result=await evaluations.run({candidateVersionId:version.id,caseIds:cases.map(item=>item.id)});
    expect(result.results.filter(item=>!item.candidate.passed).map(item=>({name:item.snapshot.name,assertions:item.candidate.assertions,run:item.candidate.run}))).toEqual([]);expect(result.passed).toBe(true);expect(fetcher).not.toHaveBeenCalled();expect(data.record('EVAL-001').data.name).toBe('Live record');expect(store.list()).toEqual([]);expect(evaluations.list()).toHaveLength(1);
  });
  it('detects intentional prompt and mapping regressions against the exact current version',async()=>{
    const{store,version,evaluations}=setup();const graph=structuredClone(version.graph);const node=graph.nodes.find(node=>node.type==='agent')!;const original=new AgentStore(store).get(node.config.agentVersionId);const changed=new AgentStore(store).publish({...original.definition,instructions:'Invent specifications.'},original.agentId);node.config.agentVersionId=changed.id;
    const fields=graph.nodes.find(node=>node.id==='changes');if(fields?.type==='mapping')fields.config.fields.title={source:'literal',value:'Broken mapping'};
    const draft=store.workflow(version.workflowId);const saved=store.saveDraft(draft.id,{schemaVersion:1,name:draft.name,layout:draft.layout,revision:draft.revision,graph});const candidate=store.publish(draft.id,{revision:saved.revision}).version;
    const test=evaluations.saveCase(catalogueCases()[0]);const report=await evaluations.run({candidateVersionId:candidate.id,currentVersionId:version.id,caseIds:[test.id]});
    expect(report.results[0]!.regression).toBe(true);expect(report.results[0]!.current!.passed).toBe(true);expect(report.results[0]!.candidate.assertions.filter(item=>!item.passed).map(item=>item.assertion.kind)).toEqual(['result_equals','instructions_include']);expect(report.candidateVersionId).toBe(candidate.id);
  });
  it('asserts conditional branch choice and skipped paths',async()=>{
    const{evaluations}=setup();for(const [price,ready,review] of [[24,'succeeded','skipped'],[0,'skipped','succeeded']] as const){const definition:EvaluationCase={schemaVersion:1,name:`Price ${price}`,input:{sku:'TEST',name:'Test',price},records:[],fixtureModel:'echo-v1',approval:'pause',assertions:[{kind:'status',value:'succeeded'},{kind:'step_status',nodeId:'ready',value:ready},{kind:'step_status',nodeId:'review',value:review},{kind:'no_actions'}]};expect((await evaluations.execute('catalogue-v1',definition)).passed).toBe(true);}
  });
});
