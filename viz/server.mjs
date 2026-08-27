#!/usr/bin/env node
// Substrate Scope — static host + SSE event feed.
//
//   node server.mjs              # simulated feed (frontend built-in)
//   node server.mjs --live       # poll the current kubectl context every 2s
//
// Live mode watches what the Kubernetes API can see:
//   - workerpools.ate.dev            → pool size
//   - actortemplates.ate.dev         → actor inventory + golden-snapshot phase
//   - sandboxagents.kagent.dev       → declarative agents on substrate
//   - agentharnesses.kagent.dev      → coding-agent harnesses
// Per-session actor state (Running/Suspended) lives in ateapi, not in CRDs;
// wiring that in is a TODO (see notes/substrate-architecture.md).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const LIVE = process.argv.includes('--live');
const PORT = Number(process.env.PORT || 8123);
// kagent's Connect API (SystemService/GetSubstrateStatus). If not overridden,
// live mode port-forwards svc/kagent-controller 8083 itself.
const KAGENT_API = process.env.KAGENT_API || 'http://127.0.0.1:8083';

const clients = new Set();
const send = ev => {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
};

const server = createServer(async (req, res) => {
  if (req.url === '/scale' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (!LIVE) return res.end(JSON.stringify({ ok: false, error: 'not in --live mode' }));
      const pool = Object.values(state.pools)[0];
      if (!pool) return res.end(JSON.stringify({ ok: false, error: 'no workerpool seen yet' }));
      let replicas;
      try { replicas = Math.max(1, Math.min(8, Number(JSON.parse(body).replicas))); }
      catch { return res.end(JSON.stringify({ ok: false, error: 'bad request' })); }
      // the documented ephemeral scaling path: kubectl scale workerpool
      execFile('kubectl', ['scale', 'workerpools.ate.dev', pool.name,
                           '-n', pool.ns, `--replicas=${replicas}`],
        { timeout: 10_000 },
        err => res.end(JSON.stringify(err ? { ok: false, error: String(err.message).slice(0, 200) }
                                          : { ok: true, replicas })));
    });
    return;
  }
  if (req.url === '/reset' && req.method === 'POST') {
    // frees workers pinned by ghost actors (v0.0.6 wedge after aborted
    // sessions): bounce the WorkerPool's deployment; snapshots survive
    res.setHeader('Content-Type', 'application/json');
    if (!LIVE) { res.end(JSON.stringify({ ok: false, error: 'not in --live mode' })); return; }
    const pool = Object.values(state.pools)[0];
    if (!pool) { res.end(JSON.stringify({ ok: false, error: 'no workerpool seen yet' })); return; }
    execFile('kubectl', ['rollout', 'restart', `deploy/${pool.name}-deployment`, '-n', pool.ns],
      { timeout: 15_000 },
      err => res.end(JSON.stringify(err ? { ok: false, error: String(err.message).slice(0, 200) }
                                        : { ok: true })));
    return;
  }
  if (req.url === '/queue' && req.method === 'POST') {
    // stimulate.mjs reports which agents are waiting on a full pool (substrate
    // rejects rather than queues, so the retry-queue lives client-side)
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        stimWaiting = (JSON.parse(body).waiting ?? []).map(w => w.name ?? w);
        broadcastQueue();
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{"ok":false}'); }
    });
    return;
  }
  if (req.url === '/demo') {
    // master kill switch: stimulate.mjs polls this and stops dispatching
    // real (billable) chats when run=false; surge respects it too
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try { demoRun = !!JSON.parse(body).run; } catch { demoRun = !demoRun; }
        send({ type: 'demo_state', run: demoRun });
        res.end(JSON.stringify({ ok: true, run: demoRun }));
      });
    } else res.end(JSON.stringify({ run: demoRun }));
    return;
  }
  if (req.url === '/surge' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    if (!LIVE) { res.end(JSON.stringify({ ok: false, error: 'not in --live mode' })); return; }
    surge().then(n => res.end(JSON.stringify({ ok: true, fired: n })));
    return;
  }
  if (req.url === '/autoscale' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      try { autoscale = !!JSON.parse(body).on; } catch { autoscale = !autoscale; }
      upStreak = 0; downStreak = 0;
      send({ type: 'autoscale_state', on: autoscale });
      res.end(JSON.stringify({ ok: true, on: autoscale }));
    });
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream',
                         'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'mode', live: LIVE })}\n\n`);
    if (LIVE) replayState(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type':
      path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

// ── live mode: kubectl polling ───────────────────────────────────────────────
const state = { pools: {}, actors: {} };   // last-seen, for diffing + replay

// ── metrics: kubelet stats (no metrics-server needed) ────────────────────────
// Benchmark data is REAL: the default kagent Agents run as always-on pods in
// the same cluster; their measured per-pod cost × (number of substrate agents)
// is the dotted "if these were all pods" line.
const metrics = [];              // ring buffer of sample points
const METRICS_MAX = 1200;        // ~1h at 3s
let queuedNow = 0;               // updated by /queue posts from stimulate.mjs
let nodeName = null;

// Per-unit reservation, read from a real always-on agent Deployment: the fair
// comparison is RESERVED capacity (requests), not idle usage. One substrate
// worker needs the same per-session unit an agent pod does — you just need
// `slots` of them instead of `agents`.
const unit = { cpu: 50, mem: 128 };   // fallback = kagent chart defaults
const parseCpu = s => !s ? 0 : s.endsWith('m') ? parseInt(s) : parseFloat(s) * 1000;
const parseMem = s => !s ? 0 : s.endsWith('Gi') ? parseFloat(s) * 1024 : parseInt(s);
async function fetchUnit() {
  const d = await kubectl(['get', 'deploy', 'k8s-agent', '-n', 'kagent', '-o', 'json']);
  const r = d?.spec?.template?.spec?.containers?.[0]?.resources?.requests;
  if (r?.cpu) unit.cpu = parseCpu(r.cpu) || unit.cpu;
  if (r?.memory) unit.mem = parseMem(r.memory) || unit.mem;
}

async function sampleMetrics() {
  if (!LIVE) return;
  if (!nodeName) {
    const n = await kubectl(['get', 'nodes', '-o', 'json']);
    nodeName = n?.items?.[0]?.metadata?.name;
    if (!nodeName) return;
  }
  const s = await kubectl(['get', '--raw', `/api/v1/nodes/${nodeName}/proxy/stats/summary`]);
  const snap = state.lastSnap;
  if (!s || !snap) return;
  const poolName = Object.values(state.pools)[0]?.name ?? 'kagent-default';
  let wCpu = 0, wMem = 0, aCpu = 0, aMem = 0, aN = 0;
  for (const p of s.pods ?? []) {
    if (p.podRef.namespace !== 'kagent') continue;
    const name = p.podRef.name;
    const cpu = ((p.cpu ?? {}).usageNanoCores ?? 0) / 1e6;         // mCPU
    const mem = ((p.memory ?? {}).workingSetBytes ?? 0) / 1048576; // MiB
    if (name.startsWith(`${poolName}-deployment-`)) { wCpu += cpu; wMem += mem; }
    else if (!name.startsWith('kagent-') && /-agent-/.test(name)) { aCpu += cpu; aMem += mem; aN++; }
  }
  const agents = (snap.actorTemplates ?? []).length;
  const slots = (snap.workers ?? []).length;
  const active = (snap.workers ?? []).filter(w => w.actorId).length;
  const point = {
    t: Date.now(),
    wCpu: Math.round(wCpu), wMem: Math.round(wMem),
    benchCpu: aN ? Math.round(aCpu / aN * agents) : 0,
    benchMem: aN ? Math.round(aMem / aN * agents) : 0,
    unitCpu: unit.cpu, unitMem: unit.mem,
    active, slots, queued: queuedNow, agents,
  };
  metrics.push(point);
  if (metrics.length > METRICS_MAX) metrics.shift();
  send({ type: 'metrics', p: point });
  autoscaleTick(point);
}

// ── autoscaler: demand-driven (queue depth up, idle capacity down) ───────────
// CPU is the wrong signal here: workers are slot-bound, and LLM turns are
// mostly I/O wait. Demand (queued + busy) vs slots is what actually matters.
let autoscale = LIVE && !process.argv.includes('--no-autoscale'),
    lastScaleAt = 0, upStreak = 0, downStreak = 0;
const AS = { MIN: 2, MAX: 8, COOL_UP: 12_000, COOL_DOWN: 45_000,
             UP_TICKS: 2, DOWN_TICKS: 12 };

function scaleTo(pool, n, why) {
  lastScaleAt = Date.now();
  execFile('kubectl', ['scale', 'workerpools.ate.dev', pool.name, '-n', pool.ns,
                       `--replicas=${n}`], { timeout: 10_000 },
    err => send({ type: 'autoscale', replicas: n, why, ok: !err }));
}

function autoscaleTick(point) {
  if (!autoscale) return;
  const pool = Object.values(state.pools)[0];
  if (!pool) return;
  if (point.queued > 0) { upStreak++; downStreak = 0; }
  else if (point.active < point.slots) { downStreak++; upStreak = 0; }
  else { upStreak = 0; downStreak = 0; }
  const now = Date.now();
  if (upStreak >= AS.UP_TICKS && point.slots < AS.MAX && now - lastScaleAt > AS.COOL_UP) {
    upStreak = 0; scaleTo(pool, point.slots + 1, `queue depth ${point.queued}`);
  } else if (downStreak >= AS.DOWN_TICKS && point.slots > AS.MIN && now - lastScaleAt > AS.COOL_DOWN) {
    downStreak = 0; scaleTo(pool, point.slots - 1, 'idle capacity');
  }
}

// ── queue bookkeeping: union of stimulator-reported and surge-local waits ─────
let stimWaiting = [];                 // names reported by stimulate.mjs
const surgeWaiting = new Set();       // names of surge chats bouncing off a full pool
function broadcastQueue() {
  const names = [...new Set([...stimWaiting, ...surgeWaiting])];
  queuedNow = names.length;
  send({ type: 'queue', waiting: names.map(name => ({ name })) });
}

let demoRun = true;   // master switch for anything that costs LLM tokens

// ── surge: server-driven burst of real chats across every SandboxAgent ───────
async function surge() {
  if (!demoRun) return 0;
  const list = await new Promise(res => {
    fetch(`${KAGENT_API}/api/agents`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).then(j => res(j.data ?? [])).catch(() => res([]));
  });
  const targets = list.filter(a => a.agent?.kind === 'SandboxAgent')
    .map(a => `${a.agent.metadata.namespace}/${a.agent.metadata.name}`);
  for (const ref of targets) {
    surgeChat(ref);                       // fire-and-forget, retries inside
    await new Promise(r => setTimeout(r, 120));
  }
  return targets.length;
}

async function surgeChat(ref) {
  const [ns, name] = ref.split('/');
  const id = `surge-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  for (let tries = 0; tries < 60; tries++) {
    try {
      const r = await fetch(`${KAGENT_API}/api/a2a-sandboxes/${ns}/${name}/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
          params: { message: { kind: 'message', messageId: id, contextId: id, role: 'user',
            parts: [{ kind: 'text', text: 'Explain in about 120 words what you would do first in a production incident.' }] } } }),
        signal: AbortSignal.timeout(180_000),
      });
      const j = await r.json();
      if (j.error && /no free workers|worker pool/i.test(j.error.message ?? '')) {
        if (!surgeWaiting.has(name)) { surgeWaiting.add(name); broadcastQueue(); }
        await new Promise(res => setTimeout(res, 1500 + Math.random() * 1500));
        continue;
      }
      break;
    } catch { break; }
  }
  if (surgeWaiting.delete(name)) broadcastQueue();
}

function kubectl(args) {
  return new Promise(resolve => {
    execFile('kubectl', args, { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function replayState(res) {
  res.write(`data: ${JSON.stringify({ type: 'demo_state', run: demoRun })}\n\n`);
  if (metrics.length)
    res.write(`data: ${JSON.stringify({ type: 'metrics_history', points: metrics })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'autoscale_state', on: autoscale })}\n\n`);
  if (state.lastSnap) { res.write(`data: ${JSON.stringify(state.lastSnap)}\n\n`); return; }
  for (const p of Object.values(state.pools))
    res.write(`data: ${JSON.stringify(p)}\n\n`);
  for (const a of Object.values(state.actors))
    res.write(`data: ${JSON.stringify({ type: 'actor', name: a.name, ns: a.ns })}\n\n`);
}

// Preferred live source: the kagent controller's substrate inventory — the
// same data the kagent UI's Substrate page shows. Returns runtime actor state
// and worker assignments straight from ate-api — the stuff CRDs can't see.
// (v0.9.9 serves it as REST at /api/substrate/status; newer builds also expose
// it as gRPC-Web SystemService/GetSubstrateStatus.)
async function fetchStatus() {
  try {
    const r = await fetch(`${KAGENT_API}/api/substrate/status`,
                          { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data ?? null;
  } catch { return null; }
}

async function poll() {
  const snap = await fetchStatus();
  if (snap) {
    for (const p of snap.workerPools ?? [])
      state.pools[p.name] = { type: 'pool', name: p.name, ns: p.namespace, replicas: p.replicas };
    state.lastSnap = { type: 'snapshot', ...snap };
    send(state.lastSnap);
    return;                    // full-fidelity source — skip the CRD fallback
  }
  const pools = await kubectl(['get', 'workerpools.ate.dev', '-A', '-o', 'json']);
  for (const item of pools?.items ?? []) {
    const name = item.metadata.name, ns = item.metadata.namespace;
    const replicas = item.spec?.replicas ?? 0;
    if (state.pools[name]?.replicas !== replicas) {
      state.pools[name] = { type: 'pool', name, ns, replicas };
      send(state.pools[name]);
    }
  }
  for (const kind of ['sandboxagents.kagent.dev', 'agentharnesses.kagent.dev',
                      'actortemplates.ate.dev']) {
    const list = await kubectl(['get', kind, '-A', '-o', 'json']);
    for (const item of list?.items ?? []) {
      const ns = item.metadata.namespace, name = item.metadata.name;
      const key = `${kind}/${ns}/${name}`;
      const phase = item.status?.phase
        ?? item.status?.conditions?.find(c => c.type === 'Ready')?.status
        ?? 'Unknown';
      const prev = state.actors[key];
      if (!prev) {
        state.actors[key] = { name, ns, phase };
        send({ type: 'actor', name, ns });
        send({ type: 'run', name, ns, msg: `${kind.split('.')[0]} · ${phase}` });
      } else if (prev.phase !== phase) {
        prev.phase = phase;
        send({ type: 'run', name, ns, msg: `phase → ${phase}` });
      }
    }
  }
}

server.listen(PORT, () => {
  console.log(`Substrate Scope → http://localhost:${PORT}  (${LIVE ? 'LIVE, polling the cluster' : 'simulated'})`);
  if (LIVE) {
    if (!process.env.KAGENT_API) {
      const pf = () => {
        const c = spawn('kubectl', ['port-forward', '-n', 'kagent',
                        'svc/kagent-controller', '8083:8083'], { stdio: 'ignore' });
        c.on('exit', () => setTimeout(pf, 2000));   // survive pod restarts
      };
      pf();
    }
    poll(); setInterval(poll, 800);   // fast enough to catch ~1.5s Haiku sessions on a worker
    fetchUnit();
    setTimeout(() => { sampleMetrics(); setInterval(sampleMetrics, 3000); }, 4000);
  }
});
