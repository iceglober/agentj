# `infra/gcp/` — Pulumi stack for glrs.dev

Manages the GCP infrastructure that serves https://glrs.dev: GCS bucket, HTTPS load balancer with Cloud CDN, Google-managed TLS cert, and a Workload Identity Federation pool that lets GitHub Actions deploy without long-lived keys.

**State** is stored in a GCS bucket (`gs://glrs-pulumi-state`), not Pulumi Cloud.

## Prerequisites

You need:
- `gcloud` CLI authenticated with an account that has `roles/owner` on the target GCP project (or equivalently-scoped individual roles: project creator, IAM admin, compute admin, storage admin)
- `pulumi` CLI (≥ 3.140)
- Node.js 20+

## One-time bootstrap

Before `pulumi up` can run, the state bucket and required APIs must exist. Do this **once**, manually:

```bash
# 1. Create the project (skip if it already exists)
gcloud projects create glrs-prod

# 2. Enable the APIs Pulumi will need
gcloud services enable \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  storage.googleapis.com \
  --project glrs-prod

# 3. Create the state bucket (if not done already)
gsutil mb -p glrs-prod -l us-central1 gs://glrs-pulumi-state
gsutil versioning set on gs://glrs-pulumi-state
gsutil uniformbucketlevelaccess set on gs://glrs-pulumi-state

# 4. Point Pulumi at the GCS backend
pulumi login gs://glrs-pulumi-state

# 5. Init the stack
cd infra/gcp
bun install
pulumi stack init prod
pulumi config set gcp:project glrs-prod
```

## Deploy

```bash
cd infra/gcp
pulumi preview       # review plan
pulumi up            # apply
```

The first run takes 15-20 minutes, mostly waiting for the managed cert to provision. That requires the domain's DNS A record to point at the load balancer IP first — see the next section.

## Post-deploy: DNS + GitHub secrets

After `pulumi up` finishes, view the outputs:

```bash
pulumi stack output githubSetup
```

That prints a block like:

```
GCP_WIF_PROVIDER=projects/12345/locations/global/workloadIdentityPools/github-actions-pool/providers/github-provider
GCP_SERVICE_ACCOUNT=glrs-docs-deploy@glrs-prod.iam.gserviceaccount.com
GCP_PROJECT_ID=glrs-prod
GCP_DOCS_BUCKET=glrs-dev-docs
GCP_URL_MAP=glrs-docs-urlmap

# DNS A record for glrs.dev: <ip>
```

Three setup steps:

1. **DNS** — at your registrar, create an A record for `glrs.dev` pointing at the IP. The managed cert won't provision until DNS resolves (takes 5-60 min depending on TTLs).
2. **GitHub repo secrets** — at https://github.com/iceglober/glrs/settings/secrets/actions, add `GCP_WIF_PROVIDER` as a **secret**.
3. **GitHub repo variables** — same page, "Variables" tab, add `GCP_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_DOCS_BUCKET`, `GCP_URL_MAP` as **variables** (not secrets — they're not sensitive, and the deploy workflow reads them from `vars.*`).

## Verify

```bash
# Wait for cert to go ACTIVE
gcloud compute ssl-certificates describe glrs-docs-cert --global --format='get(managed.status)'
# Should eventually say ACTIVE

# Test the deploy pipeline (from GitHub Actions)
# → Push any change under docs/ on main, watch .github/workflows/docs-deploy.yml
```

## Resources created

| Resource | Name | Purpose |
|---|---|---|
| `gcp.storage.Bucket` | `glrs-dev-docs` | Static docs site origin |
| `gcp.compute.BackendBucket` | `glrs-docs-backend` | CDN-enabled backend for the bucket |
| `gcp.compute.URLMap` | `glrs-docs-urlmap` | Route all requests to the backend |
| `gcp.compute.ManagedSslCertificate` | `glrs-docs-cert` | Google-managed TLS for glrs.dev |
| `gcp.compute.TargetHttpsProxy` | `glrs-docs-https-proxy` | HTTPS termination |
| `gcp.compute.GlobalAddress` | `glrs-docs-ip` | Anycast IP |
| `gcp.compute.GlobalForwardingRule` | `glrs-docs-fr`, `glrs-docs-http-fr` | 443 + 80 (HTTP → HTTPS redirect) |
| `gcp.serviceaccount.Account` | `glrs-docs-deploy` | SA used by GitHub Actions deploys |
| `gcp.iam.WorkloadIdentityPool` | `github-actions-pool` | OIDC trust anchor |
| `gcp.iam.WorkloadIdentityPoolProvider` | `github-provider` | Pins to iceglober/glrs only |

## Costs

- GCS storage: **~$0.02/GB/month** — docs site is tiny, < $0.10/month
- HTTPS load balancer: **~$18/month** forwarding rule + **~$7/month** per rule for HTTP → HTTPS redirect
- Cloud CDN egress: **~$0.02-0.08/GB** depending on region
- Workload Identity: **free**
- Managed cert: **free**

Expect ~$25-30/month total for light traffic. Most of that is the load balancer baseline; actual egress is negligible for a static docs site.

## Destroy

```bash
pulumi destroy
```

Note: `forceDestroy: false` on the bucket means you must manually empty it first:

```bash
gsutil -m rm -r gs://glrs-dev-docs/\*
```
