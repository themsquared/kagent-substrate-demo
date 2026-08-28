# Substrate Scope

Real-time visualization of the Agent Substrate actor lifecycle: worker bays up
top (hot, amber), object storage down below (cold, cyan), actor chips flying
between them on restore/checkpoint. Density, session, and last-restore-latency
counters in the header.

Demo controls (simulated mode): **SURGE** invokes every idle agent at once so
the queue forms; **workers +** boots new bays live (they warm up pulling
`ateom-gvisor` before taking actors) and the queue drains into them. Per-bay
session counters show the multiplexing story — one bay, many agents over time.
In live mode the workers buttons run the real scaling path
(`kubectl scale workerpool`) against the cluster.

## Auto-stimulate (keep a POC board moving)

Idle clusters make boring demos. `stimulate.mjs` sends real chats to random
SandboxAgents on a jittered interval — every one is a genuine actor restore →
LLM turn → checkpoint, so the board churns with real traffic:

```bash
node viz/stimulate.mjs                      # auto-sized to the pool, no budget
node viz/stimulate.mjs --budget 200         # stop after 200 chats (overnight-safe)
node viz/stimulate.mjs --oversub 6 --load 0.9 --interval 2
```

Flags: `--budget N` stop after N chats total and flip the board's STOP DEMO
switch (default unlimited); `--oversub N` in-flight beyond the pool size, makes
the queue visible (default 4); `--load 0..1` fraction of long-form prompts
(default 0.75); `--interval s` dispatch-check pacing (default 2);
`--concurrency N` pin in-flight instead of auto-sizing. The board's STOP DEMO
button halts dispatching within ~2s; clicking again resumes.

It discovers SandboxAgents from `/api/agents` and drives them through the
controller's sandbox A2A mount (`/api/a2a-sandboxes/<ns>/<name>/` — note:
SandboxAgents are *not* on the regular `/api/a2a/` mount in kagent 0.9.9, and
`message/send` requires a `contextId`). Needs the controller API on
`KAGENT_API` (default `http://127.0.0.1:8083`; `server.mjs --live` already
port-forwards it).

## Run it

```bash
# Simulated feed — no cluster needed. Perfect for talks/demos.
open public/index.html            # or: node server.mjs → http://localhost:8123

# Live mode — points at your current kubectl context (e.g. the lab 1 kind cluster)
# Also port-forwards the kagent UI to http://localhost:8001 (KAGENT_UI_PORT to
# change): chat with any agent there and watch its actor restore on the board.
node server.mjs --live
```

## What "live" can and can't see (today)

| Signal | Source | Status |
| --- | --- | --- |
| WorkerPool size | `workerpools.ate.dev` | ✅ live |
| Actor inventory | `actortemplates.ate.dev`, `sandboxagents`, `agentharnesses` | ✅ live |
| Golden-snapshot phase | ActorTemplate `status.phase` | ✅ live (event feed) |
| Per-session Running/Suspended | `ateapi` (gRPC, Redis-backed) — **not a CRD** | ⬜ TODO |

The full restore→run→checkpoint animation runs in simulated mode. Wiring the
real per-session state means talking to ateapi (or whatever endpoint the
kagent UI's "View → Substrate" inventory uses) — tracked in
[notes/substrate-architecture.md](../notes/substrate-architecture.md) open questions.
