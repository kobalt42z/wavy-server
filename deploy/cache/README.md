# S3 slice cache (wavy-cache)

A stock nginx in front of S3 that keeps the parts of media files wavy has read, so
files that make FFmpeg jump around (big camera AVIs, MP4s with the index at the end)
open fast, seeks are instant, and a second view reads almost nothing from S3.

```
browser ─> wavy-server (any replica) ─┬─> wavy-cache (nginx, 100 Gi disk) ─> S3
                                      └─> S3 directly, while wavy-cache is down
```

| File | What it is |
|---|---|
| `wavy-cache.conf.template` | The nginx site. The only real config; everything else is settings. |
| `wavy-cache.yaml` | Plain Kubernetes YAML: ConfigMap (the template above, embedded), PVC, Deployment, Service, NetworkPolicy. |

CI checks that the template embedded in `wavy-cache.yaml` equals
`wavy-cache.conf.template` and runs the template in real nginx (`test/cache.test.ts`).
If you edit one, edit the other.

## How it works

- Wavy asks for `http://wavy-cache:8080/<https>/<bucket host>/<version>/<key>?<signature>`.
  nginx strips the prefix and fetches `https://<bucket host>/<key>?<signature>` from S3.
- nginx's `slice` module fetches each file in **4 MB slices** (exact byte ranges) and
  only the slices that are read. They're stored on the disk. A read inside a stored
  slice never goes to S3.
- Slices are stored per object, not per link: a freshly signed link for the same file
  uses the same slices. `<version>` is a hash of the file's ETag, so a file that was
  overwritten in S3 gets new slices.
- Wavy still sends S3 one tiny request (1 byte) every time it opens a file. That's what
  refuses an expired or forged link even when the file is cached.
- **When the disk is full:** nothing waits or fails. nginx keeps the cache under
  `WAVY_CACHE_MAX_SIZE` (90g) by dropping the least recently used slices, and drops
  any slice nobody read for `WAVY_CACHE_INACTIVE` (24h).
- **When the cache is down:** wavy reads S3 directly and tries the cache again 30 s
  later. A running video switches on its next seek. Nothing to do by hand.
- **Security:** nginx only fetches from hosts matching `WAVY_CACHE_HOSTS` (others get
  403) and only answers GET. Because stored slices are served without asking S3, only
  wavy-server pods may connect to it (the NetworkPolicy).

## Deploy on Kubernetes (plain YAML)

You need: the `wavy` namespace with wavy-server already running, a storage class for a
100 Gi `ReadWriteOnce` volume (SSD is best), and a network plugin that enforces
NetworkPolicy (Calico, Cilium, ...). Without that plugin the policy is ignored and any
pod in the cluster could read cached files.

### 1. Get the nginx image

The cache is the official unprivileged nginx image (runs as uid 101, listens on 8080).
Nothing is built. If the cluster can pull from Docker Hub, skip this step.
Otherwise copy it into your registry:

```bash
docker pull nginxinc/nginx-unprivileged:1.28.0-alpine
docker tag  nginxinc/nginx-unprivileged:1.28.0-alpine registry.example.local/nginx-unprivileged:1.28.0-alpine
docker push registry.example.local/nginx-unprivileged:1.28.0-alpine
```

Then change the `image:` line in `wavy-cache.yaml` to your copy.

### 2. Edit `wavy-cache.yaml`

Three places, marked `CHANGE ME`:

- `WAVY_CACHE_HOSTS`: a regex for your bucket's host (plus `:port` if it has one). It
  must cover the same hosts as wavy's `REMOTE_ALLOWED_HOSTS`. Keep the single quotes
  and escape the dots:

  ```yaml
  - name: WAVY_CACHE_HOSTS
    value: '^evidence\.s3\.eu-west-1\.amazonaws\.com$'
  # several buckets:   '^(evidence|exports)\.s3\.eu-west-1\.amazonaws\.com$'
  # MinIO on a port:   '^minio\.internal:9000$'
  ```
- `storageClassName` on the PersistentVolumeClaim (uncomment it), or leave it for the
  cluster default.
- `image:` if you copied the image in step 1.

Leave the namespace as `wavy` (or change every `namespace:` line to yours). The
NetworkPolicy allows pods labelled `app.kubernetes.io/name: wavy-server`. If your
wavy-server pods carry a different label, change it there.

### 3. Apply and check it's up

```bash
kubectl apply -f wavy-cache.yaml
kubectl -n wavy rollout status deployment/wavy-cache
kubectl -n wavy logs deployment/wavy-cache        # no [emerg] lines

# from a wavy-server pod (the image has no curl; Bun can fetch):
kubectl -n wavy exec deploy/wavy-server -- bun -e \
  'console.log(await (await fetch("http://wavy-cache:8080/healthz")).text())'   # prints: ok
```

### 4. Point wavy-server at it

Add to wavy-server's settings ConfigMap (`wavy-server-env`):

```yaml
  REMOTE_ALLOWED_HOSTS: evidence.s3.eu-west-1.amazonaws.com   # bucket host(s), comma-separated
  REMOTE_CACHE_URL: http://wavy-cache:8080                     # read S3 files through the cache
  # REMOTE_CACHE_TIMEOUT_MS: "5000"                            # wait this long for the cache before going to S3
```

Apply it and restart wavy-server (it reads settings at start):

```bash
kubectl apply -f wavy.yaml
kubectl -n wavy rollout restart deployment/wavy-server
```

### 5. Check it works

Play an S3 file twice. The second time it should start faster, and:

```bash
kubectl -n wavy exec deploy/wavy-cache -- du -sh /var/cache/nginx/wavy   # grows as files are read
kubectl -n wavy logs deploy/wavy-server | grep remote_cache_unavailable   # empty = wavy uses the cache
```

To turn the cache off, remove `REMOTE_CACHE_URL` and restart wavy-server. Wavy then
reads S3 directly, as before.

## Run it with plain Docker (to try it, or outside Kubernetes)

Same image, same config file:

```bash
docker volume create wavy-cache-data
docker run -d --name wavy-cache -p 8080:8080 --read-only \
  --tmpfs /tmp:uid=101,gid=101 \
  --tmpfs /etc/nginx/conf.d:uid=101,gid=101 \
  -v "$PWD/wavy-cache.conf.template:/etc/nginx/templates/wavy-cache.conf.template:ro" \
  -v wavy-cache-data:/var/cache/nginx \
  -e WAVY_CACHE_HOSTS='^evidence\.s3\.eu-west-1\.amazonaws\.com$' \
  -e WAVY_CACHE_MAX_SIZE=90g -e WAVY_CACHE_INACTIVE=24h -e WAVY_CACHE_SLICE=4m \
  -e WAVY_CACHE_DIR=/var/cache/nginx/wavy \
  -e WAVY_CACHE_CA_FILE=/etc/ssl/certs/ca-certificates.crt \
  -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
  nginxinc/nginx-unprivileged:1.28.0-alpine

curl -s localhost:8080/healthz    # ok
```

The empty `/etc/nginx/conf.d` hides the image's default site, which also listens on
8080 and would answer requests addressed to `localhost` (including the `curl` above). Then run wavy
with `REMOTE_CACHE_URL=http://<that host>:8080`, and allow only wavy to reach that port.

## Changing settings

| Setting (Deployment env) | Default | Notes |
|---|---|---|
| `WAVY_CACHE_HOSTS` | (example bucket) | Regex of hosts it may fetch from. |
| `WAVY_CACHE_MAX_SIZE` | `90g` | Disk cap. Keep it about 10% under the volume (CI checks at most 95%). |
| `WAVY_CACHE_INACTIVE` | `24h` | Slices nobody read for this long are dropped. |
| `WAVY_CACHE_SLICE` | `4m` | Bigger means fewer S3 requests but more wasted bytes per jump. Changing it starts the cache from empty. |
| `WAVY_CACHE_DIR`, `WAVY_CACHE_CA_FILE` | | Paths inside the container; leave them. |

nginx reads the template and env only when it starts. After any change:
`kubectl apply -f wavy-cache.yaml && kubectl -n wavy rollout restart deployment/wavy-cache`.
The cached slices on the disk survive restarts.

To grow the disk, raise `storage:` on the PVC (if your storage class allows expansion)
and `WAVY_CACHE_MAX_SIZE` together, e.g. 200Gi and 180g.

There is one pod on purpose: the disk is `ReadWriteOnce`, and the Deployment uses
`Recreate` so the old pod lets go of it first. While it restarts (a few seconds), wavy
reads S3 directly.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Cache answers `403 origin host not allowed` | `WAVY_CACHE_HOSTS` doesn't match the bucket host (check dots are escaped and the port is included if the URL has one). |
| Cache answers 502 or 504; nginx log shows `could not be resolved` | DNS: `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` is missing. |
| nginx log shows `upstream SSL certificate verify error` | The bucket uses a private CA: mount its bundle and point `WAVY_CACHE_CA_FILE` at it. |
| wavy logs `remote_cache_unavailable` | wavy can't reach the cache: the pod is down, the Service name is wrong, or the NetworkPolicy label doesn't match wavy-server's pods. Playback still works through S3. |
| `[emerg] mkdir() ... Permission denied` | The disk isn't writable by uid 101: keep `fsGroup: 101` in the Deployment. |
