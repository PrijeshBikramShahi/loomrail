import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, type Node, type NodeProps, type Connection, type Edge } from '@xyflow/react';
import { connectionIssue, workflowDocumentSchema, workflowGraphSchema, type Binding, type RunDetail, type WorkflowDocument, type WorkflowNode, type AgentVersion } from '@loomrail/contracts';
import { request } from './api.js';
import '@xyflow/react/dist/style.css';

type CanvasNode = Node<{ node: WorkflowNode; status: string | undefined }, 'workflow'>;
function WorkflowCanvasNode({ data }: NodeProps<CanvasNode>) {
  const { node, status } = data;
  return <div className={`workflow-node ${status ? `node-${status}` : ''}`}>
    {node.type !== 'manual_trigger' && <Handle type="target" position={Position.Left} id="in"/>}
    <small>{node.type.replaceAll('_', ' ')}</small><strong>{node.name}</strong>{status && <span className={`status status-${status}`}>{status}</span>}
    {node.type !== 'output' && (node.type === 'condition' ? <><Handle type="source" position={Position.Right} id="true" style={{ top: '35%' }}/><span className="handle-label true-label">True</span><Handle type="source" position={Position.Right} id="false" style={{ top: '75%' }}/><span className="handle-label false-label">False</span></> : <Handle type="source" position={Position.Right} id="next"/>)}
  </div>;
}
const nodeTypes = { workflow: WorkflowCanvasNode };
const defaultBinding: Binding = { source: 'input', path: [] };

function BindingControl({ id, value, nodes, onChange, onValidity }: { id: string; value: Binding; nodes: WorkflowNode[]; onChange: (value: Binding) => void; onValidity: (id: string, valid: boolean) => void }) {
  const serialized = value.source === 'literal' ? JSON.stringify(value.value) : '';
  const [text, setText] = useState(serialized);
  useEffect(() => { setText(serialized); }, [serialized]);
  useEffect(() => () => { onValidity(id, true); }, [id, onValidity]);
  return <div className="binding-control"><label>{id} source<select value={value.source} onChange={event => { onValidity(id, true); onChange(event.target.value === 'literal' ? { source: 'literal', value: '' } : event.target.value === 'step' ? { source: 'step', nodeId: nodes[0]?.id ?? 'missing', path: [] } : defaultBinding); }}>
    <option value="input">Run input</option><option value="step">Upstream step</option><option value="literal">Literal JSON</option></select></label>
    {value.source === 'step' && <label>Upstream node<select value={value.nodeId} onChange={event => onChange({ ...value, nodeId: event.target.value })}>{nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>}
    {value.source !== 'literal' ? <label>Field path (dot separated)<input value={value.path.join('.')} placeholder="price (empty selects whole value)" onChange={event => onChange({ ...value, path: event.target.value ? event.target.value.split('.') : [] })}/></label> : <label>Literal value (JSON)<textarea aria-label="Literal value (JSON)" rows={2} value={text} onChange={event => { setText(event.target.value); try { const parsed: unknown = JSON.parse(event.target.value); onChange({ source: 'literal', value: parsed as Extract<Binding, { source: 'literal' }>['value'] }); onValidity(id, true); } catch { onValidity(id, false); } }}/></label>}
  </div>;
}

export function WorkflowEditor({ workflowId, csrf, detail, onPublished, onDirtyChange }: { workflowId: string; csrf: string; detail: RunDetail | null; onPublished: (versionId: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [agents, setAgents] = useState<AgentVersion[]>([]);
  useEffect(() => { void request('/agents').then(value => setAgents(value as AgentVersion[])); }, []);
  const [draft, setDraft] = useState<WorkflowDocument | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [fieldName, setFieldName] = useState('');
  const [connectSource, setConnectSource] = useState('');
  const [connectTarget, setConnectTarget] = useState('');
  const [connectPort, setConnectPort] = useState<'next' | 'true' | 'false'>('next');
  const validity = useCallback((id: string, valid: boolean) => setInvalid(previous => ({ ...previous, [id]: !valid })), []);
  const reload = useCallback(async () => {
    setBusy(true); setError('');
    try { setDraft(workflowDocumentSchema.parse(await request(`/workflows/${workflowId}`))); setDirty(false); setInvalid({}); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not load workflow.'); }
    finally { setBusy(false); }
  }, [workflowId]);
  useEffect(() => { if (draft?.id !== workflowId) void reload(); }, [reload, draft?.id, workflowId]);
  const edit = (next: WorkflowDocument) => { setDraft(next); setDirty(true); setMessage(''); };
  const updateNode = (node: WorkflowNode) => { if (draft) edit({ ...draft, graph: { ...draft.graph, nodes: draft.graph.nodes.map(item => item.id === node.id ? node : item) } }); };
  const node = draft?.graph.nodes.find(node => node.id === selected);
  const validation = useMemo(() => draft ? workflowGraphSchema.safeParse(draft.graph) : null, [draft]);
  const hasInvalidInput = Object.values(invalid).some(Boolean);
  const matchingRun = detail && draft && JSON.stringify(detail.graph) === JSON.stringify(draft.graph) ? detail : null;
  const nodes: CanvasNode[] = draft?.graph.nodes.map((node, index) => ({ id: node.id, type: 'workflow', position: draft.layout[node.id] ?? { x: (index < 3 ? index : 3) * 240, y: index === 4 ? 200 : 40 }, data: { node, status: matchingRun?.steps.find(step => step.nodeId === node.id)?.status }, selected: node.id === selected })) ?? [];
  const edges: Edge[] = draft?.graph.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.port, targetHandle: 'in', label: edge.port === 'next' ? undefined : edge.port, markerEnd: { type: MarkerType.ArrowClosed } })) ?? [];
  function connect(connection: Connection | Edge) {
    if (!draft) return;
    const edge = { id: `edge_${crypto.randomUUID()}`, source: connection.source, target: connection.target, port: (connection.sourceHandle ?? 'next') as 'next' | 'true' | 'false' };
    const issue = connectionIssue(draft.graph, edge);
    if (issue) { setError(issue); return; }
    edit({ ...draft, graph: { ...draft.graph, edges: [...draft.graph.edges, edge] } }); setError('');
  }
  async function save(publish = false) {
    if (!draft) return; setBusy(true); setError(''); setMessage('');
    try {
      let saved = draft;
      if (dirty) {
        const { id: _id, publishedVersionId: _published, publishedVersion: _number, ...body } = draft;
        void _id; void _published; void _number;
        saved = workflowDocumentSchema.parse(await request(`/workflows/${workflowId}/draft`, 'PUT', body, csrf));
        setDraft(saved); setDirty(false);
      }
      if (publish) {
        const response = await request(`/workflows/${workflowId}/publish`, 'POST', { revision: saved.revision }, csrf) as { workflow: unknown };
        saved = workflowDocumentSchema.parse(response.workflow); setDraft(saved); onPublished(saved.publishedVersionId!); setMessage(`Published version ${saved.publishedVersion}. Runs use this immutable version.`);
      } else setMessage('Draft saved. Published runs are unchanged.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save workflow.'); }
    finally { setBusy(false); }
  }
  function add(type: WorkflowNode['type']) {
    if (!draft) return;
    const base = { id: `node_${crypto.randomUUID().slice(0, 8)}`, name: type.replaceAll('_', ' ') };
    const node: WorkflowNode = type === 'manual_trigger' ? { ...base, type, config: {} } : type === 'condition' ? { ...base, type, config: { operator: 'greater_than', left: { source: 'input', path: ['price'] }, right: { source: 'literal', value: 0 } } } : type === 'record_update' ? { ...base, type, config: { proposal: defaultBinding } } : type === 'agent' ? { ...base, type, config: { agentVersionId: agents[0]?.id ?? 'missing', input: defaultBinding } } : { ...base, type, config: { fields: {} } };
    edit({ ...draft, graph: { ...draft.graph, nodes: [...draft.graph.nodes, node] }, layout: { ...draft.layout, [node.id]: { x: draft.graph.nodes.length * 60, y: draft.graph.nodes.length * 70 } } }); setSelected(node.id);
  }
  if (!draft) return <p role="status">{error || 'Loading workflow editor…'}</p>;
  return <section className="editor" aria-label="Workflow editor">
    <div className="editor-toolbar"><label>Workflow name<input value={draft.name} onChange={event => edit({ ...draft, name: event.target.value })}/></label><div className="form-actions"><span className="small-copy">{dirty ? 'Unsaved changes' : `Draft revision ${draft.revision}`}</span><button className="quiet-button" disabled={busy || hasInvalidInput} onClick={() => { void save(); }}>Save draft</button><button disabled={busy || hasInvalidInput || !validation?.success || !draft.name.trim()} onClick={() => { void save(true); }}>Publish version</button><button className="quiet-button" disabled={busy} onClick={() => { void reload(); }}>{dirty ? "Discard changes and reopen" : "Reopen draft"}</button></div></div>
    {error && <p role="alert" className="error-message">{error}</p>}{message && <p role="status" className="success-message">{message}</p>}
    <div className="editor-palette">{(['manual_trigger', 'mapping', 'condition', 'agent', 'record_update', 'output'] as const).map(type => <button className="quiet-button" key={type} disabled={draft.graph.nodes.length >= 100} onClick={() => add(type)}>Add {type.replaceAll('_', ' ')}</button>)}</div>
    <div className="editor-body"><div className="canvas" aria-label="Workflow canvas"><ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView onNodeClick={(_event, node) => setSelected(node.id)} onNodesChange={changes => {
      let next = draft;
      for (const change of changes) {
        if (change.type === 'position' && change.position) next = { ...next, layout: { ...next.layout, [change.id]: change.position } };
        if (change.type === 'remove') next = { ...next, graph: { ...next.graph, nodes: next.graph.nodes.filter(node => node.id !== change.id), edges: next.graph.edges.filter(edge => edge.source !== change.id && edge.target !== change.id) } };
      }
      if (next !== draft) edit(next);
    }} onEdgesChange={changes => { const removed = new Set(changes.filter(change => change.type === 'remove').map(change => change.id)); if (removed.size) edit({ ...draft, graph: { ...draft.graph, edges: draft.graph.edges.filter(edge => !removed.has(edge.id)) } }); }}
      onConnect={connect} isValidConnection={connection => !connectionIssue(draft.graph, { id: 'candidate', source: connection.source, target: connection.target, port: (connection.sourceHandle ?? 'next') as 'next' | 'true' | 'false' })}>
      <Background/><Controls/></ReactFlow></div>
      <aside className="node-panel"><label>Configure node<select value={selected ?? ''} onChange={event => setSelected(event.target.value)}><option value="">Select a node</option>{draft.graph.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
        {node && <><label>Node name<input value={node.name} onChange={event => updateNode({ ...node, name: event.target.value })}/></label>
          {(node.type === 'mapping' || node.type === 'output') && <><h3>Output fields</h3>{Object.entries(node.config.fields).map(([key, binding]) => <div className="field-binding" key={`${node.id}:${key}`}><strong>{key}</strong><BindingControl id={`${node.id}.${key}`} value={binding} nodes={draft.graph.nodes.filter(item => item.id !== node.id)} onValidity={validity} onChange={binding => updateNode({ ...node, config: { fields: { ...node.config.fields, [key]: binding } } })}/><button className="quiet-button" onClick={() => { const fields = { ...node.config.fields }; delete fields[key]; updateNode({ ...node, config: { fields } }); }}>Remove {key}</button></div>)}
            <label>New field name<input value={fieldName} onChange={event => setFieldName(event.target.value)}/></label><button className="quiet-button" onClick={() => { const key = fieldName.trim(); if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(node.config.fields, key)) { setError('Choose a unique, safe field name.'); return; } updateNode({ ...node, config: { fields: { ...node.config.fields, [key]: defaultBinding } } }); setFieldName(''); }}>Add field</button></>}
          {node.type === 'condition' && <><label>Operator<select value={node.config.operator} onChange={event => { const operator = event.target.value as 'equals' | 'not_equals' | 'greater_than' | 'exists'; updateNode({ ...node, config: operator === 'exists' ? { operator, left: node.config.left } : { operator, left: node.config.left, right: node.config.operator === 'exists' ? { source: 'literal', value: 0 } : node.config.right } }); }}><option value="greater_than">Greater than</option><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="exists">Exists</option></select></label>
            <BindingControl id={`${node.id}.left`} value={node.config.left} nodes={draft.graph.nodes.filter(item => item.id !== node.id)} onValidity={validity} onChange={left => updateNode({ ...node, config: { ...node.config, left } })}/>
            {node.config.operator !== 'exists' && <BindingControl id={`${node.id}.right`} value={node.config.right} nodes={draft.graph.nodes.filter(item => item.id !== node.id)} onValidity={validity} onChange={right => { if (node.config.operator !== 'exists') updateNode({ ...node, config: { ...node.config, right } }); }}/>}</>}
          {node.type === 'record_update' && <><p>Input must contain sku, expectedRevision, and changes. The worker pauses for approval of the exact payload.</p><BindingControl id={`${node.id}.proposal`} value={node.config.proposal} nodes={draft.graph.nodes.filter(item => item.id !== node.id)} onValidity={validity} onChange={proposal => updateNode({ ...node, config: { proposal } })}/></>}
          {node.type === 'agent' && <><label>Published agent version<select value={node.config.agentVersionId} onChange={event => updateNode({ ...node, config: { ...node.config, agentVersionId: event.target.value } })}><option value="missing">Choose a version</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.definition.name} · v{agent.version} · {agent.definition.model.mode}</option>)}</select></label><BindingControl id={`${node.id}.input`} value={node.config.input} nodes={draft.graph.nodes.filter(item => item.id !== node.id)} onValidity={validity} onChange={input => updateNode({ ...node, config: { ...node.config, input } })}/></>}
          {node.type === 'manual_trigger' && <p>The run input is this step’s output.</p>}
          <button className="quiet-button remove-node" onClick={() => { edit({ ...draft, graph: { ...draft.graph, nodes: draft.graph.nodes.filter(item => item.id !== node.id), edges: draft.graph.edges.filter(edge => edge.source !== node.id && edge.target !== node.id) } }); setSelected(null); }}>Remove node</button>
        </>}
      </aside></div>
    <details className="connection-form"><summary>Manage connections without dragging</summary><div className="form-actions"><label>From<select value={connectSource} onChange={event => setConnectSource(event.target.value)}><option value="">Select source</option>{draft.graph.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><label>Port<select value={connectPort} onChange={event => setConnectPort(event.target.value as 'next' | 'true' | 'false')}><option value="next">Next</option><option value="true">True</option><option value="false">False</option></select></label><label>To<select value={connectTarget} onChange={event => setConnectTarget(event.target.value)}><option value="">Select target</option>{draft.graph.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label><button className="quiet-button" onClick={() => connect({ source: connectSource, target: connectTarget, sourceHandle: connectPort, targetHandle: 'in' })}>Connect nodes</button></div>
      <ul>{draft.graph.edges.map(edge => <li key={edge.id}>{draft.graph.nodes.find(node => node.id === edge.source)?.name} ({edge.port}) → {draft.graph.nodes.find(node => node.id === edge.target)?.name} <button className="quiet-button" onClick={() => edit({ ...draft, graph: { ...draft.graph, edges: draft.graph.edges.filter(item => item.id !== edge.id) } })}>Remove connection</button></li>)}</ul></details>
    <div className="validation-summary" aria-live="polite">{hasInvalidInput && <p>Finish entering valid literal JSON before saving.</p>}{validation?.success ? <p>Graph is valid and ready to publish.</p> : <><h3>Resolve before publishing</h3><ul>{validation?.error.issues.map((issue, index) => <li key={index}>{issue.path.join('.')}: {issue.message}</li>)}</ul></>}{detail && !matchingRun && <p>The selected run uses a different graph. Its historical step results remain available below.</p>}</div>
  </section>;
}
