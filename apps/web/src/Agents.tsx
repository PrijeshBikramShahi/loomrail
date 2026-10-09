import { useEffect, useState } from 'react';
import { defaultAgent, agentDefinitionSchema, openRouterModels, type AgentVersion, type AgentDefinition, type Run } from '@loomrail/contracts';
import { request } from './api.js';

export function Agents({ csrf, onRun }: { csrf: string; onRun: (run: Run) => void }) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [selected, setSelected] = useState('');
  const [definition, setDefinition] = useState<AgentDefinition>(structuredClone(defaultAgent));
  const [schema, setSchema] = useState(JSON.stringify(defaultAgent.outputSchema, null, 2));
  const [knowledge, setKnowledge] = useState('');
  const [input, setInput] = useState('{"sku":"DEMO-001","name":"Fictional canvas tote","price":24}');
  const [providers, setProviders] = useState<unknown[]>([]);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => setVersions(await request('/agents') as AgentVersion[]);
  useEffect(() => { void load().catch(error => setError(String(error))); void request('/settings/providers').then(value => setProviders(value as unknown[])).catch(error => setError(String(error))); }, []);
  function choose(id: string) { setSelected(id); const item = versions.find(item => item.id === id); const next = item?.definition ?? structuredClone(defaultAgent); setDefinition(next); setSchema(JSON.stringify(next.outputSchema, null, 2)); setKnowledge(next.knowledgeVersionIds.join(', ')); setMessage(''); }
  async function publish() {
    setBusy(true); setError('');
    try {
      const parsed = agentDefinitionSchema.parse({ ...definition, outputSchema: JSON.parse(schema), knowledgeVersionIds: knowledge.split(',').map(item => item.trim()).filter(Boolean) });
      const agent = versions.find(item => item.id === selected);
      const saved = await request(agent ? `/agents/${agent.agentId}/versions` : '/agents', 'POST', parsed, csrf) as AgentVersion;
      await load(); setSelected(saved.id); setMessage(`Published immutable agent v${saved.version}. Select it in your workflow to use it.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not publish agent.'); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError('');
    try { onRun(await request(`/agents/${selected}/test`, 'POST', JSON.parse(input), csrf) as Run); setMessage('Test queued. Inspect its model and tool history in Runs below.'); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not start test.'); } finally { setBusy(false); }
  }
  return <section className="management-panel" aria-label="Agents and providers"><h2>Agents</h2><p>Publish instructions, model settings, read-only tools, and an output contract as one immutable version.</p>
    {error && <p className="error-message" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <label>Agent version<select value={selected} onChange={event => choose(event.target.value)}><option value="">New agent</option>{versions.map(item => <option key={item.id} value={item.id}>{item.definition.name} · v{item.version} · {item.definition.model.mode}</option>)}</select></label>
    <div className="result-grid"><div><label>Agent name<input value={definition.name} onChange={event => setDefinition({ ...definition, name: event.target.value })}/></label><label>Instructions<textarea rows={6} value={definition.instructions} onChange={event => setDefinition({ ...definition, instructions: event.target.value })}/></label>
      <label>Provider<select value={definition.model.provider} onChange={event => setDefinition({ ...definition, outputMode: 'native_schema', model: { provider: event.target.value, mode: event.target.value === 'fixture' ? 'fixture' : event.target.value === 'ollama' ? 'local' : 'remote', model: event.target.value === 'fixture' ? 'tool-demo-v1' : event.target.value === 'openrouter' ? 'nvidia/nemotron-3-super-120b-a12b:free' : '' } })}><option value="fixture">Fixture · deterministic, no inference</option><option value="ollama">Ollama · local inference</option><option value="openai">OpenAI · remote, operator opt-in</option><option value="openrouter">OpenRouter · selected free models</option></select></label>
      {definition.model.provider === 'openrouter' && <><label>Free OpenRouter model<select value={definition.model.model} onChange={event => { const selectedModel = openRouterModels.find(model => model.id === event.target.value)!; setDefinition({ ...definition, model: { ...definition.model, model: selectedModel.id }, outputMode: selectedModel.outputMode }); }}>{openRouterModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label><p>{definition.outputMode === 'prompt_json' ? 'JSON is requested in the prompt and validated by Loomrail; native schema enforcement is unavailable.' : 'JSON Schema output is required from the provider and validated again by Loomrail.'} Only the selected free model is used. Free-provider data policies apply; use fictional data for testing.</p></>}
      <label>Model identifier<input value={definition.model.model} onChange={event => setDefinition({ ...definition, model: { ...definition.model, model: event.target.value } })}/></label>
      <fieldset><legend>Read-only tools</legend>{(['record_lookup', 'guideline_search'] as const).map(tool => <label key={tool}><input type="checkbox" checked={definition.tools.includes(tool)} onChange={event => setDefinition({ ...definition, tools: event.target.checked ? [...definition.tools, tool] : definition.tools.filter(item => item !== tool) })}/>{tool.replaceAll('_', ' ')}</label>)}</fieldset>
      <label>Pinned knowledge version IDs (comma separated)<input value={knowledge} onChange={event => setKnowledge(event.target.value)}/></label>
    </div><div><label>Output JSON Schema<textarea rows={13} value={schema} spellCheck={false} onChange={event => setSchema(event.target.value)}/></label>
      <div className="form-actions">{Object.entries(definition.limits).map(([key, value]) => <label key={key}>{key}<input type="number" value={value} onChange={event => setDefinition({ ...definition, limits: { ...definition.limits, [key]: Number(event.target.value) } })}/></label>)}</div>
      <label>Output token allowance<input type="number" value={definition.settings.maxOutputTokens} onChange={event => setDefinition({ ...definition, settings: { ...definition.settings, maxOutputTokens: Number(event.target.value) } })}/></label>
      <label>Temperature<input type="number" step="0.1" min="0" max="2" value={definition.settings.temperature} onChange={event => setDefinition({ ...definition, settings: { ...definition.settings, temperature: Number(event.target.value) } })}/></label>
    </div></div><button disabled={busy} onClick={() => { void publish(); }}>Publish agent version</button>
    {selected && <details><summary>Test published version / provider connection</summary><p>Uses the saved version, including its tools and limits. Remote tests may make billable requests using the operator’s configured credentials. No provider fallback is performed.</p><label>Agent test input (JSON)<textarea value={input} onChange={event => setInput(event.target.value)}/></label><button disabled={busy} onClick={() => { void test(); }}>Run published agent test</button></details>}
    <details><summary>Provider settings and capabilities</summary><p>Secrets and endpoint configuration stay on the server. Cost is unknown unless reported reliably; fixture success does not establish model quality.</p><pre>{JSON.stringify(providers, null, 2)}</pre></details>
  </section>;
}
