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
  if (req.url === '/queue' && req.method === 'POST') {
    // stimulate.mjs reports which agents are waiting on a full pool (substrate
    // rejects rather than queues, so the retry-queue lives client-side)
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      try { send({ type: 'queue', waiting: JSON.parse(body).waiting ?? [] }); res.end('{"ok":true}'); }
      catch { res.writeHead(400); res.end('{"ok":false}'); }
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

function kubectl(args) {
  return new Promise(resolve => {
    execFile('kubectl', args, { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function replayState(res) {
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
    poll(); setInterval(poll, 1500);
  }
});
