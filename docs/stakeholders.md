# Video Bridge: Stakeholder Documentation

## Stakeholder Map

### Primary Stakeholders

#### Video Curator / Operator

The day-to-day user of Video Bridge. Responsible for importing recordings, reviewing and approving content, configuring rules, and monitoring the publication pipeline.

**Needs:**
- Single dashboard showing all video across platforms and statuses
- Batch operations (bulk approve, backfill orchestration) to handle large libraries
- Rules engine to automate repetitive triage decisions
- Clear visibility into what published, what failed, and why
- Confidence that no recording was missed or published without review

**Touchpoints:** Dashboard, ImportPanel, RulesPanel, BackfillPanel, EventLog

---

#### Content Owner / Producer

The person or team that creates the video content (records Zoom meetings, produces webinars, delivers training sessions). May not use Video Bridge directly but relies on it for publication.

**Needs:**
- Assurance that their recordings reach the intended audience (YouTube channel, internal portal)
- Correct metadata: title, description, tags, and participant attribution
- Notification when their content is published (via post-processing webhook or email)
- Ability to request edits to metadata before publication

**Touchpoints:** Indirect — through the curator or via post-processing email notifications (ADR-024)

---

#### Platform Administrator

Manages the external platform accounts (YouTube channel, Zoom account, Fireflies workspace) that Video Bridge connects to.

**Needs:**
- Control over which credentials are used and what scopes are granted
- Visibility into API quota consumption (YouTube daily upload limits, Zoom API rate limits)
- Assurance that credentials are handled securely. Shared platform credentials (Zoom, Fireflies, Kaltura, OpenRouter, OpusClip) live in Google Secret Manager and are managed by Admins (ADR-042). Per-operator YouTube OAuth stays in localStorage by design so brand-account uploads carry the actual operator's identity (ADR-042 §"YouTube brand account"). Every credential write is audited end-to-end via ADR-041.
- Ability to revoke access without disrupting other integrations

**Touchpoints:** ConnectionsPanel, OAuth consent screens, platform admin consoles

---

#### Infrastructure / DevOps Engineer

Deploys and maintains the Video Bridge instance on Google Cloud.

**Needs:**
- Reproducible deployments via CI/CD (GitHub Actions to Cloud Run)
- Observable system: structured logs in Cloud Logging, memory pressure alerts (ADR-032), health endpoint
- Clear resource boundaries: memory limits, instance scaling, quota caps
- Security: no credentials in code, Secret Manager for server-side keys

**Touchpoints:** `.github/workflows/deploy.yml`, Cloud Run console, Cloud Logging, `/api/health`

---

### Secondary Stakeholders

#### Compliance / Legal

May need to verify that video content is published with proper attribution, licensing, and data handling.

**Needs:**
- Provenance trail: where did each video originate, who approved it, when was it published
- YouTube description footer with catalog ID, source platform, and parent ID (ADR-022)
- Audit log: structured event log with correlation IDs (ADR-017)

**Touchpoints:** ProvenanceGraph, EventLog (structured view), YouTube video descriptions

---

#### Viewers / Audience

The end consumers of published video content on YouTube or other platforms.

**Needs:**
- Correctly titled and described videos
- Consistent publishing cadence (backfill orchestrator enables predictable schedules)
- Short-form clips for discoverability (Shorts generation via ADR-029)

**Touchpoints:** YouTube channel, published Shorts

---

## Stakeholder Concerns Matrix

| Concern | Curator | Content Owner | Platform Admin | DevOps | Compliance |
|---------|---------|--------------|----------------|--------|------------|
| Video discovery & import | Primary | - | - | - | - |
| Metadata accuracy | Primary | Primary | - | - | Secondary |
| Publication approval | Primary | Informed | - | - | Informed |
| Credential security | - | - | Primary | Primary | Primary |
| API quota management | Secondary | - | Primary | Secondary | - |
| System reliability | Secondary | - | - | Primary | - |
| Audit trail | Secondary | - | - | - | Primary |
| Provenance tracking | Primary | Secondary | - | - | Primary |
| Cost management | - | - | Secondary | Primary | - |

## RACI for Key Workflows

| Activity | Curator | Content Owner | Platform Admin | DevOps |
|----------|---------|--------------|----------------|--------|
| Configure platform connections | R | - | A/C | I |
| Import video recordings | R/A | I | - | - |
| Define ingestion rules | R/A | C | - | - |
| Review and approve videos | R/A | C | - | - |
| Configure processing rules | R/A | C | - | - |
| Run backfill orchestrator | R/A | I | C | - |
| Monitor publication health | R | - | - | A |
| Deploy new version | I | - | - | R/A |
| Rotate credentials | I | - | R/A | C |
| Investigate failures | R | - | C | A |

*R = Responsible, A = Accountable, C = Consulted, I = Informed*
