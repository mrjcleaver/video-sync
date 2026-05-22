# Video Bridge: What It Is and How to Use It

> **⚠ Legacy document.** This is the original short-form overview of Video Bridge. It remains accurate for the core concept but is **missing** many features added since: Backfill Overview, Recover from YouTube, cross-source sibling suggestions, privacy badges, per-video event logs, the single-browser constraint, and more.
>
> For current behaviour, read [`user-guide.md`](user-guide.md) (comprehensive) and [`user-flows.md`](user-flows.md) (diagrams).
>
> This file is kept for historical continuity; it is not maintained.

---

## What Is Video Bridge?

Video Bridge is a **unified video indexing and publishing tool**. It solves a common problem for organizations that produce video content across multiple platforms: recordings live in Zoom, get edited in Loom, and need to end up on YouTube or Kaltura — but nobody has a single view of where everything is or what state it's in.

Video Bridge gives you that single view. It:

1. **Discovers** videos from your source platforms — Zoom (cloud recordings), Fireflies.ai (transcripts), YouTube (live broadcasts + uploads), Kaltura (entries). Loom and one-off URLs are imported manually via the URL Import tab.
2. **Indexes** them into a searchable, normalized catalog
3. Lets curators **review and approve** which videos should be published
4. **Publishes** approved videos to destination platforms (YouTube, Kaltura)
5. **Tracks** every video across all the platforms it exists in

## The Video Lifecycle

A video typically moves through these stages:

```
Source Platform        Video Bridge         Destination Platforms
───────────────       ──────────────       ─────────────────────

 ┌─────────┐          ┌────────────┐
 │  Zoom   │─────────>│ Discovered │
 │  Loom   │  ingest  │  (review)  │
 │Fireflies│          └─────┬──────┘
 └─────────┘                │
                    approve │ skip
                            │
                      ┌─────▼──────┐        ┌──────────┐
                      │  Approved  │───────>│ YouTube  │
                      │            │publish │ Kaltura  │
                      └────────────┘        └──────────┘
```

### Status Definitions

| Status | Meaning |
|--------|---------|
| **Discovered** | Newly pulled from a source platform. Sitting in the review checklist. |
| **Approved** | A curator reviewed it and marked it ready for publishing. |
| **Skipped** | A curator decided not to publish it. Can be reversed. |
| **Publishing** | Currently being transferred to a destination platform. |
| **Published** | Successfully delivered. You can see the destination link. |
| **Failed** | Transfer failed. Can be re-approved to retry. |

## Multi-Platform Identity

This is the core concept. A single video can exist in multiple places:

| Platform | Role | Example |
|----------|------|---------|
| Zoom | **Origin** — where the recording was made | `zoom.us/rec/abc123` |
| Loom | **Intermediate** — where it was edited or annotated | `loom.com/share/xyz789` |
| YouTube | **Destination** — where the public version lives | `youtube.com/watch?v=dQw4` |
| Kaltura | **Destination** — where the institutional copy lives | `video.example.edu/id/klt456` |

Video Bridge tracks all of these as **locations** on the video record. When you open a video in the dashboard, you see every platform it exists in, with direct links and sync timestamps.

### Why This Matters

Without this:
- Someone asks "do we have the Q4 town hall on YouTube?" and nobody knows without checking three platforms manually.
- A video gets edited in Loom but the old version stays on YouTube — nobody notices.
- Fireflies has the transcript, Zoom has the recording, Loom has the edited version — there's no connection between them.

With Video Bridge, one search finds the video and shows you every place it lives.

## How Videos Are Sourced

### Zoom

Video Bridge connects to your Zoom account via OAuth 2.0. When a new recording completes, Zoom sends a webhook notification and Video Bridge immediately indexes it. A fallback poller runs every 15 minutes to catch any missed webhooks.

**What's captured:** Meeting title, duration, participants, recording URL, and transcript (if cloud recording includes it).

### Loom

Loom shut down their public API in 2025, so automatic discovery is no longer possible. Loom support is now **manual URL import only**: paste a `loom.com/share/...` URL into the **URL Import** tab and Video Bridge fetches what it can from Loom's public share page (oEmbed for title / description / duration / thumbnail; an Apollo-state scrape for `createdAt`, the auto-generated transcript, owner name + email, language, and chapters).

This works well for content that has been **manually extracted and enhanced** elsewhere — an edited Loom that improves on a raw Zoom recording, for example. Treat Loom as an *intermediate* in the provenance chain: the operator imports the Loom share URL and links it to the original Zoom (or other) source via the sibling-match suggestion, preserving the chain Zoom → Loom (edit) → YouTube/Kaltura.

**What's captured:** Title, description, duration, creator, language, transcript (when Loom auto-generates one), and chapters — all from the public share page; no Loom credentials required.

### Fireflies.ai

Video Bridge polls the Fireflies GraphQL API every 10 minutes for new meeting transcripts. Fireflies is particularly valuable because it provides AI-generated summaries and full transcripts.

**What's captured:** Meeting title, participants, full transcript text, AI summary, and duration.

## How Videos Are Published

### YouTube

When a curator approves a video and clicks **Publish to YouTube**, Video Bridge:

1. Downloads the video file from the source platform to temporary storage
2. Uploads it to the configured YouTube channel via the YouTube Data API
3. Sets the title, description, and tags from the catalog metadata
4. Records the YouTube video ID and URL back on the video record

The YouTube connection requires OAuth 2.0 with user consent — an admin must authorize Video Bridge to upload on behalf of a specific YouTube channel.

### Kaltura

Publishing to Kaltura follows the same pattern but uses Kaltura's session-based authentication. The admin configures a partner ID and admin secret (or app token), and Video Bridge mints session tokens on demand to upload content.

**What's captured back:** Kaltura entry ID and player URL.

## Setting Up Connections

An administrator configures platform connections in the **Settings > Connections** panel. Each platform has a card showing its connection status.

| Platform | What You Need |
|----------|--------------|
| **Zoom** | Create a Server-to-Server OAuth app in the Zoom Marketplace. Provide the account ID, client ID, and client secret. |
| **Loom** | *No credentials needed.* Loom's public API was discontinued in 2025 — Loom support is manual URL import only via the **URL Import** tab. |
| **Fireflies** | Copy your API key from Fireflies Settings > Integrations. Paste it into the connection form. |
| **YouTube** | Create OAuth 2.0 credentials in the Google Cloud Console with YouTube Data API v3 enabled. Click Connect to go through the consent flow. |
| **Kaltura** | Provide your partner ID and admin secret (or app token) from the Kaltura Management Console. |

After connecting, use the **Test Connection** button to verify. Video Bridge also runs automatic health checks every 30 minutes and will alert you if a connection breaks.

## Using the Dashboard

### The Curation Checklist

The main view is the curation checklist. New videos from all sources land here with status **Discovered**. For each video you can:

- **Approve** — mark it ready for publishing (optionally edit title, tags, description first)
- **Skip** — exclude it from publishing (reversible)
- **Add notes** — internal annotations visible only to your team
- **View locations** — see every platform this video exists in

### Filtering and Search

Use the status tabs to filter: All, Discovered, Approved, Publishing, Published, Skipped, Failed. The search bar supports full-text search across titles, descriptions, participants, transcript text, and tags.

### Publishing

From an approved video, click **Publish** and select the destination (YouTube, Kaltura, or both). The dashboard shows real-time status as the transfer progresses. When complete, the destination URL appears on the video card.

## Roles

| Role | Can Do |
|------|--------|
| **Admin** | Everything — manage connections, users, credentials, and all video operations |
| **Publisher** | View catalog, search, approve/skip videos, publish, edit metadata |
| **Viewer** | View catalog and search only |
