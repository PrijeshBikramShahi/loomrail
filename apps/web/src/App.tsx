import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { runDetailSchema, runSchema, runEventSchema, sampleCatalogueInput, type Run, type RunDetail } from '@loomrail/contracts';

import { ApiError, request } from './api.js';
const Evaluations = lazy(() => import('./Evaluations.js').then(module => ({ default: module.Evaluations })));
const Data = lazy(() => import('./Data.js').then(module => ({ default: module.Data })));
const Approvals = lazy(() => import('./Approvals.js').then(module => ({ default: module.Approvals })));
const Agents = lazy(() => import('./Agents.js').then(module => ({ default: module.Agents })));
const WorkflowEditor = lazy(() => import('./WorkflowEditor.js').then(module => ({ default: module.WorkflowEditor })));

const label = (status: string) => status.replaceAll('_', ' ');
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function App() {
  const [session, setSession] = useState<string | null | undefined>(undefined);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState(JSON.stringify(sampleCatalogueInput, null, 2));
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [workflowId, setWorkflowId] = useState('catalogue');
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; publishedVersionId: string | null; publishedVersion: number | null }>>([]);
  const [page, setPage] = useState<'workflows' | 'agents' | 'approvals' | 'data' | 'evaluations'>('workflows');
  const [editing, setEditing] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const cursor = useRef({ id: '', sequence: 0 });
  const [versionId, setVersionId] = useState<string | null>(null);
  const [pollError, setPollError] = useState('');
  const submission = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    let alive = true;
    request('/session').then(value => { if (alive) setSession((value as { csrfToken: string }).csrfToken); })
      .catch(error => { if (!alive) return; setSession(null); if (!(error instanceof ApiError && error.status === 401)) setError(String(error.message)); });
    return () => { alive = false; };
  }, []);
  const failure = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { setSession(null); setEditorDirty(false); setDetail(null); setRuns([]); setSelected(null); }
    setError(error instanceof Error ? error.message : 'The request failed. Try again.');
  }, []);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    if (cursor.current.id !== selected) cursor.current = { id: selected ?? '', sequence: 0 };
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [history, workflowList, newEvents] = await Promise.all([
          request('/runs'), request('/workflows'), selected ? request(`/runs/${selected}/events?after=${cursor.current.sequence}`) : Promise.resolve([]),
        ]);
        const events = runEventSchema.array().parse(newEvents);
        const current = selected && events.length ? runDetailSchema.parse(await request(`/runs/${selected}`)) : null;
        if (stopped) return;
        setRuns(runSchema.array().parse(history));
        const options = workflowList as typeof workflows;
        setWorkflows(options);
        setVersionId(options.find(workflow => workflow.id === workflowId)?.publishedVersionId ?? null);
        if (current) { setDetail(current); cursor.current = { id: selected!, sequence: current.events.at(-1)?.sequence ?? 0 }; }
        setPollError('');
      } catch (error) { if (!stopped) { if (error instanceof ApiError && error.status === 401) failure(error); else setPollError('Updates paused. Retrying the connection…'); } }
      finally { if (!stopped) timer = setTimeout(() => { void poll(); }, 1000); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, selected, workflowId, failure]);

  async function signIn(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await request('/session', 'POST', { secret }); setSession((result as { csrfToken: string }).csrfToken); setSecret(''); }
    catch (error) { failure(error); }
    finally { setBusy(false); }
  }
  async function startRun(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); if (!session || !versionId) return;
    setBusy(true); setError('');
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(input); } catch { throw new Error('Input must be valid JSON. Check commas and quotation marks.'); }
      const encoded = JSON.stringify({ input: parsed, workflowVersionId: versionId });
      if (submission.current?.body !== encoded) submission.current = { body: encoded, key: crypto.randomUUID() };
      const run = runSchema.parse(await request('/runs', 'POST', { workflowVersionId: versionId, requestId: submission.current.key, input: parsed }, session));
      submission.current = null; cursor.current = { id: run.id, sequence: 0 }; setDetail(null); setSelected(run.id); setRuns(previous => [run, ...previous.filter(item => item.id !== run.id)]);
    } catch (error) { failure(error); }
    finally { setBusy(false); }
  }
  async function cancelRun() {
    if (!session || !selected) return; setBusy(true); setError('');
    try { await request(`/runs/${selected}/cancel`, 'POST', undefined, session); setDetail(runDetailSchema.parse(await request(`/runs/${selected}`))); }
    catch (error) { failure(error); } finally { setBusy(false); }
  }
  async function newWorkflow() {
    if (!session) return; setBusy(true); setError('');
    try { const draft = await request('/workflows', 'POST', { name: 'Untitled workflow' }, session) as { id: string }; setWorkflowId(draft.id); setVersionId(null); setEditing(true); }
    catch (error) { failure(error); } finally { setBusy(false); }
  }
  async function signOut() {
    if (!session) return; setBusy(true); setError('');
    try { await request('/session', 'DELETE', undefined, session); setSession(null); setEditorDirty(false); setRuns([]); setDetail(null); setSelected(null); }
    catch (error) { failure(error); } finally { setBusy(false); }
  }

  return <>
    <header className="app-header"><a href="/" className="wordmark"><span aria-hidden="true" className="mark">╫</span> Loomrail</a><span>Workspace</span><span className="build-state">Single-operator workspace</span>{session && <button className="quiet-button" disabled={busy} onClick={() => { void signOut(); }}>Sign out</button>}</header>
    <main>
      {error && <div role="alert" className="error-message">{error}</div>}
      {session === undefined ? <p role="status">Checking your session…</p> : !session ?
        <section className="sign-in"><h1>Open your workspace</h1><p>Enter your operator key to view workflows and run history.</p>
          <form onSubmit={event => { void signIn(event); }}><label htmlFor="operator-key">Operator key</label><input id="operator-key" type="password" autoComplete="current-password" value={secret} onChange={event => setSecret(event.target.value)} required maxLength={256}/><button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form>
          <details><summary>First time here?</summary><p>Run <code>npm run operator:init</code> in the project terminal. Your private key is saved outside the repository at <code>~/.config/loomrail/operator.key</code> unless you configured another path. Copy its contents into the field above.</p><p>Keep the API and worker running in separate terminals. This workspace is for local access.</p></details>
        </section> : <>
          <nav className="workspace-nav" aria-label="Workspace sections">{([['workflows','Workflows'],['agents','Agents & providers'],['approvals','Approvals'],['data','Records & knowledge'],['evaluations','Evaluations']] as const).map(([id,title]) => <button key={id} className="quiet-button" disabled={editorDirty && id !== page} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>{title}</button>)}<a className="replay-link" href="/replay.html" target="_blank" rel="noreferrer">Recorded fixture replay ↗</a></nav>
          {page === 'evaluations' && <Suspense fallback={<p>Loading evaluations…</p>}><Evaluations csrf={session}/></Suspense>}
          {page === 'data' && <Suspense fallback={<p>Loading records…</p>}><Data csrf={session} onRecord={value => { setInput(JSON.stringify(value, null, 2)); setPage('workflows'); }} onWorkflow={(id, version) => { setWorkflowId(id); setVersionId(version); }}/></Suspense>}
          {page === 'approvals' && <Suspense fallback={<p>Loading approvals…</p>}><Approvals csrf={session} onRun={id => { cursor.current = { id, sequence: 0 }; setSelected(id); setDetail(null); setPage('workflows'); }}/></Suspense>}
          {page === 'agents' && <Suspense fallback={<p>Loading agents…</p>}><Agents csrf={session} onRun={run => { cursor.current = { id: run.id, sequence: 0 }; setSelected(run.id); setDetail(null); setPage('workflows'); }}/></Suspense>}
          <div hidden={page !== 'workflows'}>
          <div className="page-heading"><div><h1>{workflows.find(workflow => workflow.id === workflowId)?.name ?? "Workflows"}</h1><p>Edit a draft, publish a version, and follow each run from input to outcome.</p></div><span className="read-only">{versionId ? `Published version ${workflows.find(workflow => workflow.id === workflowId)?.publishedVersion ?? "—"}` : "Unpublished draft"}</span></div>
          <div className="workflow-switcher"><label>Workflow<select disabled={editorDirty} value={workflowId} onChange={event => { setWorkflowId(event.target.value); setVersionId(null); }}>{workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label><button className="quiet-button" onClick={() => setEditing(value => !value)} aria-expanded={editing}>{editing ? "Hide editor" : "Edit workflow"}</button><button className="quiet-button" disabled={busy || editorDirty} onClick={() => { void newWorkflow(); }}>New workflow</button></div>
          {(editing || editorDirty) && <div hidden={!editing}><Suspense fallback={<p>Loading editor…</p>}><WorkflowEditor key={workflowId} workflowId={workflowId} csrf={session} detail={detail} onPublished={setVersionId} onDirtyChange={setEditorDirty}/></Suspense></div>}
          {pollError && <p role="status" className="error-message">{pollError}</p>}
          <div className="workspace-grid">
            <section className="run-compose" aria-labelledby="run-title"><h2 id="run-title">Start a run</h2><p>{workflowId === "catalogue" ? "A positive price prepares the listing. Zero or negative prices go to review. Missing fields fail with a step-level error." : "Runs use the current published version. Save and publish your draft before starting."}</p>
              <form onSubmit={event => { void startRun(event); }}><label htmlFor="run-input">Supplier record (JSON)</label><textarea id="run-input" value={input} onChange={event => setInput(event.target.value)} spellCheck={false} rows={9}/>
                <div className="form-actions"><button disabled={busy || !versionId}>{busy ? 'Working…' : 'Run workflow'}</button><button type="button" className="quiet-button" onClick={() => setInput(JSON.stringify({ ...sampleCatalogueInput, price: 0 }, null, 2))}>Use review example</button></div></form>
              <p className="small-copy">Execution uses the providers pinned in the published workflow. Remote inference requires operator configuration.</p>
            </section>
            <section className="run-history" aria-labelledby="history-title"><h2 id="history-title">Recent runs</h2><p>Latest 50 runs. Select one to inspect its saved results.</p>
              {runs.length === 0 ? <div className="empty-state">No runs yet. Start with the fictional supplier record.</div> : <ul className="history-list">{runs.map(run => <li key={run.id}><button className={`history-item ${selected === run.id ? 'selected' : ''}`} aria-pressed={selected === run.id} onClick={() => { if (selected !== run.id) { setSelected(run.id); setDetail(null); } }}><span><strong>{time(run.createdAt)}</strong><small>{new Date(run.createdAt).toLocaleDateString()} · {run.id.slice(0, 8)}</small></span><span className={`status status-${run.status}`}>{label(run.status)}</span></button></li>)}</ul>}
            </section>
          </div>
          {selected && !detail && <p role="status">Loading run details…</p>}
          {detail && <section className="run-detail" aria-labelledby="detail-title"><div className="section-heading"><div><h2 id="detail-title">Run {detail.run.id.slice(0, 8)}</h2><p>{detail.run.mode} mode · {detail.run.workflowVersionId} · Started {detail.run.startedAt ? time(detail.run.startedAt) : '—'}</p></div><div className="form-actions"><span className={`status status-${detail.run.status}`}>{label(detail.run.status)}</span>{['queued', 'running', 'awaiting_approval', 'needs_attention'].includes(detail.run.status) && <button className="quiet-button" disabled={busy} onClick={() => { void cancelRun(); }}>Cancel run</button>}</div></div>
            {detail.run.status === 'awaiting_approval' && <p className="run-notice">This run is paused for review. <button className="quiet-button" onClick={() => setPage('approvals')}>Review proposed changes</button></p>}
            {detail.run.status === 'needs_attention' && <p className="run-notice">An external result is uncertain. Open Approvals to reconcile its action identity; the write will not be retried automatically.</p>}
            {detail.run.status === 'queued' && <p className="run-notice">Waiting for the worker. Start it with <code>npm run worker</code> if it is not running.</p>}
            {detail.run.error && <p role="alert" className="error-message">{detail.run.error.nodeId}: {detail.run.error.message}</p>}
            <ol className="step-results">{detail.steps.map(step => <li key={step.nodeId}><details><summary><span>{detail.graph.nodes.find(node => node.id === step.nodeId)?.name ?? label(step.nodeId)}</span><span className={`status status-${step.status}`}>{label(step.status)}</span></summary><p>Attempt {step.attempt}{step.startedAt ? ` · ${time(step.startedAt)}` : ''}</p><h3>Resolved inputs</h3><pre>{JSON.stringify(step.resolvedInputs, null, 2)}</pre><h3>{step.error ? 'Error' : 'Output'}</h3><pre>{JSON.stringify(step.error ?? step.output, null, 2)}</pre></details></li>)}</ol>
            <div className="result-grid"><div><h3>Run input</h3><pre>{JSON.stringify(detail.run.input, null, 2)}</pre></div><div><h3>Final result</h3><pre>{JSON.stringify(detail.run.result, null, 2)}</pre></div></div>
            {detail.agents.length > 0 && <details><summary>Agent versions, model responses, usage, and tool evidence</summary><p>Token counts and cost may be unknown (null). Fixture responses are deterministic test data.</p><pre>{JSON.stringify(detail.agents, null, 2)}</pre></details>}
            <details className="event-history"><summary>Event history ({detail.events.length})</summary><ol>{detail.events.map(event => <li key={event.sequence}><span>{event.sequence}. {label(event.type)}{event.nodeId ? ` · ${label(event.nodeId)}` : ''}</span><time dateTime={event.createdAt}>{time(event.createdAt)}</time></li>)}</ol></details>
          </section>}
          </div>
        </>}
    </main><footer>Single-host workspace · Fixture results are not live inference · Keep services private.</footer>
  </>;
}
