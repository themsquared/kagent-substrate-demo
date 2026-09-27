#!/usr/bin/env bash
# Lab 1: Agent Substrate + kagent + SandboxAgent on kind
# Source: https://kagent.dev/docs/kagent/examples/agent-substrate
#
# 2026-09-06 REBUILD. The previous cluster (built 2026-08-26 on substrate 0.0.6 /
# kagent 0.9.9) died on a valkey topology fault: the cluster persisted its old pod
# IPs through a restart, every peer went unreachable, cluster_state:fail with 10923
# slots pfail, and ate-api-server could never finish its 30 connect retries
# (688 CrashLoopBackOff restarts by 09-06). Rebuilding rather than repairing,
# because the pinned versions were also 20 chart releases behind.
#
# Version selection, checked against the ghcr tag lists on 2026-09-06:
#   substrate chart newest = 0.0.26   (cluster had 0.0.6)
#   kagent chart newest    = 0.10.0   (cluster had 0.9.9; 0.10.0 is the GA)
# We pin substrate 0.0.8, the pairing kagent 0.10.0's own release notes bump to,
# NOT the newest chart. Tried 0.0.26 first and it cannot be installed by helm
# alone:
#   0.0.8  values default to auth.mode=jwt, and templates/pod-certificate-controller.yaml
#          is wrapped in {{- if eq .Values.auth.mode "mtls" -}}, so the whole
#          PodCertificate path is skipped and jwt-bootstrap.yaml self-bootstraps.
#   0.0.26 has no `auth` values at all. The podcert path is unconditional, and the
#          controller mounts Secrets service-dns-ca-pool and pod-identity-ca-pool
#          that NO chart template creates. Upstream makes them out of band in
#          hack/install-ate.sh via `kubectl ate admin make-ca-pool`, i.e. the repo
#          cloned and the `ate` CLI built. Without them the controller sits in
#          ContainerCreating on FailedMount, nothing issues credential bundles, and
#          every pod that projects one deadlocks:
#            MountVolume.SetUp failed for volume "podidentity":
#              credential bundle is not issued yet
#          then postgres dies on the missing server cert and the release times out.
# Consequence for the day-6 measurement topic: substrate #1283 "multi-actor worker
# API" (merged 2026-09-04) is NOT exercisable on a helm-only lab. Measuring it needs
# the upstream dev bootstrap, which is a separate piece of work.
#
# 2026-09-09 PIN UPDATE. kagent 0.10.1 (released 2026-09-08; three bugfixes, no
# substrate changes) + substrate 0.0.9. Why 0.0.9 and not newer: kagent 0.10.x's
# go.mod replaces github.com/agent-substrate/substrate with kagent-dev/substrate
# v0.0.9, so 0.0.9 is the client/server pairing kagent actually tests. Charts
# 0.0.10-0.0.12 still carry auth.mode=jwt and would helm-install, but against an
# untested client. 0.0.13+ drop the auth values entirely (podcert only, needs the
# CA-pool bootstrap described above). kagent main already vendors v0.0.26, so the
# NEXT kagent minor will require the podcert-era substrate and this helm-only lab
# will need the upstream bootstrap.
#
# In-place substrate upgrades across 0.0.x are NOT safe (observed 0.0.8 -> 0.0.9,
# 2026-09-09): the actor records in valkey are stored as protojson and 0.0.9's
# ateapi rejects 0.0.8's with
#   while listing actors in db: in protojson.Unmarshal: proto: (line 1:2): unknown field "actorId"
# so /api/substrate/status loses actors+workers, ResumeActor fails with
#   grpc: error unmarshalling request: proto: cannot parse invalid wire-format data
# and a SandboxAgent delete wedges on its kagent.dev/sandbox-agent-substrate-cleanup
# finalizer. Rebuild (this script) or flush the valkey state store; snapshots in
# rustfs are orphaned either way and kagent re-bakes goldens.
set -euo pipefail

SUBSTRATE_VERSION="${SUBSTRATE_VERSION:-0.0.9}"
KAGENT_VERSION="${KAGENT_VERSION:-0.10.1}"
CLUSTER_NAME="kagent-substrate"

# --- Preflight ---------------------------------------------------------------
for bin in kind kubectl helm docker; do
  command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }
done
# PROVIDER switch added 2026-09-10 for the book's validation pass, run without an
# Anthropic key on hand. anthropic (default) is what the book documents and what
# the 1.5-2s restore numbers in Chapter 4 are measured against; ollama is for
# install-path-only validation (Chapters 2-3) and reproduces the original
# blog-post path (qwen3:4b via the chart's default host.docker.internal:11434).
# Timing and quality numbers from an ollama run are NOT the pinned book numbers
# and must be marked as such wherever they are recorded.
PROVIDER="${PROVIDER:-anthropic}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3:4b}"
# gpt-5-nano is the cheapest text model OpenAI lists: $0.05/$0.40 per MTok
# against claude-haiku-4-5's $1.00/$5.00 (checked 2026-09-18), so 20x cheaper in
# and 12.5x out. This demo does not care about answer quality — the beats are
# restore latency, pool behaviour and autoscaling. It only needs real
# concurrency, which any hosted model gives and local Ollama does not.
# Verified end to end on 0.10.1: a SandboxAgent turn returns its system-message
# identity on gpt-5-nano, so the model string passes straight through.
# Override for a sharper model:
#   OPENAI_MODEL=gpt-4.1-mini PROVIDER=openai ./labs/lab1-kind-substrate.sh
OPENAI_MODEL="${OPENAI_MODEL:-gpt-5-nano}"
case "$PROVIDER" in
  anthropic)
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] \
      && echo "ANTHROPIC_API_KEY set (len=${#ANTHROPIC_API_KEY})" \
      || { echo "ANTHROPIC_API_KEY is empty — export it first, or run with PROVIDER=openai or PROVIDER=ollama"; exit 1; }
    ;;
  openai)
    [[ -n "${OPENAI_API_KEY:-}" ]] \
      && echo "OPENAI_API_KEY set (len=${#OPENAI_API_KEY})" \
      || { echo "OPENAI_API_KEY is empty — export it first, or run with PROVIDER=anthropic or PROVIDER=ollama"; exit 1; }
    ;;
  ollama)
    curl -s -m 3 http://localhost:11434/api/tags >/dev/null \
      && echo "ollama reachable on :11434" \
      || { echo "ollama not reachable on localhost:11434 — start it first"; exit 1; }
    # NOT `ollama list | grep -q`: grep -q exits on its first match while ollama
    # list is still writing later lines, and that SIGPIPEs the writer. Under
    # `set -o pipefail` the pipeline then reports exit 141 (128+SIGPIPE) even
    # though the match was found — the check would fail even when the model IS
    # present. Hit this live 2026-09-10 running the book's own validation pass.
    # Capture to a variable first so grep reads from a string, not a live pipe.
    _OLLAMA_LIST="$(ollama list 2>/dev/null)"
    grep -q "^${OLLAMA_MODEL}" <<<"$_OLLAMA_LIST" \
      && echo "model ${OLLAMA_MODEL} present" \
      || { echo "model ${OLLAMA_MODEL} not pulled — run: ollama pull ${OLLAMA_MODEL}"; exit 1; }
    ;;
  *) echo "PROVIDER must be anthropic, openai or ollama, got: $PROVIDER"; exit 1 ;;
esac

case "$PROVIDER" in
  openai) _MODEL_IN_PLAY="$OPENAI_MODEL" ;;
  ollama) _MODEL_IN_PLAY="$OLLAMA_MODEL" ;;
  *)      _MODEL_IN_PLAY="chart default" ;;
esac
echo "substrate=$SUBSTRATE_VERSION kagent=$KAGENT_VERSION provider=$PROVIDER model=$_MODEL_IN_PLAY"

# --- Workaround: Docker Desktop's credential helper is wedged ------------------
# 2026-09-06. Every `helm ... oci://ghcr.io/...` call stalls for many minutes on
# this machine. It is not a permanent hang: left alone, calls eventually complete
# once the helper gives up. But it blows through any helm --timeout, so it is a
# hard blocker in practice. Cause is not helm and not the registry: `helm list` is instant, ghcr's
# token+tags API answers in 0.25s over curl, and the Docker daemon is healthy
# (29.7.2). ~/.docker/config.json sets "credsStore": "desktop", and
# `docker-credential-desktop get` for ghcr.io never returns, so helm blocks
# shelling out to it before it makes a single request.
# These charts are public, so point helm at an empty docker config and pull
# anonymously. Verified 2026-09-06: all four charts pull in seconds this way.
# HELM_REGISTRY_CONFIG alone does NOT fix it; helm still consults the docker config.
# Permanent fix is Mike's: restart Docker Desktop, or drop "credsStore" from
# ~/.docker/config.json.
_EMPTY_DOCKER_CFG="$(mktemp -d)"
echo '{}' > "$_EMPTY_DOCKER_CFG/config.json"
export DOCKER_CONFIG="$_EMPTY_DOCKER_CFG"
trap 'rm -rf "$_EMPTY_DOCKER_CFG"' EXIT

# --- Step 0: remove the dead cluster -----------------------------------------
# Destructive and intended. The old cluster's valkey state is unrecoverable and
# its actor/session data is demo-only.
_KIND_CLUSTERS="$(kind get clusters 2>/dev/null)"
if grep -qx "$CLUSTER_NAME" <<<"$_KIND_CLUSTERS"; then
  echo "deleting existing kind cluster $CLUSTER_NAME"
  kind delete cluster --name "$CLUSTER_NAME"
fi

# --- Step 1: kind cluster ------------------------------------------------------
# A plain `kind create cluster` is NOT enough for modern substrate. Learned the
# hard way on the 2026-09-06 rebuild: substrate 0.0.26 mounts PodCertificate
# projected volumes (servicedns.podcert.ate.dev, podidentity.podcert.ate.dev).
# Those feature gates are off by default as of k8s 1.36, so the projected sources
# are silently DROPPED — helm only warns 'volume "podidentity" (Projected) has no
# sources provided' — and then postgres dies with:
#   FATAL: could not load server certificate file
#          "/run/servicedns.podcert.ate.dev/credential-bundle.pem"
# taking the whole install down with "context deadline exceeded".
#
# Config mirrors upstream hack/create-kind-cluster.sh (fetched 2026-09-06). The
# parallel-pull patch is from that script too, and its comment explains the other
# symptom we hit: the install pulls ~570MB of images onto one node, kubelet
# serializes pulls by default, and whatever lands at the back of the queue misses
# its readiness deadline (we saw pods at ContainerCreating for 10 minutes).
# Node image must be k8s 1.36+. kind v0.31.0 defaults to v1.35.0, where
# PodCertificateRequest is not a recognised gate: kubeadm silently drops it and
# the apiserver comes up with only --feature-gates=ClusterTrustBundle=true, so
# the guard below fires. Upstream's runtimeConfig targeting
# certificates.k8s.io/v1beta1 is the tell that substrate expects 1.36.
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.36.1}"
KIND_CFG="$(mktemp)"
cat > "$KIND_CFG" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
featureGates:
  ClusterTrustBundle: true
  ClusterTrustBundleProjection: true
  PodCertificateRequest: true
runtimeConfig:
  "certificates.k8s.io/v1beta1": "true"
kubeadmConfigPatches:
- |
  kind: KubeletConfiguration
  serializeImagePulls: false
  maxParallelImagePulls: 4
YAML
kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" --config "$KIND_CFG"
rm -f "$KIND_CFG"

# Fail fast if the gates did not actually take. Retry: discovery is not warm the
# instant kind returns, and a bare one-shot check here false-negatives on a
# perfectly good cluster (hit on the 2026-09-06 rebuild, twice).
echo "waiting for PodCertificateRequest API..."
for i in $(seq 1 30); do
  # NOT `kubectl api-resources`: that reads the discovery cache under
  # ~/.kube/cache/discovery/<host>_<port>, and a rebuilt kind cluster reuses the
  # same 0.0.0.0:<port>, so it answers from the PREVIOUS cluster's document and
  # false-negatives for minutes. `get --raw` goes to the apiserver every time.
  _API_RESOURCES="$(kubectl get --raw /apis/certificates.k8s.io/v1beta1 2>/dev/null)"
  if grep -q podcertificaterequests <<<"$_API_RESOURCES"; then
    echo "  PodCertificateRequest API present"; break
  fi
  if [[ $i -eq 30 ]]; then
    echo "PodCertificateRequest API missing after 60s — feature gates did not apply."
    echo "Check the node image is k8s 1.36+: kubectl get nodes -o wide"
    exit 1
  fi
  sleep 2
done

# --- Step 2: Agent Substrate -------------------------------------------------
helm upgrade --install substrate-crds \
  oci://ghcr.io/kagent-dev/substrate/helm/substrate-crds \
  --version "$SUBSTRATE_VERSION" \
  --namespace ate-system --create-namespace --wait

helm upgrade --install substrate \
  oci://ghcr.io/kagent-dev/substrate/helm/substrate \
  --version "$SUBSTRATE_VERSION" \
  --namespace ate-system --wait --timeout 10m

kubectl get pods -n ate-system
# Expect: ate-api-server, ate-controller, atelet-*, atenet-router,
#         valkey-cluster-{0..5}, rustfs — all Running (+ Completed init jobs)

# Gate on the exact failure that killed the last cluster, so a bad valkey
# topology surfaces here instead of 688 restarts later.
echo "checking valkey cluster state..."
for i in $(seq 1 30); do
  state=$(kubectl exec -n ate-system valkey-cluster-0 -- redis-cli -p 6379 cluster info 2>/dev/null | tr -d '\r' | awk -F: '/^cluster_state:/{print $2}')
  [[ "$state" == "ok" ]] && { echo "  cluster_state:ok"; break; }
  [[ $i -eq 30 ]] && { echo "  valkey cluster_state=$state after 30 tries — STOP, do not proceed"; exit 1; }
  sleep 5
done

# --- Step 3: kagent with substrate enabled -----------------------------------
helm upgrade --install kagent-crds \
  oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
  --version "$KAGENT_VERSION" \
  --namespace kagent --create-namespace --wait

# kagent 0.10.0 takes the credential by SECRET REFERENCE. There is no
# providers.<p>.apiKey value any more (checked against the 0.10.0 chart's own
# values.yaml, which exposes provider/model/apiKeySecretRef/apiKeySecretKey).
# The old --set providers.openAI.apiKey=... silently set nothing. Create the
# secret first; the chart defaults already point at this name and key.
kubectl create namespace kagent --dry-run=client -o yaml | kubectl apply -f -

PROVIDER_SET=(--set controller.substrate.enabled=true \
  --set controller.substrate.ateApiEndpoint=dns:///api.ate-system.svc:443 \
  --set controller.substrate.ateApiInsecure=true \
  --set substrateWorkerPool.create=true \
  --set substrateWorkerPool.replicas=1 \
  --set substrateWorkerPool.ateomImage=ghcr.io/kagent-dev/substrate/ateom-gvisor:v${SUBSTRATE_VERSION})

if [[ "$PROVIDER" == "anthropic" ]]; then
  kubectl create secret generic kagent-anthropic \
    --namespace kagent \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
  PROVIDER_SET+=(--set providers.default=anthropic)
elif [[ "$PROVIDER" == "openai" ]]; then
  # Same secret-reference contract as anthropic. The chart's own defaults for
  # providers.openAI already point at secret kagent-openai / key OPENAI_API_KEY,
  # so only the secret and the model need supplying. Note the camelCase value
  # key: providers.default=openAI. Lowercase "openai" fails the render with
  #   Provider key=openai is not found under .Values.providers
  # which at least fails loudly, unlike the old providers.<p>.apiKey value.
  kubectl create secret generic kagent-openai \
    --namespace kagent \
    --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
  PROVIDER_SET+=(--set providers.default=openAI --set providers.openAI.model="${OPENAI_MODEL}")
else
  # Ollama needs no secret; the chart's default host, host.docker.internal:11434,
  # is exactly where kind on Docker Desktop finds a local Ollama.
  PROVIDER_SET+=(--set providers.default=ollama --set providers.ollama.model="${OLLAMA_MODEL}")
fi

helm upgrade --install kagent \
  oci://ghcr.io/kagent-dev/kagent/helm/kagent \
  --version "$KAGENT_VERSION" \
  --namespace kagent --timeout 10m --wait \
  "${PROVIDER_SET[@]}" \
  || kubectl wait deploy/kagent-controller -n kagent --for=condition=Available --timeout=10m

case "$PROVIDER" in
  anthropic) kubectl get secret kagent-anthropic -n kagent ;;
  openai)    kubectl get secret kagent-openai -n kagent ;;
esac
kubectl get pods -n kagent

# --- Step 4: SandboxAgent ----------------------------------------------------
kubectl apply -f - <<'YAML'
apiVersion: kagent.dev/v1alpha2
kind: SandboxAgent
metadata:
  name: hello-substrate
  namespace: kagent
spec:
  type: Declarative
  # NOTE: spec.platform was REMOVED in kagent 0.10.0's v1alpha2 SandboxAgent.
  # It was required by CEL validation in 0.9.x; in 0.10.0 the CRD rejects it with
  #   strict decoding error: unknown field "spec.platform"
  # Setting spec.substrate is now sufficient to place the agent on substrate.
  description: Tiny declarative agent running inside a substrate actor
  declarative:
    runtime: go
    modelConfig: default-model-config
    systemMessage: |
      You are a friendly assistant living inside an Agent Substrate sandbox.
      When asked who you are, say "I am hello-substrate, a Go ADK declarative
      agent running inside a gVisor actor."
  substrate:
    workerPoolRef:
      name: kagent-default
YAML

echo "Waiting for golden snapshot (~60-90s)..."
kubectl wait sandboxagent/hello-substrate -n kagent --for=condition=Ready --timeout=5m

cat <<'DONE'

Lab ready. Next:
  kubectl port-forward -n kagent svc/kagent-ui 8001:8080
  open http://localhost:8001  → chat with kagent/hello-substrate
  Ask: "What are you, and where are you running?"
  View → Substrate: watch the actor go Suspended between requests.

Cleanup: kind delete cluster --name kagent-substrate
DONE
