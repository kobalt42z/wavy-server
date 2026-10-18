#!/usr/bin/env bash
# Renders every kustomization in deploy/k8s and validates it:
#  1. the rules ConfigMap matches config/playback-rules.json
#  2. kubeconform schema check (strict, Kubernetes + CRDs for KEDA and the Prometheus Operator)
#  3. the spec's deployment rules (check-invariants.ts)
# Needs kustomize, kubeconform and bun on the PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
k8s_version="${KUBERNETES_VERSION:-1.31.0}"
crds='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

echo "• rules ConfigMap matches config/playback-rules.json"
if ! cmp -s "$repo/config/playback-rules.json" "$here/base/playback-rules.json"; then
  echo "  ✗ deploy/k8s/base/playback-rules.json differs from config/playback-rules.json"
  echo "    fix: cp config/playback-rules.json deploy/k8s/base/playback-rules.json"
  exit 1
fi

status=0
for dir in base overlays/hpa overlays/keda; do
  echo "• $dir"
  rendered="$(kustomize build "$here/$dir")"
  if ! printf '%s\n' "$rendered" | kubeconform -strict -summary \
      -kubernetes-version "$k8s_version" \
      -schema-location default -schema-location "$crds"; then
    status=1
  fi
  if ! printf '%s\n' "$rendered" | bun "$here/check-invariants.ts"; then
    status=1
  fi
done
exit "$status"
