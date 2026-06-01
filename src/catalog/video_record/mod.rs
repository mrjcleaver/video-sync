use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::catalog::commands::*;
use crate::catalog::errors::CatalogError;
use crate::catalog::events::*;
use crate::catalog::value_objects::*;

/// The central aggregate root of the Catalog context.
/// Represents a normalized view of a video from any source platform.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoRecord {
    pub id: Uuid,
    pub source_id: String,
    pub source_platform: SourcePlatform,
    pub title: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub duration_seconds: u32,
    pub participants: Vec<String>,
    pub transcript_text: Option<String>,
    pub download_url: String,
    pub thumbnail_url: Option<String>,
    pub tags: Vec<String>,
    pub notes: Vec<Note>,
    pub owners: Vec<Uuid>,
    pub moderators: Vec<Uuid>,
    pub metadata_extra: Option<serde_json::Value>,
    pub status: VideoStatus,
    pub curated_by: Option<Uuid>,
    pub curated_at: Option<DateTime<Utc>>,
    pub indexed_at: DateTime<Utc>,
    pub published_at: Option<DateTime<Utc>>,
    pub destination_id: Option<String>,
    pub destination_url: Option<String>,
    #[serde(default)]
    pub recorded_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub locations: Vec<PlatformLocation>,
    #[serde(default)]
    pub upstream_links: Vec<UpstreamLink>,
    #[serde(default)]
    pub rejected_links: Vec<RejectedLink>,
    // ── ADR-046: prompt-driven summary metadata ───────────────────────
    /// Drive file id of the summary Google Doc, when one exists.
    #[serde(default)]
    pub summary_doc_id: Option<String>,
    /// Monotonic version of the prompt that authored the current summary.
    #[serde(default)]
    pub summary_prompt_version: Option<u32>,
    /// When true, bulk-regen-on-prompt-bump skips this record.
    #[serde(default)]
    pub summary_locked: bool,
    /// Counts surfaced as M:NN L:NN T:NN C:NN in the Overview lozenge.
    #[serde(default)]
    pub summary_counts: Option<SummaryCounts>,
    /// When the current summary was generated. Surfaced as
    /// "Summary: prompt v3 · MMM DD" on the card. Cleared if a future
    /// flow removes the summary.
    #[serde(default)]
    pub summary_generated_at: Option<DateTime<Utc>>,
    pending_events: Vec<CatalogEvent>,
}

impl VideoRecord {
    // ── Factory ──────────────────────────────────────────────

    /// Create a new VideoRecord from an IndexVideo command.
    /// Status is set to `Discovered`. The video lands in the curation checklist.
    pub fn index(cmd: IndexVideo) -> (Self, Vec<CatalogEvent>) {
        let id = Uuid::new_v4();
        let now = Utc::now();

        let owners = match cmd.initial_owner {
            Some(owner) => vec![owner],
            None => Vec::new(),
        };

        let event = CatalogEvent::VideoIndexed(VideoIndexed {
            event_id: Uuid::new_v4(),
            timestamp: now,
            video_record_id: id,
            source_platform: cmd.source_platform,
            title: cmd.title.clone(),
        });

        let recorded_at = cmd.recorded_at.as_ref().and_then(|s| {
            DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.with_timezone(&Utc))
        });

        let origin_location = PlatformLocation {
            platform: Platform::from(cmd.source_platform),
            external_id: cmd.source_id.clone(),
            external_url: Some(cmd.download_url.clone()),
            role: LocationRole::Origin,
            ordinal: 0,
            synced_at: now,
            status: None,
        };

        let record = Self {
            id,
            source_id: cmd.source_id,
            source_platform: cmd.source_platform,
            title: cmd.title,
            description: cmd.description,
            created_at: now,
            duration_seconds: cmd.duration_seconds,
            participants: cmd.participants,
            transcript_text: cmd.transcript_text,
            download_url: cmd.download_url,
            thumbnail_url: cmd.thumbnail_url,
            tags: cmd.tags,
            notes: Vec::new(),
            owners,
            moderators: Vec::new(),
            metadata_extra: cmd.metadata_extra,
            status: VideoStatus::Discovered,
            curated_by: None,
            curated_at: None,
            indexed_at: now,
            recorded_at,
            published_at: None,
            destination_id: None,
            destination_url: None,
            locations: vec![origin_location],
            upstream_links: Vec::new(),
            rejected_links: Vec::new(),
            summary_doc_id: None,
            summary_prompt_version: None,
            summary_locked: false,
            summary_counts: None,
            summary_generated_at: None,
            pending_events: Vec::new(),
        };

        (record, vec![event])
    }

    // ── Authorization helpers ────────────────────────────────

    fn is_owner(&self, user_id: &Uuid) -> bool {
        self.owners.contains(user_id)
    }

    fn is_moderator(&self, user_id: &Uuid) -> bool {
        self.moderators.contains(user_id)
    }

    fn can_curate(&self, actor: &Actor) -> bool {
        actor.is_admin_or_publisher()
            || self.is_owner(&actor.user_id)
            || self.is_moderator(&actor.user_id)
    }

    fn can_assign_owners(&self, actor: &Actor) -> bool {
        actor.is_admin() || self.is_owner(&actor.user_id)
    }

    fn can_assign_moderators(&self, actor: &Actor) -> bool {
        actor.is_admin()
            || self.is_owner(&actor.user_id)
            || self.is_moderator(&actor.user_id)
    }

    // ── Commands ─────────────────────────────────────────────

    /// Mark this video as in-scope for batch ingestion.
    pub fn mark_in_scope(&mut self, cmd: MarkInScope) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_scope() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::InScope,
            });
        }

        self.status = VideoStatus::InScope;

        Ok(vec![CatalogEvent::VideoScoped(VideoScoped {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            scoped_by: cmd.actor.user_id,
            rule_id: cmd.rule_id,
        })])
    }

    /// Approve this video for publishing.
    /// Optionally applies metadata edits (title, description, tags, notes, owners, moderators).
    pub fn approve(&mut self, cmd: ApproveVideo) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_approve() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Approved,
            });
        }

        let previous_status = self.status;
        let mut events = Vec::new();

        // Apply metadata edits if provided
        if let Some(ref edits) = cmd.metadata_edits {
            self.apply_metadata_edits(edits, cmd.actor.user_id)?;
        }

        self.status = VideoStatus::Approved;
        self.curated_by = Some(cmd.actor.user_id);
        self.curated_at = Some(Utc::now());

        events.push(CatalogEvent::VideoApproved(VideoApproved {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            approved_by: cmd.actor.user_id,
            previous_status,
            metadata_edits: cmd.metadata_edits,
        }));

        Ok(events)
    }

    /// Skip this video from the curation checklist.
    pub fn skip(&mut self, cmd: SkipVideo) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_skip() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Skipped,
            });
        }

        self.status = VideoStatus::Skipped;
        self.curated_by = Some(cmd.actor.user_id);
        self.curated_at = Some(Utc::now());

        Ok(vec![CatalogEvent::VideoSkipped(VideoSkipped {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            skipped_by: cmd.actor.user_id,
            reason: cmd.reason,
        })])
    }

    /// Request publishing to a destination platform.
    pub fn request_publish(
        &mut self,
        cmd: RequestPublish,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_publish() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Publishing,
            });
        }

        let from = self.status;
        self.status = VideoStatus::Publishing;

        Ok(vec![CatalogEvent::StatusChanged(StatusChanged {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            from,
            to: VideoStatus::Publishing,
        })])
    }

    /// Mark this video as successfully published.
    pub fn mark_published(&mut self, cmd: MarkPublished) -> Result<Vec<CatalogEvent>, CatalogError> {
        if self.status != VideoStatus::Publishing {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Published,
            });
        }

        let from = self.status;
        let now = Utc::now();
        self.status = VideoStatus::Published;
        self.published_at = Some(now);
        self.destination_id = Some(cmd.destination_id.clone());
        self.destination_url = Some(cmd.destination_url.clone());

        let dest_platform = cmd.destination_platform.unwrap_or(Platform::YouTube);
        let dest_location = PlatformLocation {
            platform: dest_platform,
            external_id: cmd.destination_id,
            external_url: Some(cmd.destination_url),
            role: LocationRole::Destination,
            ordinal: 0,
            synced_at: now,
            status: None,
        };
        // Only add if not already present
        if !self.locations.iter().any(|l| l.platform == dest_location.platform && l.external_id == dest_location.external_id) {
            self.locations.push(dest_location);
        }

        Ok(vec![CatalogEvent::StatusChanged(StatusChanged {
            event_id: Uuid::new_v4(),
            timestamp: now,
            video_record_id: self.id,
            from,
            to: VideoStatus::Published,
        })])
    }

    /// Add a platform location to this video.
    pub fn add_location(&mut self, cmd: AddLocation) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        if self.locations.iter().any(|l| l.platform == cmd.platform && l.external_id == cmd.external_id) {
            return Err(CatalogError::DuplicateLocation {
                platform: cmd.platform,
                external_id: cmd.external_id,
            });
        }

        let now = Utc::now();
        self.locations.push(PlatformLocation {
            platform: cmd.platform,
            external_id: cmd.external_id.clone(),
            external_url: cmd.external_url.clone(),
            role: cmd.role,
            ordinal: cmd.ordinal.unwrap_or(0),
            synced_at: now,
            status: None,
        });

        Ok(vec![CatalogEvent::LocationAdded(LocationAdded {
            event_id: Uuid::new_v4(),
            timestamp: now,
            video_record_id: self.id,
            added_by: cmd.actor.user_id,
            platform: cmd.platform,
            external_id: cmd.external_id,
            external_url: cmd.external_url,
            role: cmd.role,
        })])
    }

    /// Remove a platform location from this video.
    pub fn remove_location(&mut self, cmd: RemoveLocation) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        let pos = self.locations.iter().position(|l| l.platform == cmd.platform && l.external_id == cmd.external_id);
        match pos {
            Some(idx) => {
                self.locations.remove(idx);
                Ok(vec![CatalogEvent::LocationRemoved(LocationRemoved {
                    event_id: Uuid::new_v4(),
                    timestamp: Utc::now(),
                    video_record_id: self.id,
                    removed_by: cmd.actor.user_id,
                    platform: cmd.platform,
                    external_id: cmd.external_id,
                })])
            }
            None => Err(CatalogError::LocationNotFound {
                platform: cmd.platform,
                external_id: cmd.external_id,
            }),
        }
    }

    /// Update the status of a specific platform location.
    pub fn update_location_status(
        &mut self,
        cmd: UpdateLocationStatus,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        let loc = self
            .locations
            .iter_mut()
            .find(|l| l.platform == cmd.platform && l.external_id == cmd.external_id);

        match loc {
            Some(location) => {
                let old_status = location.status.clone();
                location.status = Some(cmd.status.clone());
                Ok(vec![CatalogEvent::LocationStatusUpdated(
                    LocationStatusUpdated {
                        event_id: Uuid::new_v4(),
                        timestamp: Utc::now(),
                        video_record_id: self.id,
                        updated_by: cmd.actor.user_id,
                        platform: cmd.platform,
                        external_id: cmd.external_id,
                        old_status,
                        new_status: cmd.status,
                    },
                )])
            }
            None => Err(CatalogError::LocationNotFound {
                platform: cmd.platform,
                external_id: cmd.external_id,
            }),
        }
    }

    /// Abandon this video — terminal state, no further processing.
    pub fn abandon(&mut self, cmd: AbandonVideo) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_abandon() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Abandoned,
            });
        }

        let previous_status = self.status;
        self.status = VideoStatus::Abandoned;

        Ok(vec![CatalogEvent::VideoAbandoned(VideoAbandoned {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            abandoned_by: cmd.actor.user_id,
            previous_status,
            reason: cmd.reason,
        })])
    }

    /// Mark this video for retry after failure.
    pub fn mark_to_retry(&mut self, cmd: MarkToRetry) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_mark_to_retry() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::ToRetry,
            });
        }

        self.status = VideoStatus::ToRetry;

        Ok(vec![CatalogEvent::VideoMarkedToRetry(VideoMarkedToRetry {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            marked_by: cmd.actor.user_id,
            reason: cmd.reason,
        })])
    }

    /// Mark this video as failed to publish (or post-publish failure).
    pub fn mark_failed(&mut self, _cmd: MarkFailed) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !matches!(self.status, VideoStatus::Publishing | VideoStatus::Published) {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Failed,
            });
        }

        let from = self.status;
        self.status = VideoStatus::Failed;

        Ok(vec![CatalogEvent::StatusChanged(StatusChanged {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            from,
            to: VideoStatus::Failed,
        })])
    }

    /// Update mutable metadata fields.
    pub fn update_metadata(
        &mut self,
        cmd: UpdateMetadata,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        self.apply_metadata_edits(&cmd.edits, cmd.actor.user_id)?;

        Ok(vec![CatalogEvent::MetadataUpdated(MetadataUpdated {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            updated_by: cmd.actor.user_id,
            edits: cmd.edits,
        })])
    }

    /// Append an internal note to this video.
    pub fn add_note(&mut self, cmd: AddNote) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }
        if cmd.text.trim().is_empty() {
            return Err(CatalogError::EmptyNote);
        }

        let note = Note::new(cmd.actor.user_id, cmd.text.clone());
        let note_id = note.id;
        self.notes.push(note);

        Ok(vec![CatalogEvent::NoteAdded(NoteAdded {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            note_id,
            author_id: cmd.actor.user_id,
            text: cmd.text,
        })])
    }

    /// Set or update the owners list.
    pub fn assign_owners(
        &mut self,
        cmd: AssignOwners,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_assign_owners(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }
        if cmd.owners.is_empty() {
            return Err(CatalogError::OwnerRequired);
        }

        self.owners = cmd.owners.clone();

        Ok(vec![CatalogEvent::OwnersAssigned(OwnersAssigned {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            assigned_by: cmd.actor.user_id,
            owners: cmd.owners,
        })])
    }

    /// Set or update the moderators list.
    pub fn assign_moderators(
        &mut self,
        cmd: AssignModerators,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_assign_moderators(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        self.moderators = cmd.moderators.clone();

        Ok(vec![CatalogEvent::ModeratorsAssigned(ModeratorsAssigned {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            assigned_by: cmd.actor.user_id,
            moderators: cmd.moderators,
        })])
    }

    /// Link an upstream source to this video (child → parent provenance).
    pub fn link_upstream(&mut self, cmd: LinkUpstream) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        // Deduplicate: replace existing link for the same platform+external_id
        self.upstream_links
            .retain(|l| !(l.platform == cmd.platform && l.external_id == cmd.external_id));

        let now = Utc::now();
        self.upstream_links.push(UpstreamLink {
            video_id: cmd.video_id,
            platform: cmd.platform,
            external_id: cmd.external_id.clone(),
            account_hint: cmd.account_hint,
            relation: cmd.relation,
            linked_by: cmd.linked_by,
            linked_at: now,
        });

        Ok(vec![CatalogEvent::UpstreamLinked(UpstreamLinked {
            event_id: Uuid::new_v4(),
            timestamp: now,
            video_record_id: self.id,
            upstream_video_id: cmd.video_id,
            platform: cmd.platform,
            external_id: cmd.external_id,
            relation: cmd.relation,
            linked_by: cmd.linked_by,
        })])
    }

    /// Remove an upstream link from this video, optionally rejecting it to suppress re-suggestion.
    pub fn unlink_upstream(
        &mut self,
        cmd: UnlinkUpstream,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        let pos = self
            .upstream_links
            .iter()
            .position(|l| l.platform == cmd.platform && l.external_id == cmd.external_id);

        if pos.is_none() {
            return Err(CatalogError::LinkNotFound {
                platform: cmd.platform,
                external_id: cmd.external_id,
            });
        }
        self.upstream_links.remove(pos.unwrap());

        if cmd.reject {
            self.rejected_links.push(RejectedLink {
                platform: cmd.platform,
                external_id: cmd.external_id.clone(),
                rejected_at: Utc::now(),
            });
        }

        Ok(vec![CatalogEvent::UpstreamUnlinked(UpstreamUnlinked {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            platform: cmd.platform,
            external_id: cmd.external_id,
            rejected: cmd.reject,
        })])
    }

    // ── ADR-046: prompt-driven summary metadata ──────────────────

    /// Record a freshly generated summary Doc + its counts onto the
    /// record. Overwrites any previous summary metadata — callers that
    /// want to preserve the existing one should check `summary_locked`
    /// before invoking.
    pub fn set_summary_metadata(
        &mut self,
        cmd: SetSummaryMetadata,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }

        let now = Utc::now();
        // Parse the client-supplied timestamp if present; fall back to
        // server-side now() so the field is always populated.
        let generated_at = cmd.generated_at.as_ref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.with_timezone(&Utc)))
            .unwrap_or(now);

        self.summary_doc_id = Some(cmd.doc_id.clone());
        self.summary_prompt_version = Some(cmd.prompt_version);
        self.summary_counts = Some(cmd.counts);
        self.summary_generated_at = Some(generated_at);

        Ok(vec![CatalogEvent::SummaryGenerated(SummaryGenerated {
            event_id: Uuid::new_v4(),
            timestamp: now,
            video_record_id: self.id,
            doc_id: cmd.doc_id,
            prompt_version: cmd.prompt_version,
            counts: cmd.counts,
            generated_by: cmd.actor.user_id,
            generated_at,
        })])
    }

    /// Set summary_locked = true so bulk-regen-on-prompt-bump skips this
    /// record. Idempotent: locking an already-locked record is a no-op
    /// at the field level but still emits an event for audit.
    pub fn lock_summary(
        &mut self,
        cmd: LockSummary,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }
        self.summary_locked = true;
        Ok(vec![CatalogEvent::SummaryLocked(SummaryLocked {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            locked: true,
            actor: cmd.actor.user_id,
        })])
    }

    /// Set summary_locked = false. The record returns to the bulk-regen
    /// pool on the next prompt bump.
    pub fn unlock_summary(
        &mut self,
        cmd: UnlockSummary,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !self.can_curate(&cmd.actor) {
            return Err(CatalogError::Unauthorized);
        }
        self.summary_locked = false;
        Ok(vec![CatalogEvent::SummaryLocked(SummaryLocked {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            locked: false,
            actor: cmd.actor.user_id,
        })])
    }

    // ── Internal helpers ─────────────────────────────────────

    fn apply_metadata_edits(
        &mut self,
        edits: &MetadataEdits,
        author_id: Uuid,
    ) -> Result<(), CatalogError> {
        if let Some(ref title) = edits.title {
            self.title = title.clone();
        }
        if let Some(ref desc) = edits.description {
            self.description = Some(desc.clone());
        }
        if let Some(ref tags) = edits.tags {
            self.tags = tags.clone();
        }
        if let Some(ref note_texts) = edits.notes {
            for text in note_texts {
                if text.trim().is_empty() {
                    return Err(CatalogError::EmptyNote);
                }
                self.notes.push(Note::new(author_id, text.clone()));
            }
        }
        if let Some(ref owners) = edits.owners {
            if owners.is_empty() {
                return Err(CatalogError::OwnerRequired);
            }
            self.owners = owners.clone();
        }
        if let Some(ref moderators) = edits.moderators {
            self.moderators = moderators.clone();
        }
        if let Some(ref recorded_at_str) = edits.recorded_at {
            if let Ok(dt) = DateTime::parse_from_rfc3339(recorded_at_str) {
                self.recorded_at = Some(dt.with_timezone(&Utc));
            }
        }
        if let Some(ref transcript) = edits.transcript_text {
            self.transcript_text = Some(transcript.clone());
        }
        Ok(())
    }

    /// Take and clear pending domain events.
    pub fn take_events(&mut self) -> Vec<CatalogEvent> {
        std::mem::take(&mut self.pending_events)
    }

    /// Serialize to JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Deserialize from JSON.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

#[cfg(test)]
mod tests;
