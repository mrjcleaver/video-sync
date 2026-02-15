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
            published_at: None,
            destination_id: None,
            destination_url: None,
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
        self.status = VideoStatus::Published;
        self.published_at = Some(Utc::now());
        self.destination_id = Some(cmd.destination_id);
        self.destination_url = Some(cmd.destination_url);

        Ok(vec![CatalogEvent::StatusChanged(StatusChanged {
            event_id: Uuid::new_v4(),
            timestamp: Utc::now(),
            video_record_id: self.id,
            from,
            to: VideoStatus::Published,
        })])
    }

    /// Mark this video as failed to publish.
    pub fn mark_failed(&mut self, _cmd: MarkFailed) -> Result<Vec<CatalogEvent>, CatalogError> {
        if self.status != VideoStatus::Publishing {
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
