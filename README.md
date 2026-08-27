# Agent Substrate Expert Track

Workspace for becoming the kagent + Agent Substrate expert at Solo.

📝 **Write-up**: [Thousands of AI Agents on Tens of Pods: kagent Agent Substrate](https://webofmike.com/kagent-agent-substrate/) — the full story of this repo: the install, the visualizer, the autoscaler, and every gotcha, with verbatim errors and fixes.

## What Agent Substrate is (one paragraph)

Agent Substrate is a Kubernetes-native runtime for AI agents that breaks the
pod-per-agent model. Idle agents are checkpointed (Zstd snapshots) to object
storage and rehydrated on demand onto a small pool of pre-warmed gVisor worker
pods, so one WorkerPool serves far more agents than it has pods. kagent uses it
two ways: `SandboxAgent` (a Go declarative agent run as a sandboxed actor) and
`AgentHarness` (a managed sandbox running a third-party coding agent — OpenClaw
or Hermes — that kagent chats with over ACP).

## Repo layout

- [LEARNING-PLAN.md](LEARNING-PLAN.md) — the expert track, phased
- [notes/substrate-architecture.md](notes/substrate-architecture.md) — runtime internals
- [notes/kagent-integration.md](notes/kagent-integration.md) — SandboxAgent, AgentHarness, ACP
- [labs/lab1-kind-substrate.sh](labs/lab1-kind-substrate.sh) — hands-on: substrate + kagent + SandboxAgent on kind
- [viz/](viz/README.md) — Substrate Scope: real-time actor-lifecycle visualizer (simulated + live cluster modes)

## Primary sources

| Source | What it's for |
| --- | --- |
| https://kagent.dev/docs/kagent/concepts/agent-substrate | Concept page — the elevator pitch + CRD surface |
| https://kagent.dev/docs/kagent/concepts/agent-harness | AgentHarness / ACP / OpenClaw + Hermes backends |
| https://kagent.dev/docs/kagent/examples/agent-substrate | kind walkthrough (basis for lab 1) |
| https://learn.agentsubstrate.dev/ | Internals deep dive: topology, resume-actor flow, ateapi |
| https://github.com/agent-substrate/substrate | Source — `docs/architecture.md`, `docs/glossary.md`, `docs/api-guide.md` |
| https://www.masterthemesh.com/solo/kagent-quickstart-kind/ | Tom O'Rourke's field labs (kagent POC patterns) |
