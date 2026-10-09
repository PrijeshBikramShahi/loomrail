import { useEffect, useState } from 'react';
import { approvalSchema, type Approval } from '@loomrail/contracts';
import { request } from './api.js';
export function Approvals({ csrf, onRun }: { csrf: string; onRun: (id: string) => void }) {
  const [evidence, setEvidence] = useState<Record<string, unknown>>({});
  const [items, setItems] = useState<Approval[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [edits, setEdits] = useState<Record<string, string>>({});
  const load = async () => setItems(approvalSchema.array().parse(await request('/approvals')));
  useEffect(() => { let alive = true; const refresh = async () => { try { const items = approvalSchema.array().parse(await request('/approvals')); if (alive) setItems(items); } catch (error) { if (alive) setError(String(error)); } }; void refresh(); const timer = setInterval(() => { void refresh(); }, 2000); return () => { alive = false; clearInterval(timer); }; }, []);
  async function decide(approval: Approval, decision: 'approve' | 'reject' | 'edit') {
    setBusy(true); setError('');
    try { await request(`/approvals/${approval.id}/decide`, 'POST', { revision: approval.revision, decision, ...(decision === 'edit' ? { payload: { ...approval.payload, changes: JSON.parse(edits[approval.id] ?? JSON.stringify(approval.payload.changes)) } } : {}) }, csrf); setEdits(previous => { const next = { ...previous }; delete next[approval.id]; return next; }); await load(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Decision failed.'); } finally { setBusy(false); }
  }
  return <section className="management-panel" aria-label="Approvals"><h2>Approvals</h2><p>Approve the exact saved changes below. Editing creates a new proposal revision that requires a separate approval. A record changed since review requires a new run.</p>
    {error && <p role="alert" className="error-message">{error}</p>}{!items.length && <p>No proposals yet. Add a record update node to pause a workflow for review.</p>}
    {items.map(item => <article className="approval-card" key={item.id}><div className="section-heading"><h3>{item.payload.sku} · proposal {item.revision}</h3><span className={`status status-${item.status}`}>{item.status}</span></div><p>Run {item.runId.slice(0, 8)} · expected record revision {item.payload.expectedRevision} · Destination: {item.destination}</p>
      <div className="result-grid"><div><h4>Before</h4><pre>{JSON.stringify(item.original, null, 2)}</pre></div><div><h4>Exact changes</h4><pre>{JSON.stringify(item.payload.changes, null, 2)}</pre></div></div>
      <button className="quiet-button" onClick={() => onRun(item.runId)}>Inspect run</button>
      <button className="quiet-button" onClick={() => { void request(`/runs/${item.runId}`).then(value => setEvidence(previous => ({ ...previous, [item.id]: (value as { agents: unknown }).agents }))).catch(error => setError(String(error))); }}>Inspect model and source evidence</button>{evidence[item.id] !== undefined && <details open><summary>Pinned agent and retrieved source chunks</summary><pre>{JSON.stringify(evidence[item.id], null, 2)}</pre></details>}
      {item.status === 'pending' && <><details><summary>Edit proposed fields</summary><label>Replacement changes (JSON)<textarea rows={6} value={edits[item.id] ?? JSON.stringify(item.payload.changes, null, 2)} onChange={event => setEdits({ ...edits, [item.id]: event.target.value })}/></label><button disabled={busy} onClick={() => { void decide(item, 'edit'); }}>Save replacement for review</button></details><div className="form-actions"><button disabled={busy || edits[item.id] !== undefined} onClick={() => { void decide(item, 'approve'); }}>Approve exact changes</button><button className="quiet-button" disabled={busy} onClick={() => { void decide(item, 'reject'); }}>Reject proposal</button></div></>}
      {item.destination !== 'records' && item.status === 'approved' && <button className="quiet-button" disabled={busy} onClick={() => { setBusy(true); void request(`/actions/${item.id}/reconcile`, 'POST', {}, csrf).then(async value => { const result = value as { status: string; message?: string }; if (result.status === 'uncertain') setError(result.message ?? 'Action remains uncertain.'); await load(); }).catch(error => setError(String(error))).finally(() => setBusy(false)); }}>Reconcile controlled external result (read-only)</button>}
      {item.status === 'applied' && item.destination === 'records' && <a href={`/api/artifacts/${item.id}`} download>Download approved listing JSON</a>}
    </article>)}
  </section>;
}
