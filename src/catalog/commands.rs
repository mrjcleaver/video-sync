use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::events::MetadataEdits;
use crate::catalog::value_objects::{Actor, DerivationType, LinkOrigin, LocationRole, Platform, SourcePlatform, SummaryCounts};

/// Commands accepted by the VideoRecord aggregate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VideoCommand {
    IndexVideo(IndexVideo),
    ApproveVideo(ApproveVideo),
    SkipVideo(SkipVideo),
    MarkInScope(MarkInScope),
    RequestPublish(RequestPublish),
    MarkPublished(MarkPublished),
    MarkFailed(MarkFailed),
    UpdateMetadata(UpdateMetadata),
    AddNote(AddNote),
    AssignOwners(AssignOwners),
    AssignModerators(AssignModerators),
    AddLocation(AddLocation),
    RemoveLocation(RemoveLocation),
    UpdateLocationStatus(UpdateLocationStatus),
    AbandonVideo(AbandonVideo),
    MarkToRetry(MarkToRetry),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexVideo {
    pub source_id: String,
    pub source_platform: SourcePlatform,
    pub title: String,
    pub description: Option<String>,
    pub duration_seconds: u32,
    pub participants: Vec<String>,
    pub transcript_text: Option<String>,
    pub download_url: String,
    pub thumbnail_url: Option<String>,
    pub tags: Vec<String>,
    pub metadata_extra: Option<serde_json::Value>,
    pub initial_owner: Option<Uuid>,
    pub recorded_at: Option<String>,
    // ── ADR-065: community contributor attribution (optional) ─────
    #[serde(default)]
    pub contributor_email: Option<String>,
    #[serde(default)]
    pub contributor_chapter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApproveVideo {
    pub actor: Actor,
    pub metadata_edits: Option<MetadataEdits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipVideo {
    pub actor: Actor,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPublish {
    pub actor: Actor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkPublished {
    pub destination_id: String,
    pub destination_url: String,
    #[serde(default)]
    pub destination_platform: Option<Platform>,
}

/// ADR-077 §1 — one destination from the resolved set, as handed to
/// `begin_publish`. Mirrors ADR-075's `DestinationSpec` reduced to what
/// the aggregate needs: which platform, and what visibility was asked
/// for in that platform's own vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeclaredDestination {
    pub platform: Platform,
    #[serde(default)]
    pub visibility: Option<String>,
}

/// ADR-077 §1 — open a publish over a known set of destinations.
///
/// Replaces `RequestPublish` for callers that have resolved a
/// destination set (ADR-077 §2). `RequestPublish` remains for the
/// legacy single-YouTube path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeginPublish {
    pub actor: Actor,
    pub destinations: Vec<DeclaredDestination>,
}

/// ADR-077 §1 — report what happened at one destination.
///
/// `error: Some(..)` means the push failed; `None` means it landed and
/// `external_id` is required. Legal from both `Publishing` and
/// `Published`, which is what lets a peer destination be a real
/// event-sourced publish instead of the `add_location` side door.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordDestinationResult {
    pub actor: Actor,
    pub platform: Platform,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub external_url: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// ADR-077 §1/§5 — record a visibility read-back from the platform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordObservedVisibility {
    pub platform: Platform,
    pub visibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkFailed {
    pub error_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMetadata {
    pub actor: Actor,
    pub edits: MetadataEdits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddNote {
    pub actor: Actor,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignOwners {
    pub actor: Actor,
    pub owners: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignModerators {
    pub actor: Actor,
    pub moderators: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkInScope {
    pub actor: Actor,
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddLocation {
    pub actor: Actor,
    pub platform: Platform,
    pub external_id: String,
    pub external_url: Option<String>,
    pub role: LocationRole,
    #[serde(default)]
    pub ordinal: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveLocation {
    pub actor: Actor,
    pub platform: Platform,
    pub external_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateLocationStatus {
    pub actor: Actor,
    pub platform: Platform,
    pub external_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbandonVideo {
    pub actor: Actor,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkToRetry {
    pub actor: Actor,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkUpstream {
    pub actor: Actor,
    /// Catalog ID of the upstream VideoRecord. None = phantom node.
    pub video_id: Option<uuid::Uuid>,
    pub platform: Platform,
    pub external_id: String,
    pub account_hint: Option<String>,
    pub relation: DerivationType,
    #[serde(default = "LinkUpstream::default_origin")]
    pub linked_by: LinkOrigin,
}

impl LinkUpstream {
    fn default_origin() -> LinkOrigin { LinkOrigin::Manual }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlinkUpstream {
    pub actor: Actor,
    pub platform: Platform,
    pub external_id: String,
    /// If true, add to rejected_links to suppress future auto-suggestions.
    #[serde(default)]
    pub reject: bool,
}

/// ADR-046 — record the metadata of a freshly generated summary Doc on
/// the VideoRecord. Called by the summary-generate API route after a
/// successful Drive Doc write. Overwrites previous summary metadata,
/// matching the bulk-regen-on-prompt-bump intent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetSummaryMetadata {
    pub actor: Actor,
    /// Drive file id of the summary Google Doc.
    pub doc_id: String,
    /// Prompt version that authored this summary (monotonic).
    pub prompt_version: u32,
    /// Counts to surface in the Overview lozenge.
    pub counts: SummaryCounts,
    /// ISO timestamp from the generation flow. Surfaced as
    /// "Summary: prompt v3 · MMM DD" on the card detail.
    #[serde(default)]
    pub generated_at: Option<String>,
}

/// ADR-046 — lock the summary against bulk regeneration. The Drive Doc
/// itself stays editable; this flag only affects whether the regen-job
/// rewrites the Doc when the prompt is bumped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockSummary {
    pub actor: Actor,
}

/// ADR-046 — opposite of LockSummary. Returns the record to the
/// bulk-regen pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockSummary {
    pub actor: Actor,
}
