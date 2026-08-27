# Autoscaling Agent Substrate WorkerPools

What signal should scale the pool? Explored 2026-08-27; a working demand-driven
autoscaler ships in `viz/server.mjs` (toggle in Substrate Scope, or
`POST /autoscale {"on":true}`).

## Candidate signals, evaluated

**CPU — wrong for this runtime.** Workers are *slot-bound*, not CPU-bound: one
actor per worker regardless of load, and an LLM turn is mostly I/O wait on the
model provider. Measured on the live pool: a worker hosting an active Haiku
session idles at a few mCPU. A CPU-based HPA would never scale up while
requests bounce off a full pool, and would scale *down* under peak load. Same
argument kills memory-based scaling (restored snapshots have near-constant
footprints).

**Queue depth over time — the right up-signal.** Substrate *rejects* when the
pool is full ("worker pool has no free workers") rather than queuing, so the
queue lives client-side (retries). Sustained rejections are the purest
statement of unmet demand. Caveat: you need visibility into it — today that
means instrumenting clients (Substrate Scope's stimulator reports its retry
queue) or counting rejection errors at the caller. The right upstream fix is a
substrate-side metric (rejections/sec or pending-resume gauge from ateapi);
worth filing on the substrate repo.

**Occupancy (busy slots / total slots) — the right down-signal.** Queue depth
is always ~0 when capacity is adequate, so it can't tell you *how much* spare
you have. Occupancy can: sustained `busy < slots` means paid-for warm workers
doing nothing.

**Demand vs capacity (busy + queued vs slots)** is the unified view; the
shipped policy is a split of it:

```
target      = busy + queued, clamped to [2, 8]
scale UP    straight to target when queued > 0 for 2 samples (6s), cooldown 8s
scale DOWN  straight to max(demand over last 30s window) when that peak < slots
            for 6 samples (~18s), cooldown 20s
```

Target-based on purpose (v2 — ±1 stepping was too timid): one decisive jump
to what demand needs in either direction. The down-target uses the WINDOW PEAK
rather than instantaneous demand so a brief dip between sessions can't slash
the pool, while a genuinely idle pool still drops 8→2 in a single step.

Design notes:
- **Asymmetric on purpose**: scale up fast (queued work is user-visible
  latency), scale down slow (a killed warm worker you need again in 10s costs
  a warm-up). Same shape as every good autoscaler (HPA stabilization windows).
- **Hysteresis + cooldowns** prevent flapping when load oscillates near a
  capacity boundary.
- **min 2**: one worker means any long session blocks ALL other agents; two is
  the floor for a demo that never looks frozen.
- Scale-up unit is +1 worker. At larger scale you'd step proportionally to
  queue depth (like HPA's `ceil(current * demand/capacity)`).

## What production would want (positioning notes)

- KEDA is the natural shape for this: a `ScaledObject` on an external scaler
  fed by a substrate rejection/pending metric, targeting the WorkerPool's
  `scale` subresource (which it has — `kubectl scale workerpool` works).
- Until substrate exports that metric, an adapter that counts A2A "no free
  workers" errors at agentgateway (atenet IS agentgateway — it's already in
  the data path and can count these) would be a very Solo-flavored answer.
- Watch out for the field-manager conflict: anything that scales via
  `kubectl scale`/scale-subresource takes ownership of `.spec.replicas`;
  helm upgrades then need `--force-conflicts`.

## Surge (demo mechanism)

`POST /surge` (SURGE button in live mode) fires one real ~120-word chat at
every SandboxAgent with per-request retry — queue spikes, autoscaler reacts,
pool grows, queue drains, then idle-capacity scale-down walks it back. The
whole loop is visible on the board and in the Capacity/Agents-active charts.
