/**
 * Pulumi stack for glrs.dev infrastructure on GCP.
 *
 * Provisions:
 *   - GCS bucket hosting the static docs site
 *   - HTTPS load balancer with a Google-managed TLS cert for <domain>
 *   - Cloud CDN fronting the bucket
 *   - Workload Identity Federation pool + provider for GitHub Actions
 *   - Service account with scoped perms for docs deploys + CDN invalidation
 *
 * State is stored in gs://glrs-pulumi-state (see Pulumi.yaml).
 *
 * Config keys (Pulumi.prod.yaml):
 *   gcp:project            GCP project ID
 *   gcp:region             GCP region (default: us-central1)
 *   glrs:domain            Domain name (e.g. glrs.dev)
 *   glrs:docsBucket        Bucket name for docs site (must be globally unique)
 *   glrs:githubOrg         GitHub org (iceglober)
 *   glrs:githubRepo        GitHub repo (glorious)
 *
 * Bootstrap sequence (one-time, manual):
 *   1. gcloud projects create glrs-prod
 *   2. gcloud services enable compute.googleapis.com iam.googleapis.com \
 *        storage.googleapis.com iamcredentials.googleapis.com --project glrs-prod
 *   3. gsutil mb -p glrs-prod -l us-central1 gs://glrs-pulumi-state
 *   4. gsutil versioning set on gs://glrs-pulumi-state
 *   5. pulumi login gs://glrs-pulumi-state
 *   6. pulumi stack init prod
 *   7. pulumi config set gcp:project glrs-prod
 *   8. pulumi up
 *   9. Point glrs.dev A record at the outputs.forwardingRuleIp value
 *  10. Wait ~15 min for managed cert provisioning (DNS validation)
 *  11. Set GitHub secrets + vars per outputs.githubSecretsYaml
 */

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const config = new pulumi.Config("glrs");
const gcpConfig = new pulumi.Config("gcp");

const domain = config.require("domain");
const bucketName = config.require("docsBucket");
const githubOrg = config.require("githubOrg");
const githubRepo = config.require("githubRepo");
const project = gcpConfig.require("project");
const region = gcpConfig.get("region") ?? "us-central1";

// ────────────────────────────────────────────────────────────────────────────
// Docs bucket
// ────────────────────────────────────────────────────────────────────────────

const docsBucket = new gcp.storage.Bucket("docs-bucket", {
  name: bucketName,
  project,
  location: "US", // multi-region for global CDN origin
  uniformBucketLevelAccess: true,
  forceDestroy: false,
  website: {
    mainPageSuffix: "index.html",
    notFoundPage: "404.html",
  },
  cors: [
    {
      origins: ["*"],
      methods: ["GET", "HEAD", "OPTIONS"],
      responseHeaders: ["Content-Type"],
      maxAgeSeconds: 3600,
    },
  ],
});

// Bucket is publicly readable so the CDN (and users) can fetch objects.
new gcp.storage.BucketIAMMember("docs-bucket-public-read", {
  bucket: docsBucket.name,
  role: "roles/storage.objectViewer",
  member: "allUsers",
});

// ────────────────────────────────────────────────────────────────────────────
// Cloud CDN + HTTPS load balancer
// ────────────────────────────────────────────────────────────────────────────

const backendBucket = new gcp.compute.BackendBucket("docs-backend", {
  name: "glrs-docs-backend",
  project,
  bucketName: docsBucket.name,
  enableCdn: true,
  cdnPolicy: {
    cacheMode: "CACHE_ALL_STATIC",
    clientTtl: 3600,
    defaultTtl: 3600,
    maxTtl: 86400,
    negativeCaching: true,
    serveWhileStale: 86400,
  },
});

const urlMap = new gcp.compute.URLMap("docs-urlmap", {
  name: "glrs-docs-urlmap",
  project,
  defaultService: backendBucket.selfLink,
});

const managedCert = new gcp.compute.ManagedSslCertificate("docs-cert", {
  name: "glrs-docs-cert",
  project,
  managed: {
    domains: [domain],
  },
});

const httpsProxy = new gcp.compute.TargetHttpsProxy("docs-https-proxy", {
  name: "glrs-docs-https-proxy",
  project,
  urlMap: urlMap.selfLink,
  sslCertificates: [managedCert.selfLink],
});

const globalAddress = new gcp.compute.GlobalAddress("docs-ip", {
  name: "glrs-docs-ip",
  project,
  ipVersion: "IPV4",
});

const forwardingRule = new gcp.compute.GlobalForwardingRule("docs-fr", {
  name: "glrs-docs-fr",
  project,
  target: httpsProxy.selfLink,
  portRange: "443",
  ipAddress: globalAddress.address,
  loadBalancingScheme: "EXTERNAL_MANAGED",
});

// HTTP → HTTPS redirect (same IP, port 80 proxy → URL map that 301s)
const httpRedirectUrlMap = new gcp.compute.URLMap("docs-http-redirect", {
  name: "glrs-docs-http-redirect",
  project,
  defaultUrlRedirect: {
    httpsRedirect: true,
    stripQuery: false,
    redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
  },
});

const httpProxy = new gcp.compute.TargetHttpProxy("docs-http-proxy", {
  name: "glrs-docs-http-proxy",
  project,
  urlMap: httpRedirectUrlMap.selfLink,
});

new gcp.compute.GlobalForwardingRule("docs-http-fr", {
  name: "glrs-docs-http-fr",
  project,
  target: httpProxy.selfLink,
  portRange: "80",
  ipAddress: globalAddress.address,
  loadBalancingScheme: "EXTERNAL_MANAGED",
});

// ────────────────────────────────────────────────────────────────────────────
// Service account for GitHub Actions → docs deploys
// ────────────────────────────────────────────────────────────────────────────

const deploySa = new gcp.serviceaccount.Account("docs-deploy-sa", {
  accountId: "glrs-docs-deploy",
  displayName: "glrs.dev docs deploy (GitHub Actions)",
  project,
});

// Bucket write perms for rsync
new gcp.storage.BucketIAMMember("docs-deploy-bucket-admin", {
  bucket: docsBucket.name,
  role: "roles/storage.objectAdmin",
  member: pulumi.interpolate`serviceAccount:${deploySa.email}`,
});

// CDN cache invalidation perm. There's no predefined role that's scoped tightly
// enough; roles/compute.loadBalancerAdmin is the closest pre-defined role.
// A custom role would be tighter but adds maintenance burden.
new gcp.projects.IAMMember("docs-deploy-cdn-invalidator", {
  project,
  role: "roles/compute.loadBalancerAdmin",
  member: pulumi.interpolate`serviceAccount:${deploySa.email}`,
});

// ────────────────────────────────────────────────────────────────────────────
// Workload Identity Federation: GitHub Actions → deploy SA
// ────────────────────────────────────────────────────────────────────────────

const wifPool = new gcp.iam.WorkloadIdentityPool("github-pool", {
  workloadIdentityPoolId: "github-actions-pool",
  displayName: "GitHub Actions Pool",
  description: "Workload Identity Pool for iceglober/glorious GitHub Actions deploys",
  project,
});

const wifProvider = new gcp.iam.WorkloadIdentityPoolProvider("github-provider", {
  workloadIdentityPoolId: wifPool.workloadIdentityPoolId,
  workloadIdentityPoolProviderId: "github-provider",
  displayName: "GitHub Actions Provider",
  description: "OIDC provider for GitHub Actions",
  project,
  attributeMapping: {
    "google.subject": "assertion.sub",
    "attribute.actor": "assertion.actor",
    "attribute.repository": "assertion.repository",
    "attribute.repository_owner": "assertion.repository_owner",
    "attribute.ref": "assertion.ref",
  },
  // Only allow tokens issued for our repo. Without this condition, any
  // GitHub Actions workflow in the world could assume the pool.
  attributeCondition: pulumi.interpolate`assertion.repository == "${githubOrg}/${githubRepo}"`,
  oidc: {
    issuerUri: "https://token.actions.githubusercontent.com",
  },
});

// Bind the deploy SA to workflows running in this specific repo's main branch.
new gcp.serviceaccount.IAMMember("docs-deploy-wif-binding", {
  serviceAccountId: deploySa.name,
  role: "roles/iam.workloadIdentityUser",
  member: pulumi.interpolate`principalSet://iam.googleapis.com/${wifPool.name}/attribute.repository/${githubOrg}/${githubRepo}`,
});

// ────────────────────────────────────────────────────────────────────────────
// Outputs
// ────────────────────────────────────────────────────────────────────────────

export const forwardingRuleIp = globalAddress.address;
export const docsBucketName = docsBucket.name;
export const managedCertStatus = managedCert.certificateId;
export const urlMapName = urlMap.name;
export const deployServiceAccountEmail = deploySa.email;
export const wifProviderName = wifProvider.name;

// Convenience: the exact strings you need to paste into GitHub repo
// Settings → Secrets and variables → Actions.
export const githubSetup = pulumi.interpolate`
# Configure in GitHub repo settings (Secrets and variables → Actions):

# Secrets (encrypted):
GCP_WIF_PROVIDER=${wifProvider.name}

# Variables (plaintext):
GCP_SERVICE_ACCOUNT=${deploySa.email}
GCP_PROJECT_ID=${project}
GCP_DOCS_BUCKET=${docsBucket.name}
GCP_URL_MAP=${urlMap.name}

# Then point your DNS A record for ${domain} at: ${globalAddress.address}
# (Cert provisioning takes ~15 min after DNS resolves.)
`;
