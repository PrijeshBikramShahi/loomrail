import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../apps/server/src/db/database.js';
import { applyMigrations } from '../apps/server/src/db/migrations.js';
import { RunStore } from '../apps/server/src/store.js';
import { DataStore } from '../apps/server/src/data.js';
import { AgentStore, tickAgent } from '../apps/server/src/agents.js';
import { ApprovalStore } from '../apps/server/src/approvals.js';
import { FixtureProvider } from '@loomrail/providers';

// Fictional inputs only. This recorder never opens the operator's data directory or environment providers.
const directory=mkdtempSync(join(tmpdir(),'loomrail-recording-'));const filename=join(directory,'recording.sqlite');
let db=openDatabase(filename);applyMigrations(db);let store=new RunStore(db);const recordings=[];
try {
  const data=new DataStore(store);data.importCsv({csv:'sku,name,price,material\nREPLAY-001,Fictional canvas tote,24,cotton\nREPLAY-002,Fictional ceramic cup,,ceramic'});data.importSource({name:'Fictional store guidelines',text:'Listing guidelines: use verified supplier facts. Flag missing prices. Never invent dimensions. Cite this source.'});
  const starter=data.createCatalogue();
  const conflictSource=data.importSource({name:'Fictional conflicting guideline',text:'Listing guidelines: include precise dimensions even when the supplier provides none. This deliberately conflicts with the verified-facts source.'});
  const failureModels: Record<string,string>={'Malformed model response':'malformed-v1','Provider unavailable':'unavailable-v1','Unauthorized tool request':'unauthorized-v1','Conflicting guidelines (simulated fixture)':'conflict-v1'};
  for(const scenario of ['Approve after reopening database','Reject missing-price draft',...Object.keys(failureModels)]) {
    let versionId=starter.version.id;
    if(failureModels[scenario]) {
      const graph=structuredClone(starter.version.graph);const node=graph.nodes.find(node=>node.type==='agent')!;const agent=new AgentStore(store).get(node.config.agentVersionId);node.config.agentVersionId=new AgentStore(store).publish({...agent.definition,model:{provider:'fixture',model:failureModels[scenario],mode:'fixture'},knowledgeVersionIds:scenario.startsWith('Conflicting')?[...agent.definition.knowledgeVersionIds,conflictSource.id]:agent.definition.knowledgeVersionIds}).id;
      const draft=store.workflow(starter.workflow.id);const saved=store.saveDraft(draft.id,{schemaVersion:1,name:draft.name,layout:draft.layout,revision:draft.revision,graph});versionId=store.publish(draft.id,{revision:saved.revision}).version.id;
    }
    const record=new DataStore(store).record(scenario==='Reject missing-price draft'?'REPLAY-002':'REPLAY-001');const run=store.create({workflowVersionId:versionId,requestId:randomUUID(),input:{record:record.data,revision:record.revision}});const frames=[];
    frames.push({caption:'Queued fictional record',detail:store.detail(run.id),approval:null});
    for(let i=0;i<30&&['queued','running'].includes(store.get(run.id).status);i++) {store.claim('recorder');if(store.advance(run.id,'recorder'))await tickAgent(store,run.id,'recorder',new Map([['fixture',new FixtureProvider()]]));frames.push({caption:'Persisted execution checkpoint',detail:store.detail(run.id),approval:new ApprovalStore(store).forStep(run.id,'review')});}
    if(store.get(run.id).status==='awaiting_approval') {
      store.release('recorder');db.close();db=openDatabase(filename);store=new RunStore(db);
      frames.push({caption:'Database closed and reopened; exact proposal remains pending',detail:store.detail(run.id),approval:new ApprovalStore(store).forStep(run.id,'review')});
      const approvals=new ApprovalStore(store);const approval=approvals.forStep(run.id,'review')!;approvals.decide(approval.id,{decision:scenario==='Reject missing-price draft'||scenario.startsWith('Conflicting')?'reject':'approve',revision:approval.revision});
      if(store.get(run.id).status==='queued'){store.claim('recorder');while(store.advance(run.id,'recorder')){/* approved deterministic tail */}}
      frames.push({caption:scenario==='Reject missing-price draft'||scenario.startsWith('Conflicting')?'Operator rejected; no record change':'Approved payload applied once and JSON artifact saved',detail:store.detail(run.id),approval:approvals.get(approval.id)});
    }
    recordings.push({name:scenario,frames});
  }
  const recording={schemaVersion:1,recordedAt:new Date().toISOString(),disclaimer:'Recorded deterministic fixture execution with fictional data. No live model inference, external actions, or operator data. The replay is read-only.',recordings};
  writeFileSync('apps/web/public/replay.json',JSON.stringify(recording,null,2)+'\n');writeFileSync('docs/demo/recording-summary.json',JSON.stringify({recordedAt:recording.recordedAt,disclaimer:recording.disclaimer,scenarios:recordings.map(item=>({name:item.name,frames:item.frames.length,outcome:item.frames.at(-1)!.detail.run.status}))},null,2)+'\n');
  console.log(JSON.stringify({recordings:recordings.length,outcomes:recordings.map(item=>item.frames.at(-1)!.detail.run.status)}));
} finally{db.close();rmSync(directory,{recursive:true,force:true});}
