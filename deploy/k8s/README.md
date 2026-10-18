# Kubernetes deployment

Kustomize manifests for running the playback service on the CPU-only cluster:
the SMB share mounted read-only, `/metrics` scraping, autoscaling on active
transcodes, and sticky routing so each playback session stays on its pod.

```
deploy/k8s/
  base/                         Deployment, Service, Ingress, PDB, SMB PV/PVC, ConfigMaps
  components/hpa/               HPA on wavy_active_transcodes (via prometheus-adapter)
  components/keda/              KEDA ScaledObject on the same metric (alternative to hpa)
  components/prometheus-operator/  ServiceMonitor for /metrics
  overlays/hpa, overlays/keda   Example environments: copy one per cluster
  validate.sh                   Schema + rule checks (runs in CI)
```

## Prerequisites on the cluster

- [SMB CSI driver](https://github.com/kubernetes-csi/csi-driver-smb) (`smb.csi.k8s.io`).
- [ingress-nginx](https://kubernetes.github.io/ingress-nginx/) for cookie affinity.
- Prometheus. With the Prometheus Operator the overlays add a ServiceMonitor;
  otherwise drop that component and rely on the `prometheus.io/*` pod annotations.
- One autoscaler backend: [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter)
  (for `components/hpa`, rule in `components/hpa/prometheus-adapter-values.yaml`)
  or [KEDA](https://keda.sh) (for `components/keda`).

## Deploy

1. Copy an overlay, for example `cp -r deploy/k8s/overlays/hpa deploy/k8s/overlays/prod`,
   and set the share path (`//server/share`), the public host and the image tag.
   If your Prometheus isn't at `prometheus-operated.monitoring.svc:9090`, fix the
   address in the adapter values or the ScaledObject.
2. Create the namespace and the SMB credentials, using a **read-only** account on
   the file server. The Secret is never committed:

   ```bash
   kubectl create namespace wavy
   kubectl -n wavy create secret generic wavy-smb-credentials \
     --from-literal=username='svc-wavy-ro' --from-literal=password='...'
   # optional, for TLS on the ingress:
   kubectl -n wavy create secret tls wavy-server-tls --cert=tls.crt --key=tls.key
   ```

3. Apply: `kubectl apply -k deploy/k8s/overlays/prod`.

## How it maps to the spec

| Spec requirement | Where |
| --- | --- |
| Share mounted read-only at `/media` | `base/smb-storage.yaml` (PV `csi.readOnly`, `ReadOnlyMany`, `0444` file mode) and the pod volume and mount, both `readOnly` |
| Credentials in a Secret, read-only account | `wavy-smb-credentials`, created by hand (step 2) |
| Temp segments in `/tmp/sessions` (`emptyDir`) | `scratch` volume on `/tmp`, local disk with a 20 Gi cap |
| CPU requests = limits, ~600 MB per transcode + 200 MB | 4 CPU / 3 Gi per pod, sized for `MAX_TRANSCODES=4` |
| Autoscale on active transcodes, not CPU | `components/hpa` or `components/keda`, target 3 per pod |
| Sticky sessions | Ingress cookie `WAVY_AFFINITY`; Service `ClientIP` for in-cluster callers |
| Readiness and liveness on `/healthz` | `base/deployment.yaml` |
| Non-root | uid 10001, read-only root filesystem, all capabilities dropped |
| Rules in config, not code | `wavy-playback-rules` ConfigMap at `/etc/wavy/playback-rules.json` |

## Contract with the service

The manifests expect the service image to:

- listen on `PORT` (8080) and serve `/healthz` and `/metrics` there;
- read `MEDIA_ROOT`, `SESSIONS_DIR`, `RULES_PATH`, `MAX_TRANSCODES` and
  `SESSION_IDLE_TIMEOUT_SECONDS` from the environment (`base/kustomization.yaml`);
- export the gauge `wavy_active_transcodes` (full transcodes running on the pod);
- run as a non-root user and write only under `/tmp`.

## Decision table

`base/playback-rules.json` is a copy of `config/playback-rules.json` because
kustomize can't read files outside its folder. CI fails if they differ; after
changing the rules run `cp config/playback-rules.json deploy/k8s/base/`. Applying a
changed table rolls the pods (the ConfigMap name carries a content hash); no image
rebuild is needed. An overlay can override it with its own `configMapGenerator`
entry using `behavior: replace`.

## Sticky sessions and scaling

- A session's FFmpeg process and segments live on the pod that created it. The
  ingress sets the `WAVY_AFFINITY` cookie on the first response and routes the
  browser back to that pod. `affinity-mode: persistent` keeps existing browsers in
  place when new pods start, so new pods take new viewers.
- When the web app is on another origin, the player must send credentials so the
  cookie comes back (`xhrSetup: xhr => { xhr.withCredentials = true }` in hls.js),
  and the service must reply with `Access-Control-Allow-Credentials: true`.
- A pod at its transcode cap returns `503`. The ingress retries that request on
  another pod (up to 3 tries) and moves the cookie there.
- Scale-down is slow (one pod per 5 minutes after 10 quiet minutes) because a
  removed pod ends its sessions. The player recovers by starting a new session.

## Validate locally

Needs `kustomize`, `kubeconform` and `bun`:

```bash
deploy/k8s/validate.sh
```

It checks the rules copy, validates every build with kubeconform (strict, with CRD
schemas for KEDA and the ServiceMonitor) and checks the spec's rules (read-only
media, requests = limits, probes, cookie affinity, one autoscaler on
`wavy_active_transcodes`). CI also runs a server-side dry run on a kind cluster.
