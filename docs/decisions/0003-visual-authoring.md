# 0003 — Drafts, publication, and visual authoring

Date: 2026-10-07
Status: implemented in M2

The canvas uses open-source React Flow 12.12.0 for node placement and handles. Execution still belongs to the server. The editor translates visual nodes into shared graph schemas; positions remain separate. Partial graphs can be saved, while publishing rejects missing links, joins, cycles, unsupported ports, and invalid upstream references. Accessible select-and-connect controls offer an alternative to dragging.

Draft updates carry a monotonically increasing revision. Stale saves and publication requests return 409 instead of overwriting new work. Publication validates the complete graph inside a transaction, inserts an immutable version, and updates the workflow pointer. Runs always reference their selected published version. Saving or publishing a later draft cannot rewrite an active run.

The editor overlays step statuses only when the inspected run's graph matches the current draft. Otherwise it explains that historical results use a different graph. Event polling resumes from the last observed sequence, and refreshed details are coherent database snapshots. The editor is lazy-loaded so login and run inspection do not load the graph library first.

Retain the established palette and typography. The canvas, node configuration panel, validation issues, and run results carry the visual structure. Do not add dashboard metrics or decorative navigation.

References: [custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [connection validation](https://reactflow.dev/examples/interaction/validation).
