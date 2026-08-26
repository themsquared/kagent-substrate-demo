#!/usr/bin/env bash
# Lab 1: Agent Substrate + kagent + SandboxAgent on kind
# Source: https://kagent.dev/docs/kagent/examples/agent-substrate
# Chart existence validated 2026-08-26 (helm show chart, both OCI refs).
set -euo pipefail

SUBSTRATE_VERSION="0.0.6"
KAGENT_VERSION="0.9.9"      # must be >= 0.9.7 for substrate integration
CLUSTER_NAME="kagent-substrate"

# --- Preflight ---------------------------------------------------------------
for bin in kind kubectl helm docker; do
  command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }
done
[[ -n "${OPENAI_API_KEY:-}" ]] \
  && echo "OPENAI_API_KEY set (len=${#OPENAI_API_KEY})" \
  || { echo "OPENAI_API_KEY is empty — export it first"; exit 1; }

# --- Step 1: kind cluster ----------------------------------------------------
kind create cluster --name "$CLUSTER_NAME"

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

# --- Step 3: kagent with substrate enabled -----------------------------------
helm upgrade --install kagent-crds \
  oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds \
  --version "$KAGENT_VERSION" \
  --namespace kagent --create-namespace --wait

helm upgrade --install kagent \
  oci://ghcr.io/kagent-dev/kagent/helm/kagent \
  --version "$KAGENT_VERSION" \
  --namespace kagent --timeout 10m --wait \
  --set providers.openAI.apiKey="${OPENAI_API_KEY}" \
  --set providers.default=openAI \
  --set controller.substrate.enabled=true \
  --set controller.substrate.ateApiEndpoint=dns:///api.ate-system.svc:443 \
  --set controller.substrate.ateApiInsecure=true \
  --set substrateWorkerPool.create=true \
  --set substrateWorkerPool.replicas=1 \
  --set substrateWorkerPool.ateomImage=ghcr.io/kagent-dev/substrate/ateom-gvisor:v${SUBSTRATE_VERSION} \
  || kubectl wait deploy/kagent-controller -n kagent --for=condition=Available --timeout=10m

kubectl get secret kagent-openai -n kagent
kubectl get pods -n kagent

# --- Step 4: SandboxAgent ----------------------------------------------------
kubectl apply -f - <<EOF
apiVersion: kagent.dev/v1alpha2
kind: SandboxAgent
metadata:
  name: hello-substrate
  namespace: kagent
spec:
  type: Declarative
  platform: substrate   # required by CEL validation when spec.substrate is set
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
EOF

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
