# Agent Substrate — runtime architecture

Synthesized from kagent.dev concept docs + learn.agentsubstrate.dev (2026-08-26).

## The core idea

Pod-per-agent wastes capacity: agents are idle most of the time. Substrate
decouples agent lifecycle from pod lifecycle:

1. Agent invoked → its **actor** is restored onto a free worker from the
   **WorkerPool** (rehydrated from a snapshot if it was idle).
2. Agent runs inside a **gVisor sandbox** for the session.
3. Actor goes idle → state checkpointed (Zstd) back to object storage
   (GCS or S3), worker slot freed.

Claimed density: ~30× more actors than pods. Cold start = snapshot restore,
not pod boot.

## Vocabulary

| Term | Definition |
| --- | --- |
| Actor | One agent instance with isolated state. Identity = (atespace, name) tuple. |
| WorkerPool | CRD: pool of pre-warmed gVisor worker pods that host actors. |
| ActorTemplate | CRD: actor config + lifecycle behavior. kagent generates one per AgentHarness. |
| Snapshot | Zstd checkpoint of actor state in object storage. "Golden snapshot" = the template's initial ready state. |
| Session | Execution context tracking an actor's activity and checkpoints. |
| atespace | Namespace-like grouping in actor identity. |

## Components (the `ate*` family)

**Control plane**
- `ateapi` — gRPC API + workflow engine, backed by Redis (deployed as valkey-cluster).
- `atecontroller` — Kubernetes reconciler for WorkerPool and ActorTemplate.

**Data plane**
- `atenet` — L7 proxy + DNS routing layer directing traffic to actors.
- `atelet` — DaemonSet handling snapshot upload/download per node.
- `ateom` — worker-pod supervisor talking to the gVisor runtime
  (`ateom-gvisor` image).

**Storage**
- Object storage for snapshots (GCS or S3; local installs ship `rustfs`).

What a healthy `ate-system` namespace looks like (v0.0.6 on kind):
`ate-api-server`, `ate-controller`, `atelet-*`, `atenet-router`,
`valkey-cluster-{0..5}`, `rustfs`, plus Completed init jobs.

## Security & access model

- Every workload runs in a gVisor sandbox — isolates untrusted agent code from
  the host and from other actors.
- Substrate exposes only network ingress into actors. **No SSH, no exec.**
  This is why kagent needs the `acp-shim` (see kagent-integration notes).
- v0.0.6 chart defaults to JWT auth backed by Kubernetes ServiceAccount
  tokens — vanilla kind works with no feature gates.

## Open questions to chase (internals deep-dive)

- [ ] Resume-actor flow end-to-end: https://learn.agentsubstrate.dev/flows/resume-actor/
- [ ] ateapi workflow engine + Redis data model: https://learn.agentsubstrate.dev/components/ateapi/
- [ ] System topology (binaries, ports, connections): https://learn.agentsubstrate.dev/topology/
- [ ] How checkpointing actually works under gVisor (CRIU-style? gVisor save/restore?)
- [ ] Scheduling: how ateapi picks a worker; what happens when the pool is full
- [ ] Failure modes: snapshot corruption, mid-session worker death, object-store outage
- [ ] Enterprise layer: what Solo Enterprise for kagent adds on top of OSS substrate
