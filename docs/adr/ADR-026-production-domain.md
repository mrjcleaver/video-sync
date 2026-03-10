# ADR-026: Production Domain — videosync.agentics.org

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-03-10 |
| **Deciders** | Engineering |
| **Project** | VID-BRIDGE-01 |

## Context

The application is deployed to Google Cloud Run per ADR-018. The auto-generated Cloud Run URL (`video-sync-HASH-ew.a.run.app`) is opaque and not suitable for sharing with operators or end users. A stable, human-readable domain under `agentics.org` is required for the production environment.

The `agentics.org` DNS zone is managed in Cloudflare (zone ID: `6aae4b470d0a046a9ae730b12ad69e40`). The Cloudflare API token is stored in GCP Secret Manager under the key `CLOUDFLARE_API_TOKEN` in project `agentics-487016`.

---

## Decision

The production domain for this repository is **`videosync.agentics.org`**.

DNS is managed in Cloudflare. The record points to the Cloud Run custom domain mapping, which provisions a Google-managed TLS certificate automatically.

### DNS Configuration

| Type | Name | Target | Proxied |
|------|------|--------|---------|
| CNAME | `videosync` | Cloud Run domain mapping endpoint | No (DNS-only) |

Cloud Run domain mapping is configured via:

```bash
gcloud beta run domain-mappings create \
  --service video-sync \
  --domain videosync.agentics.org \
  --region europe-west1
```

This produces a verification DNS record and a CNAME target that must be added to Cloudflare. Cloudflare proxy (`orange cloud`) is disabled on this record to allow Google's certificate provisioning to complete via TLS-ALPN-01 challenge.

### Secret Management

The `CLOUDFLARE_API_TOKEN` secret in GCP Secret Manager is used for programmatic DNS management (e.g. CI/CD automation, ADR scripting). It requires the `DNS:Edit` permission scope on the `agentics.org` zone.

---

## Consequences

### Positive

- Stable, memorable URL for operators and stakeholders.
- TLS certificate managed automatically by Google (no manual renewal).
- Cloudflare DNS provides fast global propagation and a single authoritative source for all `agentics.org` subdomains.
- `CLOUDFLARE_API_TOKEN` in Secret Manager enables automated DNS record creation without storing credentials in the repository.

### Negative

- Cloudflare proxy must remain disabled (`grey cloud`) on the `videosync` record while Google manages TLS. This means Cloudflare DDoS protection and caching are not active for this subdomain.
- Cloud Run domain mappings require domain ownership verification (TXT record) on first setup.

### Risks

- If the Cloud Run service is redeployed to a different region, the domain mapping must be recreated and the CNAME target updated.
- The `CLOUDFLARE_API_TOKEN` has `DNS:Edit` scope — if compromised, all DNS records in the `agentics.org` zone can be modified. Rotate immediately if exposed.

---

## Implementation Steps

| Step | Action | Owner |
|------|--------|-------|
| 1 | Run `gcloud beta run domain-mappings create` for `videosync.agentics.org` | Engineering |
| 2 | Add the TXT ownership-verification record to Cloudflare | Engineering |
| 3 | Add CNAME `videosync` → Cloud Run mapping endpoint to Cloudflare (proxied: off) | Engineering |
| 4 | Wait for Google-managed TLS certificate to provision (~15 minutes) | Engineering |
| 5 | Verify `https://videosync.agentics.org` returns HTTP 200 | Engineering |
| 6 | Update `NEXT_PUBLIC_APP_URL` environment variable in Cloud Run to `https://videosync.agentics.org` | Engineering |

---

## References

- ADR-018: Google Cloud Hosting (Cloud Run deployment)
- ADR-010: Authentication Configuration (OAuth redirect URIs must be updated to use new domain)
- [Cloud Run — Custom domains](https://cloud.google.com/run/docs/mapping-custom-domains)
- [Cloudflare — DNS zone: agentics.org](https://dash.cloudflare.com/)
