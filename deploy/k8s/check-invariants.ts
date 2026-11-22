// Checks the rendered manifests keep the spec's deployment rules.
// Usage: kustomize build deploy/k8s/overlays/hpa | bun deploy/k8s/check-invariants.ts
export {};

type Doc = Record<string, any>;

const input = await Bun.stdin.text();
const docs = ([] as Doc[]).concat(Bun.YAML.parse(input) as Doc | Doc[]).filter(Boolean);
const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);
const find = (kind: string) => docs.filter((d) => d.kind === kind);

// The playback service; components/s3-cache adds a second Deployment (wavy-cache).
const deployments = find("Deployment").filter((d) => d.metadata.name !== "wavy-cache");
if (deployments.length !== 1) fail(`expected 1 wavy-server Deployment, found ${deployments.length}`);

for (const dep of deployments) {
  const pod = dep.spec.template.spec;
  const name = dep.metadata.name;

  // Originals on the share are never modified.
  const mediaVolumes = (pod.volumes ?? []).filter((v: Doc) => v.persistentVolumeClaim);
  if (mediaVolumes.length === 0) fail(`${name}: no media volume`);
  for (const v of mediaVolumes) {
    if (v.persistentVolumeClaim.readOnly !== true) fail(`${name}: volume ${v.name} is not readOnly`);
  }
  for (const c of pod.containers) {
    for (const m of c.volumeMounts ?? []) {
      if (mediaVolumes.some((v: Doc) => v.name === m.name) && m.readOnly !== true) {
        fail(`${name}/${c.name}: mount ${m.mountPath} is not readOnly`);
      }
    }
    if (!(c.volumeMounts ?? []).some((m: Doc) => m.mountPath === "/media")) {
      fail(`${name}/${c.name}: share is not mounted at /media`);
    }

    // CPU requests equal limits to avoid CFS throttling.
    const { requests = {}, limits = {} } = c.resources ?? {};
    for (const r of ["cpu", "memory"]) {
      if (!requests[r] || String(requests[r]) !== String(limits[r])) {
        fail(`${name}/${c.name}: ${r} request (${requests[r]}) must equal limit (${limits[r]})`);
      }
    }

    // Probes on /healthz.
    for (const probe of ["readinessProbe", "livenessProbe"]) {
      if (c[probe]?.httpGet?.path !== "/healthz") fail(`${name}/${c.name}: ${probe} must hit /healthz`);
    }

    // Non-root.
    const runAsNonRoot = c.securityContext?.runAsNonRoot ?? pod.securityContext?.runAsNonRoot;
    if (runAsNonRoot !== true) fail(`${name}/${c.name}: must run as non-root`);
  }
}

for (const pv of find("PersistentVolume")) {
  if (pv.spec.csi?.driver !== "smb.csi.k8s.io") fail(`PV ${pv.metadata.name}: not on the SMB CSI driver`);
  if (pv.spec.csi?.readOnly !== true) fail(`PV ${pv.metadata.name}: csi.readOnly must be true`);
  if (JSON.stringify(pv.spec.accessModes) !== '["ReadOnlyMany"]') fail(`PV ${pv.metadata.name}: must be ReadOnlyMany only`);
}
for (const pvc of find("PersistentVolumeClaim").filter((p) => p.metadata.name !== "wavy-cache")) {
  if (JSON.stringify(pvc.spec.accessModes) !== '["ReadOnlyMany"]') fail(`PVC ${pvc.metadata.name}: must be ReadOnlyMany only`);
}

// components/s3-cache: the cache stays under its volume, is reachable only from
// wavy-server, runs locked down, and wavy-server is pointed at it.
const cache = find("Deployment").find((d) => d.metadata.name === "wavy-cache");
if (cache) {
  const toBytes = (q: string) => {
    const m = /^(\d+(?:\.\d+)?)([kmgt]i?)?$/i.exec(String(q).trim());
    if (!m) return NaN;
    const unit = (m[2] ?? "").toLowerCase().replace("i", "");
    return Number(m[1]) * 1024 ** (["", "k", "m", "g", "t"].indexOf(unit));
  };
  const c = cache.spec.template.spec.containers[0];
  const env = Object.fromEntries((c.env ?? []).map((e: Doc) => [e.name, e.value]));
  const pvc = find("PersistentVolumeClaim").find((p) => p.metadata.name === "wavy-cache");
  if (!pvc) fail("wavy-cache: no wavy-cache PersistentVolumeClaim");
  else {
    const cap = toBytes(env.WAVY_CACHE_MAX_SIZE);
    const disk = toBytes(pvc.spec.resources.requests.storage);
    if (!(cap > 0) || !(cap <= disk * 0.95)) {
      fail(`wavy-cache: WAVY_CACHE_MAX_SIZE (${env.WAVY_CACHE_MAX_SIZE}) must stay at most 95% of the volume (${pvc.spec.resources.requests.storage})`);
    }
  }
  if (cache.spec.replicas !== 1 || cache.spec.strategy?.type !== "Recreate") fail("wavy-cache: one replica with Recreate (the volume is ReadWriteOnce)");
  if (!env.WAVY_CACHE_HOSTS || env.WAVY_CACHE_HOSTS === ".*") fail("wavy-cache: WAVY_CACHE_HOSTS must list the bucket hosts");
  const runAsNonRoot = c.securityContext?.runAsNonRoot ?? cache.spec.template.spec.securityContext?.runAsNonRoot;
  if (runAsNonRoot !== true || c.securityContext?.readOnlyRootFilesystem !== true) fail("wavy-cache: must run non-root with a read-only root filesystem");
  for (const res of ["cpu", "memory"]) {
    if (String(c.resources?.requests?.[res]) !== String(c.resources?.limits?.[res])) fail(`wavy-cache: ${res} request must equal limit`);
  }
  const policy = find("NetworkPolicy").find((n) => n.spec?.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "wavy-cache");
  const from = policy?.spec?.ingress?.flatMap((i: Doc) => i.from ?? []) ?? [];
  if (!policy || from.length === 0 || !from.every((f: Doc) => f.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "wavy-server" && !f.namespaceSelector)) {
    fail("wavy-cache: a NetworkPolicy must allow ingress from wavy-server pods only");
  }
  const envMap = find("ConfigMap").find((m) => String(m.metadata.name).startsWith("wavy-server-env"));
  if (!String(envMap?.data?.REMOTE_CACHE_URL ?? "").startsWith("http://wavy-cache:")) fail("wavy-server-env: REMOTE_CACHE_URL must point at wavy-cache");
}
if (find("Secret").length > 0) fail("rendered output contains a Secret; credentials must not live in git");

// Playback needs an access token from the main server.
const envMaps = find("ConfigMap").filter((m) => String(m.metadata.name).startsWith("wavy-server-env"));
if (envMaps.length !== 1) fail(`expected 1 wavy-server-env ConfigMap, found ${envMaps.length}`);
for (const m of envMaps) {
  if (m.data?.AUTH_MODE !== "jwt") fail(`${m.metadata.name}: AUTH_MODE must be jwt (got ${m.data?.AUTH_MODE})`);
  if (!m.data?.JWT_JWKS_FILE && !m.data?.JWT_JWKS_URL) fail(`${m.metadata.name}: set JWT_JWKS_FILE or JWT_JWKS_URL`);
}

// Sticky sessions.
for (const ing of find("Ingress")) {
  if (ing.metadata.annotations?.["nginx.ingress.kubernetes.io/affinity"] !== "cookie") {
    fail(`Ingress ${ing.metadata.name}: cookie affinity is missing`);
  }
}
for (const proxy of find("HTTPProxy")) {
  for (const route of proxy.spec?.routes ?? []) {
    if (route.loadBalancerPolicy?.strategy !== "Cookie") {
      fail(`HTTPProxy ${proxy.metadata.name}: route without loadBalancerPolicy.strategy Cookie`);
    }
  }
}
if (find("Ingress").length + find("HTTPProxy").length === 0) fail("no Ingress or HTTPProxy: nothing routes browsers to their session's pod");

// Every namespaced object lands in the same namespace.
const clusterScoped = new Set(["Namespace", "PersistentVolume"]);
const namespaces = new Set(docs.filter((d) => !clusterScoped.has(d.kind)).map((d) => d.metadata.namespace));
if (namespaces.size !== 1 || namespaces.has(undefined)) fail(`objects span namespaces: ${[...namespaces].join(", ")}`);

// Overlays: autoscaling on active transcodes, not CPU, and at most one autoscaler.
const hpas = find("HorizontalPodAutoscaler");
const scaledObjects = find("ScaledObject");
if (hpas.length + scaledObjects.length > 1) fail("more than one autoscaler (use components/hpa or components/keda, not both)");
for (const hpa of hpas) {
  const names = (hpa.spec.metrics ?? []).map((m: Doc) => m.pods?.metric?.name ?? m.type);
  if (JSON.stringify(names) !== '["wavy_active_transcodes"]') fail(`HPA ${hpa.metadata.name}: must scale on wavy_active_transcodes only, got ${names}`);
}
for (const so of scaledObjects) {
  if (!so.spec.triggers?.every((t: Doc) => String(t.metadata?.query).includes("wavy_active_transcodes"))) {
    fail(`ScaledObject ${so.metadata.name}: must scale on wavy_active_transcodes`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`  ✓ invariants hold (${docs.length} objects)`);
