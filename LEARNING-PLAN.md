# Expert track: kagent + Agent Substrate

Goal: be the person at Solo who can explain, demo, debug, and position Agent
Substrate — from CRD surface down to snapshot mechanics, and up to customer
architecture conversations.

## Phase 1 — Foundations (this week)

- [x] Read concept docs: agent-substrate, agent-harness (notes captured)
- [ ] Run [labs/lab1-kind-substrate.sh](labs/lab1-kind-substrate.sh) end to end;
      watch the actor lifecycle in the UI (Suspended ↔ Running)
- [ ] Repeat with an `AgentHarness` (OpenClaw backend) — chat over ACP,
      confirm the 1-harness-pins-1-slot capacity behavior by scaling the pool
- [ ] Read Tom O'Rourke's kagent quickstart lab for field POC framing:
      https://www.masterthemesh.com/solo/kagent-quickstart-kind/

## Phase 2 — Internals (next)

- [ ] learn.agentsubstrate.dev: topology, resume-actor flow, ateapi internals
- [ ] Clone https://github.com/agent-substrate/substrate — read
      docs/architecture.md, docs/glossary.md, docs/api-guide.md
- [ ] Trace one request: atenet routing → ateapi workflow → ateom/gVisor
      restore → atelet snapshot upload. Diagram it.
- [ ] Understand checkpoint mechanics (gVisor save/restore) and what state
      does/doesn't survive a suspend
- [ ] Break things on purpose: kill a worker mid-session, fill the pool,
      delete a snapshot — document observed failure modes

## Phase 3 — Enterprise + ecosystem

- [ ] Solo Enterprise for kagent: what layers on OSS substrate
      (docs.solo.io/kagent-enterprise) — RBAC, audit, AgentRegistry tie-in
- [ ] How agentgateway fronts substrate-hosted agents (A2A/MCP path)
- [ ] Position vs alternatives: pod-per-agent, Knative, AgentCore, plain
      Deployments — when substrate wins (density, cold start, sandboxing)
- [ ] Sizing guidance: WorkerPool math for mixed harness + declarative fleets

## Phase 4 — Field readiness

- [ ] Build a repeatable customer demo (10 min: density story + live suspend/resume)
- [ ] Wire Substrate Scope (viz/) live mode to real per-session actor state —
      find the endpoint the kagent UI's "View → Substrate" inventory uses (ateapi?)
- [ ] Write the one-pager: "What is Agent Substrate" for AE/SE enablement
- [ ] FAQ from first customer conversations; feed corrections back into notes/

## Standing habits

- Every gotcha found in a lab goes into notes/ the same day.
- Validate every command before it lands in anything customer-facing
  (helm show chart / kubectl dry-run) — house rule.
