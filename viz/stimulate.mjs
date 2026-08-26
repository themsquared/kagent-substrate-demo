#!/usr/bin/env node
// Auto-stimulator: sends REAL chats to random SandboxAgents so the live board
// keeps moving during a POC. Nothing is faked — every prompt restores a real
// actor from its snapshot, runs a real LLM turn, and checkpoints back.
//
//   node stimulate.mjs                      # ~1 chat every few seconds, 2 in flight
//   node stimulate.mjs --concurrency 3 --interval 4
//   KAGENT_API=http://127.0.0.1:8083 node stimulate.mjs
//
// Requires the kagent controller API (server.mjs --live already port-forwards
// svc/kagent-controller 8083; otherwise run your own kubectl port-forward).
const API = process.env.KAGENT_API || 'http://127.0.0.1:8083';
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
const INTERVAL = arg('interval', 6);        // mean seconds between new chats
const CONCURRENCY = arg('concurrency', 2);  // max chats in flight

const PROMPTS = [
  'In one short sentence, what is your job?',
  'Give me one tip from your specialty. One sentence.',
  'Say something reassuring about production. One sentence.',
  'What would you check first during an incident? One sentence.',
  'Name one thing platform teams forget. One sentence.',
  'Reply with a haiku about Kubernetes.',
  'One sentence: why do snapshots beat idle pods?',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = a => a[Math.floor(Math.random() * a.length)];
const jitter = s => (s * (0.5 + Math.random())) * 1000;

async function listSandboxAgents() {
  const r = await fetch(`${API}/api/agents`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return (j.data ?? [])
    .filter(a => a.agent?.kind === 'SandboxAgent')
    .map(a => `${a.agent.metadata.namespace}/${a.agent.metadata.name}`);
}

let inFlight = 0, sent = 0, ok = 0, failed = 0;

async function chat(agentRef) {
  const [ns, name] = agentRef.split('/');
  const prompt = rand(PROMPTS);
  const id = `stim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  inFlight++; sent++;
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}/api/a2a-sandboxes/${ns}/${name}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // fresh contextId per chat = a fresh session actor restore every time
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
        params: { message: { kind: 'message', messageId: id, contextId: id,
          role: 'user', parts: [{ kind: 'text', text: prompt }] } } }),
      signal: AbortSignal.timeout(180_000),
    });
    const j = await r.json();
    const text = j.result?.artifacts?.flatMap(a => a.parts ?? [])
                   .map(p => p.text).filter(Boolean).join(' ') ?? '';
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (j.error) { failed++; console.log(`✗ ${name} (${secs}s): ${j.error.message?.slice(0, 90)}`); }
    else { ok++; console.log(`✓ ${name} (${secs}s): ${text.slice(0, 90) || '(no text)'}`); }
  } catch (e) {
    failed++; console.log(`✗ ${name}: ${String(e.message).slice(0, 90)}`);
  } finally { inFlight--; }
}

const agents = await listSandboxAgents();
if (!agents.length) { console.error(`no SandboxAgents found at ${API}/api/agents`); process.exit(1); }
console.log(`stimulating ${agents.length} agents via ${API} — mean interval ${INTERVAL}s, ≤${CONCURRENCY} in flight`);
console.log(agents.map(a => '  ' + a).join('\n'));

let stop = false;
process.on('SIGINT', () => { stop = true;
  console.log(`\nstopping… sent=${sent} ok=${ok} failed=${failed}`); });

while (!stop) {
  if (inFlight < CONCURRENCY) chat(rand(agents));   // deliberately not awaited
  await sleep(jitter(INTERVAL));
}
while (inFlight > 0) await sleep(500);
process.exit(0);
