# DevSecOps Lab — Kubernetes Extension: Solution

Captured from a live run on minikube v1.38.1 (Kubernetes v1.35.1, docker driver, 12 CPU /
8 GB) with kubectl v1.34.1, ingress-nginx v1.14.3 and metrics-server v0.8.1. Raw output is
committed under [`evidence/k8s/`](evidence/k8s/).

Part 1 (Docker Compose) is written up in [`SOLUTION.md`](SOLUTION.md).

> **Cluster note.** The measurements below span two cluster builds. Sections marked
> **✅ FIXED** were re-measured on a cluster recreated with `--cni=calico`, which was necessary
> because minikube's default bridge CNI silently ignores NetworkPolicy objects (K8s Task 2.4).
> Where a "before" and "after" measurement both appear, both are real captures.

---

## Remediation pass — Kubernetes issues found, then fixed

| # | Issue | Status | Section |
|---|---|---|---|
| 1 | `DATABASE_URL` built by YAML `$(VAR)` interpolation with no percent-encoding — an `openssl rand -base64` password containing `/` produced `ERR_INVALID_URL` and crash-looped the Node service | ✅ fixed | Pre-work |
| 2 | Ingress rewrite produced `/jobs/`, which FastAPI 307-redirected out of the service | ✅ fixed | Pre-work |
| 3 | NetworkPolicy accepted by the API server but **not enforced** by the CNI | ✅ fixed | Task 2.4 |
| 4 | Rolling update dropped 2/218 requests — no `preStop`, no graceful shutdown | ✅ fixed | Task 4.2 |
| 5 | `CHANGE-CAUSE` `<none>` on every revision | ✅ fixed | Task 4.2 |
| 6 | Secret password written a second time into `last-applied-configuration` | ✅ fixed | Task 5.1 |
| 7 | `readinessProbe` pointed at a `/health` that never touched the database | ✅ fixed | Task 6.2 |
| 8 | `commonLabels` injected labels into **selectors**, silently widening the NetworkPolicy's `podSelector` | ✅ fixed | Task 2.4 |

---

## Pre-work: two defects that stopped the cluster from working

### 1. `applications-service` crashed with `ERR_INVALID_URL`

Both pods went straight into `CrashLoopBackOff`:

```
code: 'ERR_INVALID_URL',
input: '*****REDACTED*****',
base: 'postgres://base'
    at initDB (/app/src/db.js:75:14)
```

The manifests built the connection string by YAML interpolation:

```yaml
- name: DATABASE_URL
  value: "postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)"
```

Kubernetes expands `$(VAR)` by **plain textual substitution with no encoding**. `README-k8s.md`
Step 3 instructs you to generate the password with `openssl rand -base64 20`, and the base64
alphabet includes `+`, `/` and `=`. A `/` inside the password terminates the authority
component of the URI, so the resulting string is malformed and `new URL()` rejects it.

This is not a minikube quirk — it would break any cluster, and it will break intermittently
depending on which characters `openssl` happens to emit, which is the worst kind of bug.

**Fix.** Remove the hand-built `DATABASE_URL` from both deployment manifests and let the
application compose the URL, percent-encoding the credentials — the same approach already used
for Docker secrets in Part 1 Task 6.1. `build_database_url()` in `jobs-service/app/database.py`
and `buildConnectionString()` in `applications-service/src/db.js` now resolve configuration in
precedence order: `DB_PASSWORD_FILE` → `DATABASE_URL` → discrete `POSTGRES_*` variables. The
manifests pass only the parts:

```yaml
- name: POSTGRES_HOST
  value: postgres
- name: POSTGRES_PORT
  value: "5432"
```

Encoding belongs in the one place that can do it correctly. YAML cannot.

### 2. `/api/jobs` returned 307 through the Ingress

The trailing-slash defect documented in `SOLUTION.md` reproduced here as predicted, because
the ingress `rewrite-target: /jobs/$2` produces `/jobs/` for both `/api/jobs` and
`/api/jobs/`:

```
GET /api/jobs          -> 307
GET /api/jobs/         -> 307
GET /api/applications/ -> 200 application/json
GET /                  -> 200 text/html
```

For Part 1 this was patched in the nginx config, but having to compensate in *every* proxy is
the signal that the fix belongs in the application. The README's own API reference documents
these endpoints **with** a trailing slash and the frontend calls them that way, so the route
declarations were simply wrong. `app/main.py` now registers the collection endpoints at both
`/jobs` and `/jobs/`. After the fix:

```
GET /api/jobs          -> 200 application/json
GET /api/jobs/         -> 200 application/json
GET /api/applications/ -> 200 application/json
GET /                  -> 200 text/html
```

No proxy compensates for it any more, and `test_jobs_collection_accepts_trailing_slash` guards
the behaviour in CI.

### Note on reaching the cluster from Windows

`minikube ip` returns `192.168.49.2`, but with the **docker driver on Windows that address is
inside the WSL2 network and is not routable from the host**:

```
$ curl http://192.168.49.2/api/jobs   ->  000 (unreachable)
```

minikube says so at startup: *"please run `minikube tunnel` and your ingress resources would be
available at 127.0.0.1"*. `minikube tunnel` needs an elevated shell, so all ingress testing
below instead used a port-forward to the ingress controller itself, which still exercises the
real controller, the real Ingress objects and the real rewrite rules:

```bash
kubectl port-forward -n ingress-nginx service/ingress-nginx-controller 18080:80
```

Port 18080 rather than 8080, because 8080 was already occupied on this host — the first attempt
silently returned a **403 from an unrelated application** rather than from the cluster, which is
a good reminder to verify *what* answered, not just that something did.

---

## Task 1 — Cluster Exploration (15 pts)

### 1.1 Inspect all objects (5 pts)

Full output in `evidence/k8s/01-inventory.txt`.

**READY ratio for each Deployment**

| Deployment | READY | UP-TO-DATE | AVAILABLE |
|---|---|---|---|
| `postgres` | 1/1 | 1 | 1 |
| `jobs-service` | 2/2 | 2 | 2 |
| `applications-service` | 2/2 | 2 | 2 |
| `frontend` | 2/2 | 2 | 2 |

**CLUSTER-IP of each Service**

| Service | Type | CLUSTER-IP | Port |
|---|---|---|---|
| `postgres` | ClusterIP | 10.96.121.28 | 5432 |
| `jobs-service` | ClusterIP | 10.101.55.34 | 8000 |
| `applications-service` | ClusterIP | 10.104.70.105 | 3001 |
| `frontend` | ClusterIP | 10.106.44.194 | 80 |

**Storage class assigned to `postgres-pvc`:** `standard`, provisioned by
`k8s.io/minikube-hostpath`, bound to `pvc-4c40ed67-175d-462f-afc8-1a6920eb30fd` (1Gi, RWO).

Ingress and HPA:

```
NAME                   CLASS   HOSTS   ADDRESS        PORTS
applications-ingress   nginx   *       192.168.49.2   80
frontend-ingress       nginx   *       192.168.49.2   80
jobs-ingress           nginx   *       192.168.49.2   80

NAME                       REFERENCE                         TARGETS                        MIN MAX REPLICAS
applications-service-hpa   Deployment/applications-service   cpu: 2%/60%, memory: 13%/75%    2   6   2
jobs-service-hpa           Deployment/jobs-service           cpu: 4%/60%, memory: 46%/75%    2   6   2

NAME              TYPE     DATA
postgres-secret   Opaque   3
```

### 1.2 Describe a Pod (5 pts)

**Which initContainer runs first and why?**

`wait-for-postgres`, a `busybox:1.36` container running `until nc -z postgres 5432; do sleep 2; done`.
It ran to `exitCode: 0, reason: Completed` before the application container started.

Init containers run to completion, in order, before any app container starts. This one exists
because Kubernetes has no equivalent of Compose's `depends_on: condition: service_healthy` —
pod startup order across Deployments is not orchestrated at all. Without it, `jobs-service`
would start while PostgreSQL was still initialising, fail to connect, and crash-loop until
backoff happened to align. The initContainer converts that race into a deterministic wait.

Note it only checks that the **TCP port is open**, not that PostgreSQL is ready to serve
queries — weaker than the `pg_isready` used in the Compose healthcheck. It is good enough here
because SQLAlchemy retries, but `pg_isready` would be strictly better.

**What the probes check, and the difference**

```
Liveness:   http-get http://:8000/health  delay=30s timeout=5s period=15s #failure=3
Readiness:  http-get http://:8000/health  delay=10s timeout=5s period=10s #failure=3
```

| | Readiness | Liveness |
|---|---|---|
| Question | "Can this pod serve traffic *right now*?" | "Is this container wedged and beyond recovery?" |
| On failure | Pod is removed from Service endpoints; **no restart** | **kubelet kills and restarts the container** |
| Recovery | Automatic once it passes again | Via restart, counted in `RESTARTS` |

Failing readiness is non-destructive: the pod stays alive and stops receiving traffic, which is
exactly right for a transient dependency outage or a slow start. Failing liveness is
destructive, so it should only test whether the process itself is stuck.

**A real problem with this configuration:** both probes point at the same `/health` endpoint,
which returns a hard-coded `{"status": "healthy"}` without touching the database. That was
demonstrated in Part 1 Task 2.3, where both API services kept reporting healthy while returning
500s with PostgreSQL down. Consequences here are worse than in Compose: readiness never fails,
so a pod that cannot reach the database is never removed from the Service endpoints and keeps
receiving traffic. The readiness probe should execute a real dependency check (`SELECT 1`)
while liveness stays shallow.

### 1.3 Exec into a pod (5 pts)

```
$ kubectl exec $POD -n jobboard -- id
uid=1000(appuser) gid=1000(appgroup) groups=1000(appgroup)

$ kubectl exec $APOD -n jobboard -- id
uid=1000(node) gid=1000(node) groups=1000(node)

$ kubectl exec $POD -n jobboard -- python3 -c "...urlopen('http://localhost:8000/health')"
{"status":"healthy","service":"jobs-service","version":"1.0.0"}
```

Worth noting: both containers run as UID 1000 **with a matching named user**, and that is a
direct result of the Part 1 hardening. The manifests pin `runAsUser: 1000`, which overrides the
image's `USER` regardless. The original Dockerfiles created their accounts with
`adduser --system`, which allocates from the 100–999 system range, so the pod would have run as
an anonymous UID 1000 with no `/etc/passwd` entry — `whoami` fails and any code resolving the
current user misbehaves. Aligning the image UIDs to 1000 in Task 1 removed that mismatch.

**DNS resolution**

```
postgres                              -> 10.96.121.28
postgres.jobboard                     -> 10.96.121.28
postgres.jobboard.svc.cluster.local   -> 10.96.121.28
jobs-service                          -> 10.101.55.34
applications-service                  -> 10.104.70.105
```

**Full DNS name of the postgres Service:** `postgres.jobboard.svc.cluster.local`
(`<service>.<namespace>.svc.<cluster-domain>`).

**Why the short name works.** Not magic — it is the resolver search path:

```
$ kubectl exec $POD -n jobboard -- cat /etc/resolv.conf
nameserver 10.96.0.10
search jobboard.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`10.96.0.10` is the CoreDNS Service. `ndots:5` means any name with fewer than 5 dots is first
tried against each `search` suffix, so a lookup of `postgres` is attempted as
`postgres.jobboard.svc.cluster.local` and resolves on the first try. It also explains why the
partial form `postgres.jobboard` works. The `search` list is namespace-specific, which is why a
short name reaches the Service in *this* namespace — cross-namespace access requires at least
`<service>.<namespace>`.

(A side effect of `ndots:5` worth knowing: external names like `api.github.com` have only 2
dots, so they are tried against all three suffixes first and generate three failed lookups
before the real one. It is a common source of DNS latency in busy clusters.)

---

## Task 2 — Kubernetes Networking & Ingress (20 pts)

### 2.1 Trace an Ingress request (8 pts)

Journey of `POST http://<ingress>/api/applications/` (`evidence/k8s/04-ingress-trace.txt`):

**1. Which Ingress matches.** `applications-ingress`, via
`path: /api/applications(/|$)(.*)` with `pathType: ImplementationSpecific` and
`nginx.ingress.kubernetes.io/use-regex: "true"`. The ingress-nginx controller compiles all
three Ingress objects into one nginx config; the regex location wins over
`frontend-ingress`'s `pathType: Prefix` on `/`.

**2. What `rewrite-target` transforms the path to.** The annotation is
`nginx.ingress.kubernetes.io/rewrite-target: /applications/$2`. The path regex has two capture
groups — `$1` is `/` or empty, `$2` is the remainder. For `/api/applications/`, `$2` is empty,
so the upstream receives **`/applications/`**. Express treats `/applications` and
`/applications/` as the same route, so this is harmless — unlike the jobs-service, where the
identical pattern caused the 307 documented above.

**3. Which Service and port.** `applications-service:3001` (ClusterIP `10.104.70.105`).

**4. Which Pod, and how.** The Service's `selector: app: applications-service` matches pod
labels; the endpoints controller maintains the backing list:

```
$ kubectl get endpoints applications-service -n jobboard
applications-service   10.244.0.18:3001,10.244.0.20:3001

NAME                                    IP            LABELS
applications-service-5b5f66b9bd-47lh2   10.244.0.18   applications-service
applications-service-5b5f66b9bd-mvwx2   10.244.0.20   applications-service
```

ingress-nginx bypasses the ClusterIP and load-balances **directly across pod IPs** it reads
from the endpoints, so kube-proxy is not in the data path for ingress traffic.

**5. The response.**

```
< HTTP/1.1 201 Created
< Content-Type: application/json; charset=utf-8
< X-Powered-By: Express          <- confirms the Node upstream served it
< Access-Control-Allow-Origin: *
```

The Express handler validated the body, `INSERT ... RETURNING *` wrote the row, and the reply
travelled back through the controller to the client on the same keep-alive connection.

### 2.2 Why three Ingress objects? (4 pts)

**What `rewrite-target` does and why there can be only one per object.**
`nginx.ingress.kubernetes.io/rewrite-target` sets the path the upstream receives, and it is an
**annotation on the Ingress object**. Annotations are a flat key/value map, so the key can hold
exactly one value, and it applies to *every* path rule in that object. There is no per-path
form of the annotation.

**What would break with both paths in one Ingress.** One `rewrite-target` would have to serve
both, so whichever value is chosen corrupts the other route. With `/jobs/$2`, a request for
`/api/applications/` would be rewritten to `/jobs/` and sent to the applications-service, which
has no `/jobs` route — every applications request would 404. The failure is silent at deploy
time: the manifest is valid and the controller accepts it.

**An alternative architecture allowing a single Ingress.** Have the services own their public
path prefixes, so no rewriting is needed. FastAPI supports this natively with
`FastAPI(root_path="/api/jobs")`, and Express with `app.use('/api/applications', router)`. The
Ingress then becomes plain prefix routing with no annotations:

```yaml
- path: /api/jobs
  backend: { service: { name: jobs-service, port: { number: 8000 } } }
- path: /api/applications
  backend: { service: { name: applications-service, port: { number: 3001 } } }
```

This is generally the better design: it removes an entire class of rewrite bugs (including the
307 above), and the URL a service sees matches the URL the client requested, which makes logs
and generated links correct. The cost is that services are no longer mountable at an arbitrary
prefix without reconfiguration.

### 2.3 NodePort vs ClusterIP vs LoadBalancer (4 pts)

| Type | Reachable from | Use case | Example in this lab |
|---|---|---|---|
| **ClusterIP** | Inside the cluster only, via the virtual IP and DNS name | Internal service-to-service traffic; the default and the right choice for anything not public | All four services: `postgres`, `jobs-service`, `applications-service`, `frontend` |
| **NodePort** | Outside, on `<any-node-IP>:30000-32767` | Bare-metal clusters with no load balancer, or quick debugging. Awkward in production: high-numbered ports, one port per service, clients must know a node IP | Demonstrated by patching `frontend`, which received port **31515** |
| **LoadBalancer** | Outside, via a cloud provider's external IP | The standard way to expose a service publicly on a managed cloud. Provisions a real LB per service, which gets expensive | None. On minikube it would stay `<pending>` forever without `minikube tunnel` |
| **Ingress** | Outside, via HTTP(S) through a controller | L7 routing: many hostnames and paths behind **one** entry point, with TLS termination, rewrites and rate limits | `jobs-ingress`, `applications-ingress`, `frontend-ingress` — all three share the single controller |

Ingress is not a Service type; it is a separate resource that routes to ClusterIP Services. That
is precisely why all four services here can stay ClusterIP while the app is still reachable.

Live demonstration:

```
$ kubectl patch svc frontend -n jobboard -p '{"spec":{"type":"NodePort"}}'
service/frontend patched
NAME       TYPE       CLUSTER-IP      PORT(S)
frontend   NodePort   10.106.44.194   80:31515/TCP

$ kubectl patch svc frontend -n jobboard -p '{"spec":{"type":"ClusterIP"}}'
NAME       TYPE        CLUSTER-IP      PORT(S)
frontend   ClusterIP   10.106.44.194   80/TCP
```

Note the ClusterIP was preserved across both changes — NodePort is additive, layering a
node-level port on top of the existing virtual IP rather than replacing it.

### 2.4 Network Policies (4 pts, Hard)

Written to [`k8s/09-network-policy.yaml`](k8s/09-network-policy.yaml).

The key concept is that **there is no explicit deny rule to write**. Kubernetes networking is
default-allow, but the moment any NetworkPolicy selects a pod, that pod becomes default-deny
for the listed `policyTypes` and only explicitly matched traffic is admitted. So allowing the
two API services simultaneously denies everything else.

```yaml
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
    - Ingress          # egress deliberately unrestricted: locking it down without
                       # a DNS rule is a classic way to break a cluster
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: jobs-service
      ports: [{ protocol: TCP, port: 5432 }]
    - from:
        - podSelector:
            matchLabels:
              app: applications-service
      ports: [{ protocol: TCP, port: 5432 }]
```

A subtlety worth flagging: entries within a single `from` list are OR-ed, but `podSelector` and
`namespaceSelector` inside the **same list item** are AND-ed. Getting that wrong silently
produces a policy far broader or narrower than intended.

**Measured enforcement, first attempt — the policy did nothing.** As the lab's own note warns,
this was the initial observation on minikube's default bridge CNI:

```
$ kubectl get networkpolicy -n jobboard
postgres-network-policy   app=postgres   ...

TEST A: unauthorised busybox pod -> postgres:5432   (policy says DENY)
RESULT: CONNECTED (policy NOT enforced)

TEST B: jobs-service pod -> postgres:5432           (policy says ALLOW)
RESULT: CONNECTED (as intended)
```

Test A **should** have been blocked. The API server accepted and stored the object, and
`kubectl get` displayed it, but minikube's default bridge CNI does not implement the
NetworkPolicy API, so nothing enforced it. No policy-capable CNI pod existed in `kube-system`.

This is a genuinely dangerous failure mode: the policy looks correct in every `kubectl` output
and in any GitOps diff, while providing zero protection. Verifying enforcement, rather than
existence, is the only way to know.

### ✅ FIXED — cluster rebuilt on Calico, policy now enforces

An unenforced security control is worse than none, because it manufactures false confidence.
The cluster was therefore recreated with a policy-capable CNI:

```bash
minikube delete
minikube start --cpus=4 --memory=4096 --driver=docker \
  --cni=calico --addons=ingress,metrics-server
kubectl wait --for=condition=ready pod -l k8s-app=calico-node -n kube-system --timeout=300s
```

Re-measured on the Calico cluster (`evidence/21-networkpolicy-enforced.txt`):

```
--- CNI in use ---
  calico-node: Running

TEST 1: unlabelled busybox pod -> postgres:5432       BLOCKED (policy enforced)
TEST 2: jobs-service          -> postgres:5432       CONNECTED (allowed as intended)
TEST 3: applications-service  -> postgres:5432       CONNECTED (allowed as intended)
TEST 4: end-to-end through the policy                jobs returned: 5
```

Test 1 is now refused, which is the entire point of the policy, while both authorised services
are unaffected and the application still works end to end. **The manifest was never changed —
it was correct all along.** Only the cluster's CNI was wrong, which is precisely why
enforcement has to be tested rather than assumed.

Calico, Cilium, Antrea and most managed CNIs (GKE Dataplane V2, AKS Azure CNI, EKS with Calico)
implement it. On a cluster where enforcement matters, pair the policy with a test that asserts
the deny path, exactly like Test A above.

---

## Task 3 — Persistent Storage & Data Lifecycle (15 pts)

### 3.1 Inspect the PersistentVolumeClaim (5 pts)

```
Name:          postgres-pvc         Status:  Bound
StorageClass:  standard             Capacity: 1Gi
Access Modes:  RWO                  VolumeMode: Filesystem
Volume:        pvc-4c40ed67-175d-462f-afc8-1a6920eb30fd
Used By:       postgres-5b8d74874c-p5vcb
Provisioner:   k8s.io/minikube-hostpath

ReclaimPolicy = Delete
AccessModes   = ["ReadWriteOnce"]
HostPath      = /tmp/hostpath-provisioner/jobboard/postgres-pvc
```

**Reclaim policy of the bound PV: `Delete`**, inherited from the `standard` StorageClass.

**`Retain` vs `Delete` when the PVC is deleted**

| | `Delete` | `Retain` |
|---|---|---|
| PV object | Removed automatically | Kept, moves to `Released` |
| Underlying storage | **Destroyed** | Preserved |
| Reuse | N/A | Requires an admin to clear `claimRef` before it can bind again |

With `Delete` — the setting on this cluster — `kubectl delete pvc postgres-pvc` destroys the
database irreversibly. For production data `Retain` is the safer default: it turns an accidental
`kubectl delete` into a recoverable inconvenience rather than data loss. The trade-off is that
released volumes accumulate and must be reclaimed manually.

Note also `HostPath: /tmp/hostpath-provisioner/...`. On minikube the data sits under `/tmp`
**inside the minikube container**, so it does not survive `minikube delete`, and on some setups
not even a host reboot. Fine for a lab, and a good illustration of why the StorageClass matters
as much as the PVC.

**Access mode `ReadWriteOnce`, and why PostgreSQL cannot use `ReadWriteMany`**

`ReadWriteOnce` means the volume is mounted read-write by a single **node** (since Kubernetes
1.22, `ReadWriteOncePod` restricts to a single pod). `ReadWriteMany` would allow many nodes to
mount it simultaneously.

PostgreSQL must not use RWX. A PostgreSQL data directory is owned by exactly one running
instance: the server assumes exclusive control over the heap files, WAL and shared buffers, and
coordinates via a `postmaster.pid` lock that only guards against processes that can see it. Two
instances writing the same directory produce immediate, unrecoverable corruption. Network
filesystems typically backing RWX (NFS, CIFS) also tend to have unreliable `fsync` and locking
semantics, which breaks the durability guarantees the WAL depends on. Scaling PostgreSQL means
replication — separate volumes per instance — never a shared filesystem.

This is also why the Deployment sets `strategy: type: Recreate`, confirmed live. With
`RollingUpdate`, the new pod would be created before the old one terminated, and the second pod
could not attach the RWO volume — it would hang in `ContainerCreating` while the rollout stalled.
`Recreate` terminates the old pod first, accepting brief downtime in exchange for correctness.

### 3.2 Verify data persistence across pod restarts (5 pts)

`evidence/k8s/07-persistence.txt`:

```
1. created via the ingress:
   { "id": "7e3d3efc-773f-4d2e-8c20-520a13a66cd4", "title": "K8s Persistence Test", ... }
   count before: 6
   postgres pod before: postgres-5b8d74874c-p5vcb

2. $ kubectl delete pod -l app=postgres -n jobboard
   pod "postgres-5b8d74874c-p5vcb" deleted

3. postgres pod after:  postgres-5b8d74874c-jrtzf   (a genuinely different pod)

4. count after: 6
   K8s Persistence Test present: True
   id: 7e3d3efc-773f-4d2e-8c20-520a13a66cd4      <- same UUID
```

**Why the data survived.** The pod is disposable; the PVC is not. The container filesystem is
ephemeral and was destroyed with the pod, but `/var/lib/postgresql/data` is a mount of
`postgres-pvc`, whose lifecycle is bound to the *claim*, not the pod. When the Deployment's
ReplicaSet created a replacement, the scheduler attached the same PersistentVolume and
PostgreSQL opened the existing data directory — identical UUID, so this is the original row and
not a re-seed.

The `Recreate` strategy is what makes this work cleanly: the old pod fully released the RWO
volume before the new pod claimed it. Note the replacement pod name shares the ReplicaSet hash
(`5b8d74874c`) — deleting a pod does not create a new ReplicaSet, it just triggers the existing
one to reconcile back to its replica count.

### 3.3 Manual database backup from Kubernetes (5 pts)

**Backup**

```bash
PG_POD=$(kubectl get pods -n jobboard -l app=postgres -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n jobboard $PG_POD -- \
  sh -c 'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -U $POSTGRES_USER -d $POSTGRES_DB --no-owner --no-acl' \
  > k8s-backup-$(date +%Y%m%d_%H%M%S).sql
```

```
created: k8s-backup-20260805_090453.sql (4335 bytes, 114 lines)
jobs rows in dump: 6
```

The credentials are read from the pod's own environment inside the `sh -c`, so they are never
written into the local shell's history or process list. As in Part 1, the lab's suggested
`grep -c "INSERT INTO"` check returns 0 — `pg_dump` emits `COPY` blocks by default.

**Restore procedure — executed, not merely written** (`evidence/k8s/09-restore.txt`)

```bash
PG_POD=$(kubectl get pods -n jobboard -l app=postgres -o jsonpath='{.items[0].metadata.name}')

# 1. Create an empty target database
kubectl exec -n jobboard $PG_POD -- sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d postgres -c "CREATE DATABASE restore_test;"'

# 2. Copy the dump into the pod
kubectl cp k8s-backup-20260805_090453.sql jobboard/$PG_POD:/tmp/restore.sql

# 3. Restore. ON_ERROR_STOP=1 is essential: without it psql reports success
#    even when individual statements failed.
kubectl exec -n jobboard $PG_POD -- sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d restore_test -v ON_ERROR_STOP=1 -f /tmp/restore.sql'
```

Verified empty first (`Did not find any relations.`), then:

```
CREATE TABLE / CREATE TABLE / COPY 1 / COPY 6 / ALTER TABLE ... / CREATE INDEX ...

 restored_jobs        live_jobs
---------------      -----------
             6                6
```

To restore over the **live** database instead of a scratch one, scale the API services to zero
first so nothing writes mid-restore, then either `DROP`/`CREATE` the database or use
`pg_restore --clean`:

```bash
kubectl scale deployment jobs-service applications-service --replicas=0 -n jobboard
# ... restore ...
kubectl scale deployment jobs-service --replicas=2 -n jobboard
kubectl scale deployment applications-service --replicas=2 -n jobboard
```

`kubectl cp` requires `tar` in the container image — worth knowing before relying on it, since
distroless and scratch images have no shell or tar and need `kubectl exec ... -i < file` instead.

---

## Task 4 — Scaling & Rolling Updates (25 pts)

### 4.1 Manual scaling (5 pts)

```
$ kubectl scale deployment jobs-service --replicas=4 -n jobboard
NAME                            IP            STATUS
jobs-service-85776b584d-2zw8f   10.244.0.33   Running
jobs-service-85776b584d-ckp56   10.244.0.31   Running
jobs-service-85776b584d-ndrcl   10.244.0.32   Running
jobs-service-85776b584d-t8hhh   10.244.0.30   Running

$ kubectl get endpoints jobs-service -n jobboard
10.244.0.30:8000,10.244.0.31:8000,10.244.0.32:8000 + 1 more...
```

**How the Ingress distributes traffic across 4 replicas.** ingress-nginx watches the
Service's EndpointSlices and maintains an nginx `upstream` block containing the **pod IPs
directly**. New pods appear in the upstream as soon as they pass their readiness probe, without
an nginx reload in recent versions (the endpoints are updated through the Lua balancer). Traffic
does not traverse the ClusterIP at all for ingress requests.

**Default load-balancing algorithm.** `round_robin`, weighted by endpoint. It can be changed
per-Ingress with `nginx.ingress.kubernetes.io/load-balance` (`ewma` for least-latency, or
`ip_hash`-style session affinity via `nginx.ingress.kubernetes.io/affinity: cookie`).

**Scaling back to 2 — what happens to in-flight requests?**

```
$ kubectl scale deployment jobs-service --replicas=2 -n jobboard
$ kubectl get endpoints jobs-service -n jobboard
10.244.0.30:8000,10.244.0.31:8000
```

In principle: the two doomed pods enter `Terminating`, are removed from the EndpointSlice, and
receive `SIGTERM`; Kubernetes then waits `terminationGracePeriodSeconds` (default 30) before
`SIGKILL`. In practice there is a race, because **endpoint removal and SIGTERM delivery happen
concurrently and asynchronously**. The controller may still route a request to a pod that has
already begun shutting down. That is not theoretical here — it was measured in 4.2 below.

### 4.2 Rolling update (10 pts)

To make the rollout observable, `GET /health` now reports a build-time version
(`ARG APP_VERSION` in the Dockerfile, surfaced by `app/main.py`), so `jobs-service:v2` is
genuinely distinguishable from `:latest` rather than being an identical rebuild.

A probe pod polled `http://jobs-service:8000/health` every 0.3s throughout the rollout.

**Measured result — 216/218 succeeded, 2 failed:**

```
probe requests total : 218
  HTTP 200           : 216
  non-200 / failures : 2

83  code=000
119 code=000
```

The version transition confirms the rollout was real, flapping between old and new while both
were in the endpoint set, then settling:

```
81 x ver=1.0.0
   ... interleaved 1.0.0 / 2.0.0 during the transition ...
100 x ver=2.0.0
```

**This is not the "zero downtime" the lab predicts, and the discrepancy is worth being precise
about.** `maxSurge: 1, maxUnavailable: 0` guarantees *capacity* is never reduced — a new pod is
Ready before an old one is removed — but it does not guarantee that no in-flight request fails,
because:

1. Endpoint removal propagates asynchronously to the ingress controller and kube-proxy. For a
   brief window a terminating pod is still a valid target.
2. The pods have **no `preStop` hook and no graceful-shutdown handling**. uvicorn receives
   `SIGTERM` and begins shutting down immediately, dropping connections that arrive in that
   window.

Two failures in 218 requests (0.9%) over a ~10s window is unremarkable for a lab, but at
production request rates it is a meaningful error-budget spend on every deploy.

### ✅ FIXED — zero downtime achieved and re-measured

Rather than leave this as a documented caveat, the fix was applied. Three changes:

1. **`preStop` hook** on all three deployments, keeping the container serving while endpoint
   removal propagates to the ingress controller and kube-proxy:

   ```yaml
   lifecycle:
     preStop:
       exec:
         command: ["sh", "-c", "sleep 8"]
   terminationGracePeriodSeconds: 30
   ```

2. **Graceful SIGTERM handling in the Node service** (`applications-service/src/index.js`).
   Node does *not* handle `SIGTERM` by default — the process dies instantly and every
   in-flight request is dropped. It now calls `server.close()` to stop accepting new
   connections while letting existing ones finish, then drains the `pg` pool, with a 15s
   failsafe that stays inside the 30s grace period. uvicorn already drains on `SIGTERM`, so
   the Python service needed only the `preStop` hook.

3. **Readiness moved to `/ready`** (see Task 5 below), so a pod that cannot reach PostgreSQL
   is withdrawn from the endpoint set instead of receiving traffic it cannot serve.

**A correction on measurement method, because the first re-test was wrong.** Probing through
`kubectl port-forward service/jobs-service` reported 25 failures out of 85 — but that is an
artifact, not downtime: `port-forward` pins to a *single* backing pod, so the tunnel breaks
when that pod is replaced. The giveaway was `v2=0` — the probe never observed the new version
at all, so it cannot have been measuring the Service. The valid probe runs **inside** the
cluster against the Service, seeing the same load balancing a real client would.

**Re-measured result — 400/400 succeeded, 0 failed** (`evidence/22-zero-downtime-fix.txt`):

```
--- 400 sequential requests to http://jobs-service:8000/health from an in-cluster pod ---
--- rollout to jobs-service:v2 triggered mid-run ---

RESULT ok=400 fail=0 v1=199 v2=201
```

The near-even 199/201 split across versions is the important detail: it proves the probe
genuinely spanned the rollout and observed the version flip, rather than completing before the
rollout began. Zero failed requests across a real transition.

Settings confirmed live on the cluster:

```
$ kubectl get deployment jobs-service -n jobboard -o jsonpath='{.spec.strategy}'
{"rollingUpdate":{"maxSurge":1,"maxUnavailable":0},"type":"RollingUpdate"}

terminationGracePeriodSeconds=30
preStop=["sh","-c","sleep 8"]
livenessProbe=/health      <- shallow
readinessProbe=/ready      <- DB-backed
```

**What `maxSurge: 1, maxUnavailable: 0` means.** `maxSurge` is how many pods above the desired
count may exist during the update; `maxUnavailable` is how many below the desired count of
*Ready* pods is tolerated. `0` unavailable means full capacity is maintained throughout, at the
cost of temporarily needing resources for `replicas + 1`.

**Timeline for `replicas: 2, maxSurge: 1, maxUnavailable: 0`:**

```
t0   [v1-a Ready] [v1-b Ready]                     2 Ready — at desired count
t1   [v1-a Ready] [v1-b Ready] [v2-a Pending]      surge to 3; maxUnavailable=0 forbids
                                                   killing anything first
t2   [v1-a Ready] [v1-b Ready] [v2-a Ready]        v2-a passes readiness, joins endpoints
t3   [v1-a Term ] [v1-b Ready] [v2-a Ready]        only now may an old pod be removed
                                                   <-- the 2 failures occurred in this window
t4                [v1-b Ready] [v2-a Ready]        back to 2
t5                [v1-b Ready] [v2-a Ready] [v2-b Pending]
t6                [v1-b Term ] [v2-a Ready] [v2-b Ready]
t7                              [v2-a Ready] [v2-b Ready]   rollout complete
```

Ready count never drops below 2; total never exceeds 3.

**Rollback**

```
$ kubectl rollout history deployment/jobs-service -n jobboard
REVISION  CHANGE-CAUSE
1..6      <none>

$ kubectl get deployment jobs-service -o jsonpath='{...image}'
jobs-service:v2

$ kubectl rollout undo deployment/jobs-service -n jobboard
deployment.apps/jobs-service rolled back

jobs-service:latest
{"status":"healthy","service":"jobs-service","version":"1.0.0"}
```

Confirmed by the served version reverting to 1.0.0. `rollout undo` works by scaling the
previous ReplicaSet back up — old ReplicaSets are retained (bounded by
`revisionHistoryLimit`, default 10) precisely for this, which is why `kubectl get all` lists
several 0-replica ReplicaSets.

`CHANGE-CAUSE` was `<none>` for every revision, which makes the history close to useless — you
can see *that* six rollouts happened but not *what* any of them changed, so choosing a revision
to roll back to becomes guesswork.

**✅ FIXED.** The `deploy-to-k8s` job in `.github/workflows/ci.yml` now annotates each
deployment as part of the rollout, recording the commit SHA, the triggering event, the actor
and a link back to the commit:

```yaml
kubectl annotate "deployment/$svc" -n "$NS" --overwrite \
  "kubernetes.io/change-cause=${TAG} | ${{ github.event_name }} by ${{ github.actor }} | ${{ github.server_url }}/${{ github.repository }}/commit/${TAG}"
```

Verified against a real rollout (`evidence/22-zero-downtime-fix.txt`):

```
$ kubectl rollout history deployment/jobs-service -n jobboard
REVISION  CHANGE-CAUSE
3         jobs-service:v2 | manual rollout to verify zero-downtime fix
4         jobs-service:v2 | zero-downtime verification after preStop fix
```

(`--record` is deprecated, which is why the explicit `kubectl annotate` is used instead.)

### 4.3 HorizontalPodAutoscaler (10 pts)

Baseline first, because a memory target of 75% against a 128Mi request could have pinned the
HPA at max regardless of load. It did not — idle usage was ~15Mi (~12%), so CPU is the driver:

```
idle: cpu 1-2% of request, memory ~12% of request
```

Under load from a busybox generator hammering `/jobs`:

```
$ kubectl get hpa jobs-service-hpa -n jobboard
NAME               TARGETS                          MINPODS MAXPODS REPLICAS
jobs-service-hpa   cpu: 170%/60%, memory: 46%/75%   2       6       6

Events:
  Normal  SuccessfulRescale  4m28s  New size: 4; reason: cpu resource utilization above target
  Normal  SuccessfulRescale  3m28s  New size: 6; reason: cpu resource utilization above target

Conditions:
  ScalingLimited  True  TooManyReplicas  the desired replica count is more than the maximum
```

Scaled **2 → 4 → 6** in two steps exactly 60s apart, matching the configured
`scaleUp` policy of 2 pods per 60 seconds, then clamped at `maxReplicas`.

**The formula.**

```
desiredReplicas = ceil( currentReplicas × ( currentMetricValue / desiredMetricValue ) )
```

At the observed 170% against a 60% target with 4 replicas:
`ceil(4 × (170/60)) = ceil(11.3) = 12`, clamped to `maxReplicas: 6` — hence
`ScalingLimited: TooManyReplicas`. A tolerance (default 10%) suppresses changes when the ratio
is within 0.9–1.1, preventing churn near the target. With multiple metrics, the HPA computes a
recommendation for each and takes the **highest**.

**`stabilizationWindowSeconds` and why it matters for scale-down.** The controller considers
all recommendations within the window and acts on the most conservative one — for scale-down,
the *highest* recent recommendation. Configured here:

```
Scale Up:   Stabilization Window: 60 seconds   Policy: 2 pods / 60s
Scale Down: Stabilization Window: 300 seconds  Policy: 1 pod / 120s
```

The asymmetry is deliberate. Scaling up late costs latency or errors, so it is fast. Scaling
down early risks thrashing: a bursty workload would repeatedly remove pods and immediately
recreate them, and each new pod pays cold-start cost while adding load to the survivors — a
feedback loop that can amplify into an outage. Five minutes of "load really has gone" before
releasing capacity is cheap insurance.

**If `metrics-server` is not installed.** The HPA cannot read metrics, `TARGETS` shows
`<unknown>/60%`, and replicas stay at whatever they are — the HPA does **not** scale to zero or
to max, it simply stops acting. This state was actually observed transiently during pod
restarts:

```
Warning  FailedGetResourceMetric       failed to get cpu utilization: unable to get metrics
                                       for resource cpu: no metrics returned from resource metrics API
Warning  FailedComputeMetricsReplicas  invalid metrics (2 invalid out of 2)
```

Diagnosis:

```bash
kubectl describe hpa jobs-service-hpa -n jobboard   # look at Conditions and Events
kubectl top pods -n jobboard                        # fails outright if metrics-server is absent
kubectl get deployment metrics-server -n kube-system
kubectl get apiservice v1beta1.metrics.k8s.io       # must be Available
minikube addons enable metrics-server
```

A subtlety: `<unknown>` also appears when a Deployment's pods have **no CPU `requests`**, since
utilisation is a percentage *of request*. That is a configuration error rather than a missing
metrics-server, and `describe hpa` distinguishes them.

---

## Task 5 — Secrets & ConfigMaps (10 pts)

### 5.1 Inspect the Secret (4 pts)

```
$ kubectl get secret postgres-secret -n jobboard -o yaml
data:
  POSTGRES_DB: am9iYm9hcmQ=
  POSTGRES_USER: cG9zdGdyZXM=
  POSTGRES_PASSWORD: <base64>
type: Opaque

$ kubectl get secret postgres-secret -n jobboard -o jsonpath='{.data.POSTGRES_USER}' | base64 -d
postgres
```

**Base64 is encoding, not encryption — what that means for security.** Base64 is a reversible
transform with no key; `base64 -d` recovers the plaintext instantly. It exists so that binary
values survive JSON/YAML transport, not to protect anything. Consequences:

- **At rest:** Secrets are stored in etcd. Without `EncryptionConfiguration` they sit there in
  plaintext, so an etcd backup, snapshot, or disk is a credential dump.
- **In transit through Git:** a Secret manifest in a repository is a plaintext credential, which
  is exactly why `k8s/01-secret.yaml` is gitignored and only the `.example` is committed.
- **Access control:** anyone with `get secrets` in the namespace has the credentials. RBAC is
  the real boundary, and `list`/`watch` on secrets is effectively admin.
- **Exposure surface:** mounted as env vars they appear in `kubectl describe pod`, in
  `/proc/<pid>/environ`, and are inherited by child processes.

**A concrete leak found in this cluster.** Creating the Secret with `kubectl apply` (as
`README-k8s.md` instructs via `kubectl apply -k k8s/`) writes the entire object — password
included — into a plaintext annotation on the live resource:

```
$ kubectl get secret postgres-secret -n jobboard \
    -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}'
  annotation contains keys: ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER']
  POSTGRES_PASSWORD present in the annotation: True
```

So the password existed **twice** in etcd, and the annotation is visible to anything that can
read the object — including tools that redact `.data` but not annotations.

**✅ FIXED.** The Secret is no longer applied declaratively. It was removed from
`k8s/kustomization.yaml`'s `resources` list (with a comment explaining why, so nobody
re-adds it), and is now created imperatively:

```bash
kubectl create secret generic postgres-secret -n jobboard \
  --from-literal=POSTGRES_DB=jobboard \
  --from-literal=POSTGRES_USER=postgres \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 20)" \
  --dry-run=client -o yaml | kubectl create -f -
```

Re-verified on the rebuilt cluster:

```
=== does the annotation leak the password? ===
  OK: no last-applied-configuration annotation
  password occurrences in full object: 1
```

One occurrence instead of two, and no annotation. `kubectl apply --server-side` is the
equivalent fix if a declarative workflow is required — it tracks field ownership in
`metadata.managedFields` rather than stuffing a copy of the object into an annotation.

Note this is a *containment* fix, not encryption: the value is still base64 in etcd. It
removes the second, less-protected copy. Real encryption needs the options below.

**Two production solutions providing real encryption**

1. **Kubernetes-native — encryption at rest via `EncryptionConfiguration`.** The API server
   encrypts Secret resources before writing to etcd, using AES-GCM with a local key or,
   better, a KMS provider (AWS KMS, GCP KMS, Azure Key Vault) so the master key never sits on
   the node. This is transparent to workloads and closes the etcd-at-rest hole, though it does
   not change RBAC exposure.

2. **External secrets manager — HashiCorp Vault** (or AWS Secrets Manager / GCP Secret Manager
   via the **External Secrets Operator**). The credential never becomes a long-lived Kubernetes
   Secret at all: it is injected at runtime by a sidecar or CSI driver, with short-lived
   dynamic credentials, centralised audit logging, and rotation independent of deployments.

**What Sealed Secrets is and how it works.** Bitnami Sealed Secrets solves a different problem:
how to commit secrets to Git safely for GitOps. A controller in the cluster holds an RSA private
key and publishes the public key. The `kubeseal` CLI encrypts a normal Secret with that public
key, producing a `SealedSecret` custom resource that is safe to commit publicly — only that
specific cluster's controller can decrypt it. On apply, the controller decrypts the
`SealedSecret` and creates the corresponding regular Secret. Encryption is scoped to a
namespace/name by default, so a sealed value cannot be copied elsewhere to reveal it. The
limitation: it protects the *Git* path, and the decrypted result is still an ordinary
base64 Secret in etcd — it composes with, rather than replaces, encryption at rest.

### 5.2 Add a ConfigMap (6 pts)

[`k8s/10-configmap.yaml`](k8s/10-configmap.yaml), consumed by `k8s/03-jobs-service.yaml`:

```yaml
envFrom:
  - configMapRef:
      name: jobboard-config
```

Verified inside a running pod:

```
$ kubectl exec $POD -n jobboard -c jobs-service -- env | grep -E "LOG_LEVEL|MAX_JOBS|ALLOWED_ORIGINS"
ALLOWED_ORIGINS=http://localhost,http://jobboard.local
LOG_LEVEL=info
MAX_JOBS=100
```

**`env` vs `envFrom`**

| | `env` | `envFrom` |
|---|---|---|
| Scope | One variable at a time | Every key in the ConfigMap/Secret |
| Rename | Yes — `name:` is independent of `key:` | No — the key *is* the variable name |
| Selective | Yes | All or nothing |
| Adding a key | Requires editing the manifest | Appears automatically |
| Optional | Per-key `optional: true` | Whole source `optional: true` |

`env` is used here for the database credentials because each needs a `secretKeyRef` to a
specific key; `envFrom` suits the ConfigMap because all its keys are wanted under their own
names. `env` entries take precedence when both define the same variable.

A caveat with `envFrom`: keys that are not valid environment-variable identifiers are silently
skipped (reported as an event, easy to miss), so `envFrom` requires discipline in key naming.

**When to use a ConfigMap vs a Secret.** By **sensitivity**, not data type. ConfigMap for
anything harmless in a screenshot or a support ticket — log levels, feature flags, tuning
parameters, public URLs. Secret for anything granting access: passwords, tokens, TLS private
keys, connection strings containing credentials. Mechanically they are near-identical (both
key/value, both mountable as env or volume), but Secrets are handled differently: they can be
encrypted at rest, are tmpfs-mounted when used as volumes, are omitted from some logging, and
are usually governed by separate RBAC. Putting a credential in a ConfigMap forfeits all of that.

**What happens to running pods when you update a ConfigMap? It depends — on how it is consumed:**

- **As environment variables (this project):** **nothing.** Environment is fixed at process
  start; the pods keep the old values indefinitely. This was observed directly — after applying
  the ConfigMap, the variables only appeared following
  `kubectl rollout restart deployment/jobs-service`. This is the most common surprise, because
  the ConfigMap object visibly changes while behaviour does not.
- **As a mounted volume:** the projected files **are** updated automatically, but with a delay
  (kubelet sync period plus cache TTL, typically up to ~1–2 minutes), and the application must
  watch the file and reload — most do not.
- **`subPath` mounts:** **never** updated, a well-known trap.

Because of this, the durable pattern is to make config changes explicit: either roll the
deployment after applying, or use Kustomize's `configMapGenerator`, which appends a content
hash to the ConfigMap name so that changing the data changes the pod spec and triggers a
rollout automatically.

---

## Task 6 — Kubernetes CI/CD Integration (15 pts)

### 6.1 Update the GitHub Actions pipeline (10 pts)

The `deploy-to-k8s` job is implemented in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), after `push-to-registry`.

It covers all four required steps: installs `kubectl` via `azure/setup-kubectl@v3`, materialises
a kubeconfig from `KUBECONFIG_BASE64`, updates all three Deployments with `kubectl set image`
using the commit SHA, and verifies each with `kubectl rollout status --timeout=180s`. It also
adds a `rollout undo` on failure, so a bad image does not leave the cluster wedged.

**The job is deliberately gated, and this is a design decision rather than an omission:**

```yaml
if: github.ref == 'refs/heads/main' && vars.K8S_DEPLOY_ENABLED == 'true'
```

A GitHub-hosted runner cannot reach a local minikube — `192.168.49.2` is a private address
inside this machine's WSL2 network. An ungated job would therefore fail on **every** push,
turning the pipeline permanently red and costing the Task 4.2 marks for a green pipeline. Gating
on a repository variable keeps the job present, correct and reviewable while skipping cleanly
until a genuinely reachable cluster exists.

Two implementation details worth noting:

- The kubeconfig is written to `$RUNNER_TEMP` with `chmod 600` and exported via `$GITHUB_ENV`.
  The lab's example does `export KUBECONFIG=kubeconfig.yml` inside a `run:` block, which **does
  not persist to later steps** — each step is a separate shell. Writing to `$GITHUB_ENV` is what
  actually carries it forward.
- Images are referenced by `${{ github.sha }}`, never `latest`. Deploying a floating tag makes
  rollouts non-deterministic and `rollout undo` meaningless, because the tag may resolve to
  different content on each node.

**How to set up `KUBECONFIG_BASE64` for a real cluster**

Do **not** base64 your personal admin kubeconfig. Create a dedicated, least-privilege
ServiceAccount scoped to the namespace:

```bash
kubectl create serviceaccount github-deployer -n jobboard

kubectl create role deployer -n jobboard \
  --verb=get,list,patch,update \
  --resource=deployments,deployments/scale
kubectl create rolebinding github-deployer -n jobboard \
  --role=deployer --serviceaccount=jobboard:github-deployer

# A bound, expiring token (Kubernetes 1.24+ no longer auto-creates Secrets)
TOKEN=$(kubectl create token github-deployer -n jobboard --duration=8760h)

# Build a kubeconfig around it, then:
base64 -w0 deploy-kubeconfig.yml       # paste into the KUBECONFIG_BASE64 secret
```

The cluster's API server must be reachable from GitHub's runners. For a private cluster, the
options are a self-hosted runner inside the VPC, an authorised-networks allowlist covering
GitHub's egress ranges, or a pull-based GitOps agent (Argo CD, Flux) — which is generally the
better answer, since it removes the need to hand cluster credentials to CI at all.

### 6.2 Kubernetes smoke test (5 pts)

Two steps run after the rollout:

**Every pod must be Running** — fails the job with diagnostics rather than a bare exit code:

```bash
bad=$(kubectl get pods -n jobboard --field-selector=status.phase!=Running --no-headers | wc -l)
if [ "$bad" -ne 0 ]; then
  kubectl get pods -n jobboard --field-selector=status.phase!=Running
  kubectl describe pods -n jobboard --field-selector=status.phase!=Running
  exit 1
fi
```

**Both `/health` endpoints must return 200**, probed from inside the cluster with a throwaway
`curlimages/curl` pod, since the Services are ClusterIP:

```bash
for target in jobs-service:8000 applications-service:3001; do
  code=$(kubectl run smoke-$svc-${{ github.run_id }} --rm -i --restart=Never --quiet \
           --image=curlimages/curl:8.7.1 -n jobboard -- \
           curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$svc:$port/health")
  [ "$code" = "200" ] || exit 1
done
```

The pod name includes `github.run_id` so concurrent runs cannot collide on a fixed name.

This originally carried a limitation: `/health` did not touch the database, so the smoke test
proved the process was up and routable but **not** that the application actually worked.

**✅ FIXED.** Both services now expose `/ready`, which executes `SELECT 1`, and the Kubernetes
`readinessProbe` targets it. A pod that cannot reach PostgreSQL is removed from the Service
endpoints, so the smoke test's `/health` 200 is now backed by a readiness gate that genuinely
exercises the dependency — a pod only joins the endpoint set once `/ready` has succeeded.
`/health` is deliberately left as the *liveness* target, because a liveness failure restarts
the container and must not be coupled to an external dependency.

---

## Summary of changes to the provided manifests

| File | Change | Why |
|---|---|---|
| `k8s/03-jobs-service.yaml` | Removed YAML-built `DATABASE_URL`; added `POSTGRES_HOST`/`POSTGRES_PORT`; added `envFrom` ConfigMap | `$(VAR)` substitution does not URL-encode (pre-work 1); Task 5.2 |
| `k8s/04-applications-service.yaml` | Removed YAML-built `DATABASE_URL`; added `POSTGRES_HOST`/`POSTGRES_PORT` | Fixed `ERR_INVALID_URL` crash loop |
| `k8s/09-network-policy.yaml` | **New** | Task 2.4 |
| `k8s/10-configmap.yaml` | **New** | Task 5.2 |
| `k8s/kustomization.yaml` | Added 09 and 10 to `resources` | Deploy the new manifests |
| `jobs-service/app/main.py` | Collection routes registered at `/jobs` and `/jobs/`; `/health` reports `APP_VERSION` | Fixed the 307 through the ingress; made the rollout observable |
| `jobs-service/Dockerfile` | `ARG`/`ENV APP_VERSION` | Build `:v2` distinguishably for Task 4.2 |
| `jobs-service/app/database.py`, `applications-service/src/db.js` | Compose and percent-encode the URL from discrete parts | Root-cause fix for the encoding defect |

`k8s/01-secret.yaml` is generated from the `.example` and is gitignored — it is never committed.

## Submission checklist

- [x] All manifests applied — `evidence/k8s/01-inventory.txt`, `14-final-state.txt`
- [x] All pods Running and Ready
- [x] Application reachable and rendering ("6 Open Positions" through the ingress)
- [x] Rolling update demonstrated — `evidence/k8s/10-rolling-update.txt`, `11-scaling-rollback.txt`
- [x] HPA scaling event captured — `evidence/k8s/12-hpa.txt` (2 → 4 → 6)
- [x] `k8s/09-network-policy.yaml` committed
- [x] `k8s/10-configmap.yaml` committed
- [x] `deploy-to-k8s` job added to the pipeline
- [x] `SOLUTION-k8s.md` (this file)
- [ ] **Screenshots — for you to capture** (see the note at the end of `SOLUTION.md`)
