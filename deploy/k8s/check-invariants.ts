// Checks the rendered manifests keep the spec's deployment rules.
// Usage: kustomize build deploy/k8s/overlays/hpa | bun deploy/k8s/check-invariants.ts
export {};

type Doc = Record<string, any>;

const input = await Bun.stdin.text();
const docs = ([] as Doc[]).concat(Bun.YAML.parse(input) as Doc | Doc[]).filter(Boolean);
const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);
const find = (kind: string) => docs.filter((d) => d.kind === kind);

const deployments = find("Deployment");
if (deployments.length !== 1) fail(`expected 1 Deployment, found ${deployments.length}`);

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
for (const pvc of find("PersistentVolumeClaim")) {
  if (JSON.stringify(pvc.spec.accessModes) !== '["ReadOnlyMany"]') fail(`PVC ${pvc.metadata.name}: must be ReadOnlyMany only`);
}
if (find("Secret").length > 0) fail("rendered output contains a Secret; credentials must not live in git");

// Sticky sessions.
for (const ing of find("Ingress")) {
  if (ing.metadata.annotations?.["nginx.ingress.kubernetes.io/affinity"] !== "cookie") {
    fail(`Ingress ${ing.metadata.name}: cookie affinity is missing`);
  }
}

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
