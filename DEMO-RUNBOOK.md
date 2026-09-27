# Company-wide demo runbook — Substrate Scope live

Validated end-to-end 2026-09-17 on kind-kagent-substrate
(kagent 0.10.1 + substrate 0.0.9, Ollama qwen3:4b, 9 SandboxAgents Ready).

## Preflight (5 min, morning of)

```bash
# 1. No stray clusters starving the Docker VM (the k3d-mcp-federation lesson)
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'

# 2. Demo cluster healthy (context matters — default context is k3d-ai-demo!)
kubectl --context kind-kagent-substrate get pods -n ate-system --no-headers | grep -cv -E 'Running|Completed'   # want 0
kubectl --context kind-kagent-substrate get sandboxagents -n kagent   # want 9 Ready

# 3. Ollama up AND responsive (version alone can lie during a convoy)
curl -s localhost:11434/api/version
curl -s --max-time 30 localhost:11434/api/generate \
  -d '{"model":"qwen3:4b","prompt":"say ok","stream":false,"options":{"num_predict":10}}' >/dev/null \
  && echo "ollama responsive" || echo "CONVOY? -> brew services restart ollama"
```

## Start the rig (already running as of 2026-09-17 evening)

```bash
cd ~/substrate-scope
KUBE_CONTEXT=kind-kagent-substrate node server.mjs --live
```

- Board: http://localhost:8123
- kagent chat UI (auto-forwarded): http://localhost:8001
- KUBE_CONTEXT is REQUIRED on this machine: default kubectl context is the
  k3d-ai-demo enterprise cluster; Scope pins every kubectl call to the value.

Traffic (second terminal, start ~2 min before showtime so bays are warm):

```bash
cd ~/substrate-scope
node stimulate.mjs --budget 400 --load 0.5
```

**Provider is Anthropic `claude-haiku-4-5`** (switched 2026-09-17 night). Real
concurrency, ~1–2s replies, so the pool and autoscaler behave correctly:
more workers genuinely means more throughput, and SURGE → autoscale-up is a
real demo beat now. `--budget 400` caps spend (≈ a dollar; each session is a
fraction of a cent) and flips STOP DEMO when hit — never leave it running
uncapped. Ctrl-C or STOP DEMO halts within 2s.

**OpenAI works too, and is much cheaper.** `OPENAI_API_KEY=... PROVIDER=openai
./labs/lab1-kind-substrate.sh` installs against `gpt-5-nano`, the cheapest text
model OpenAI lists. Per MTok that is $0.05 in / $0.40 out against Haiku 4.5's
$1.00 / $5.00 (checked 2026-09-18), so the same 400-session budget lands in
single-digit cents. The demo does not turn on answer quality — the beats are
restore latency, pool behaviour and autoscaling — so nano is enough.
`OPENAI_MODEL=gpt-4.1-mini` if you want sharper replies on screen.

> If you ever fall back to local Ollama: it serves ONE generation at a time
> (`-np 1`), so cap `--concurrency 2` and expect 25–60s turns; more workers
> make it WORSE, not better. That mismatch is why we run Anthropic for the demo.

## The 5 beats (~6 min)

1. **The lie of kubectl** — terminal: `kubectl --context kind-kagent-substrate
   get pods -n kagent | grep kagent-default`. "Three quiet pods." Flip to the
   board: nine agents, sessions climbing. State lives in object storage, not pods.
2. **Watch one think** — click any RUNNING chip: drawer shows the prompt,
   restore → pod, the reply with latency, checkpoint. Then TALK TO IT: type in
   the drawer box, watch your own message become a restore.
3. **Break it on purpose** — SURGE twice. Queue lane fills (substrate rejects
   when full; retry queue is client-side). Fairness tab: 📢 noisy neighbor vs
   🍽️ starved — "usage is popularity, contention is noise."
4. **Let it heal** — AUTOSCALE is on: one jump to demand, then a one-jump
   walk-down on the 30s window. Point at the autoscale lines in the feed.
5. **The money chart** — Telemetry → CPU: dotted line = these agents as
   always-on pods, forever. Amber = what the pool reserves, breathing.

## If something wedges

- Workers pinned by ghost actors ("no free workers", bays look idle):
  **RESET POOL** button. Snapshots survive; ~15s.
- Board frozen: check the server terminal; restart the `node server.mjs --live`
  command. Port-forwards self-heal.
- Anything billable runs away: **STOP DEMO** (also stops stimulate within 2s).
- Nuclear, zero-cluster fallback: `node server.mjs` (sim mode) or the artifact —
  the full experience, synthetic data.

## Do not touch

- The k3d-ai-demo cluster (enterprise; not part of this demo).
- kagent 0.10 quirk, already handled in Scope: generated ActorTemplate names
  carry a 16-hex suffix; the server strips it. spec.platform no longer exists
  on SandboxAgent (0.10 rejects it; fleet manifest already clean).
