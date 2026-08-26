# kagent × Agent Substrate integration

How kagent runs workloads on substrate, and how the three agent kinds differ.

## The three agent kinds

| CRD | What runs | Where it runs |
| --- | --- | --- |
| `Agent` | kagent-managed runtime (declarative or BYO container) | Plain Deployment |
| `SandboxAgent` | Go declarative agent runtime | Substrate actor (gVisor) |
| `AgentHarness` | Third-party coding agent (OpenClaw or Hermes) in a managed sandbox | Substrate actor — always; `spec.substrate` is required |

Key constraint: **only the Go ADK runtime is supported on substrate today** —
Python declarative agents can't be SandboxAgents.

## SandboxAgent

Same spec as `Agent` (model, instructions, tools) plus:

```yaml
substrate:
  workerPoolRef:
    name: kagent-default   # omit → controller's default WorkerPool
```

Lifecycle: first reconcile builds a **golden snapshot** (~60–90s), then each
chat session restores a per-session actor from it, runs, and suspends back to
object storage. Between requests the actor shows `Suspended` in the UI's
Substrate inventory view.

## AgentHarness

Lifecycle management for a remote coding-agent sandbox. Spec surface:
`backend` (openclaw | hermes), `substrate` (workerPoolRef, snapshotsConfig,
workloadImage), `image`, `env`, `modelConfigRef`, `channels`.

- Controller generates a per-harness `ActorTemplate`, waits for its golden
  snapshot to be `Ready`.
- **One shared long-lived actor** created on first chat connection; every chat
  is multiplexed as an ACP session inside it. (Capacity math: a harness pins a
  worker slot; declarative sessions release theirs on suspend.)
- Snapshot default path: `gs://ate-snapshots/<namespace>/<agentharnessname>`.
- Conditions: `Accepted` (spec handed to backend), `Ready` (golden snapshot ready).
- Channels: Slack integration, with backend-specific config (`slack.openclaw`
  vs `slack.hermes`) enforced by CEL validation on the CRD.

## The ACP bridge (why acp-shim exists)

Substrate exposes only network ingress into actors — no SSH/exec. Coding
agents speak ACP (Agent Client Protocol, JSON-RPC) over stdio. The chain:

```
kagent UI / A2A client
  → kagent controller (A2A ↔ ACP bridge, ACP client)
    → ACP over WebSocket (substrate ingress)
      → acp-shim inside the sandbox (WS ↔ stdio)
        → `openclaw acp` / `hermes acp`
```

Result: a harness appears in the kagent UI as a regular agent — streamed tool
activity, tool-approval prompts mapped onto kagent's human-in-the-loop flow —
with no backend-specific UI.

## Install wiring (kagent side)

Substrate integration needs **kagent chart ≥ 0.9.7** (earlier charts silently
ignore the flags). The values that turn it on:

```
controller.substrate.enabled=true
controller.substrate.ateApiEndpoint=dns:///api.ate-system.svc:443
controller.substrate.ateApiInsecure=true        # local/dev only
substrateWorkerPool.create=true
substrateWorkerPool.replicas=1
substrateWorkerPool.ateomImage=ghcr.io/kagent-dev/substrate/ateom-gvisor:v0.0.6
```

WorkerPool sizing rule of thumb: `1 + (number of active harnesses)` minimum,
more for overlapping declarative sessions.

## Substrate inventory API (verified live, kagent 0.9.9)

The kagent UI's "View → Substrate" data — including per-actor runtime status
from ate-api that no CRD exposes — is served by the controller (svc
`kagent-controller:8083`):

```
GET /api/substrate/status
→ { error, data: { enabled, workerPools[], actorTemplates[], actors[], workers[] }, message }
```

- `actors[].status`: real runtime state (`Resuming`, …) straight from ate-api.
- `workers[]`: one entry per worker pod, with the assigned `actorId` when occupied.
- Newer kagent (main) also serves this as gRPC-Web
  `kagent.api.v1alpha1.SystemService/GetSubstrateStatus` (same shape); 0.9.9
  only has the REST route. Substrate Scope's live mode polls the REST route.

Also verified: `kubectl scale workerpools.ate.dev kagent-default -n kagent
--replicas=N` takes effect immediately — new worker pods join the pool live.

## SandboxAgent gotcha (0.9.9, differs from docs example)

The CRD requires `spec.platform: substrate` when `spec.substrate` is set
(CEL: "spec.substrate may only be set when spec.platform is substrate";
platform enum: `agent-sandbox` | `substrate`, defaults to `agent-sandbox`).
The docs example omits it and fails validation.

## Ollama provider (no API key needed)

`--set providers.default=ollama --set providers.ollama.model=<model>` — the
chart's ollama provider defaults to `host.docker.internal:11434`, which is
exactly right for kind on Docker Desktop. Verified with qwen3:4b.

## Field gotchas (from the official walkthrough)

- Empty `OPENAI_API_KEY` at install → no `kagent-openai` secret → default
  agents stuck in `CreateContainerConfigError`. Patch with
  `--reuse-values --set providers.openAI.apiKey=...`.
- Don't inline the env assignment on the same line as `helm ... --set
  x="${VAR}"` — the shell expands the var before the inline assignment exists.
- Helm `--timeout 10m` can trip on the controller/postgres startup race;
  `kubectl wait deploy/kagent-controller` and continue.
- `kubectl scale workerpool` works but reverts on the next helm upgrade.
