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
    /// ADR-077 §1 — one entry per declared destination, carrying how far
    /// it got and what visibility it has. `destination_id` /
    /// `destination_url` above are the legacy scalars, kept in the JSON
    /// shape for the ~24 read sites that predate this field and
    /// synchronised from the primary outcome on every change.
    ///
    /// `#[serde(default)]` matters: every record already on disk
    /// deserialises with an empty vec, and `hydrate_outcomes` then
    /// synthesises outcomes from existing Destination locations on read.
    /// That is the whole migration — there is no backfill script.
    #[serde(default)]
    pub destination_outcomes: Vec<DestinationOutcome>,
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
    // ── ADR-065: community contributor attribution ───────────────────
    /// Workspace email of the contributor who ingested this record
    /// (when their effective role at ingest time was Contributor, or
    /// when a Publisher imported "on behalf of" a contributor).
    /// Absent for curator-imported records that predate ADR-065.
    #[serde(default)]
    pub contributor_email: Option<String>,
    /// Free-text chapter name the contributor is associated with
    /// (e.g. "Agentics Toronto"). Set alongside contributor_email at
    /// ingest time. Not enforced against any registry — chapter names
    /// can grow ad-hoc.
    #[serde(default)]
    pub contributor_chapter: Option<String>,
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
            destination_outcomes: Vec::new(),
            locations: vec![origin_location],
            upstream_links: Vec::new(),
            rejected_links: Vec::new(),
            summary_doc_id: None,
            summary_prompt_version: None,
            summary_locked: false,
            summary_counts: None,
            summary_generated_at: None,
            contributor_email: cmd.contributor_email,
            contributor_chapter: cmd.contributor_chapter,
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

    // ── ADR-077 §1: per-destination publish ───────────────────────────

    /// Open a publish over a resolved destination set (ADR-077 §1).
    ///
    /// Seeds one `Pending` outcome per declared destination and moves
    /// the record to `Publishing`. Outcomes that already landed are
    /// preserved — re-publishing a record that is already on YouTube and
    /// now also wants Kaltura must not forget the YouTube copy.
    pub fn begin_publish(&mut self, cmd: BeginPublish) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if !self.status.can_publish() {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Publishing,
            });
        }

        self.hydrate_outcomes();
        for declared in &cmd.destinations {
            match self
                .destination_outcomes
                .iter_mut()
                .find(|o| o.platform == declared.platform)
            {
                // Already landed — refresh the intent, keep the result.
                Some(existing) if existing.state == OutcomeState::Pushed => {
                    existing.declared_visibility = declared.visibility.clone();
                }
                Some(existing) => {
                    existing.declared_visibility = declared.visibility.clone();
                    existing.state = OutcomeState::Pending;
                    existing.error = None;
                }
                None => self.destination_outcomes.push(DestinationOutcome::pending(
                    declared.platform,
                    declared.visibility.clone(),
                )),
            }
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

    /// Report the result of pushing one destination (ADR-077 §1).
    ///
    /// Legal from both `Publishing` and `Published`. That is the point:
    /// adding a peer destination to an already-published record used to
    /// require `add_location`, which bypassed the state machine and left
    /// no publish event behind.
    ///
    /// Status effects, per ADR-077 §Decisions-resolved #1:
    ///   - first success from `Publishing` → `Published` ("at least one
    ///     destination landed")
    ///   - success from `Published` → status unchanged, outcome recorded
    ///   - failure → status unchanged, UNLESS nothing landed and nothing
    ///     is still pending, in which case the whole publish failed and
    ///     the record goes to `Failed` rather than sitting in
    ///     `Publishing` forever
    pub fn record_destination_result(
        &mut self,
        cmd: RecordDestinationResult,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        if !cmd.actor.is_admin_or_publisher() {
            return Err(CatalogError::Unauthorized);
        }
        if self.status != VideoStatus::Publishing && self.status != VideoStatus::Published {
            return Err(CatalogError::InvalidStatusTransition {
                from: self.status,
                to: VideoStatus::Published,
            });
        }

        self.hydrate_outcomes();
        let now = Utc::now();
        let mut events: Vec<CatalogEvent> = Vec::new();

        // An undeclared destination is still recorded — an operator
        // adding one ad hoc shouldn't lose the outcome.
        if !self
            .destination_outcomes
            .iter()
            .any(|o| o.platform == cmd.platform)
        {
            self.destination_outcomes
                .push(DestinationOutcome::pending(cmd.platform, None));
        }

        let declared_visibility = {
            let outcome = self
                .destination_outcomes
                .iter_mut()
                .find(|o| o.platform == cmd.platform)
                .expect("outcome present: inserted above when absent");

            match &cmd.error {
                Some(err) => {
                    outcome.state = OutcomeState::Failed;
                    outcome.error = Some(err.clone());
                }
                None => {
                    let external_id = cmd.external_id.clone().ok_or_else(|| {
                        CatalogError::InvalidCommand {
                            reason: "external_id required when recording a successful \
                                     destination push"
                                .to_string(),
                        }
                    })?;
                    outcome.state = OutcomeState::Pushed;
                    outcome.external_id = Some(external_id);
                    outcome.external_url = cmd.external_url.clone();
                    outcome.pushed_at = Some(now);
                    outcome.error = None;
                }
            }
            outcome.declared_visibility.clone()
        };

        match &cmd.error {
            Some(err) => {
                events.push(CatalogEvent::DestinationFailed(DestinationFailed {
                    event_id: Uuid::new_v4(),
                    timestamp: now,
                    video_record_id: self.id,
                    platform: cmd.platform,
                    error: err.clone(),
                }));

                // Whole publish failed only if nothing landed and nothing
                // is still in flight.
                let any_pushed = self
                    .destination_outcomes
                    .iter()
                    .any(|o| o.state == OutcomeState::Pushed);
                let any_pending = self
                    .destination_outcomes
                    .iter()
                    .any(|o| o.state == OutcomeState::Pending);
                if self.status == VideoStatus::Publishing && !any_pushed && !any_pending {
                    let from = self.status;
                    self.status = VideoStatus::Failed;
                    events.push(CatalogEvent::StatusChanged(StatusChanged {
                        event_id: Uuid::new_v4(),
                        timestamp: now,
                        video_record_id: self.id,
                        from,
                        to: VideoStatus::Failed,
                    }));
                }
            }
            None => {
                let external_id = cmd
                    .external_id
                    .clone()
                    .expect("external_id validated above");
                self.upsert_destination_location(
                    cmd.platform,
                    external_id.clone(),
                    cmd.external_url.clone(),
                    now,
                );
                events.push(CatalogEvent::DestinationPublished(DestinationPublished {
                    event_id: Uuid::new_v4(),
                    timestamp: now,
                    video_record_id: self.id,
                    platform: cmd.platform,
                    external_id,
                    external_url: cmd.external_url.clone(),
                    declared_visibility,
                }));

                if self.status == VideoStatus::Publishing {
                    let from = self.status;
                    self.status = VideoStatus::Published;
                    self.published_at = Some(now);
                    events.push(CatalogEvent::StatusChanged(StatusChanged {
                        event_id: Uuid::new_v4(),
                        timestamp: now,
                        video_record_id: self.id,
                        from,
                        to: VideoStatus::Published,
                    }));
                }
            }
        }

        self.sync_destination_scalars();
        Ok(events)
    }

    /// Record a visibility read-back from a platform (ADR-077 §1/§5).
    ///
    /// Emits no event: this is an observation of external state, swept
    /// periodically, and eventing every sweep would drown the log. The
    /// value lands on the outcome where §6 can compare it against
    /// `declared_visibility`.
    pub fn record_observed_visibility(
        &mut self,
        cmd: RecordObservedVisibility,
    ) -> Result<Vec<CatalogEvent>, CatalogError> {
        self.hydrate_outcomes();
        let outcome = self
            .destination_outcomes
            .iter_mut()
            .find(|o| o.platform == cmd.platform)
            .ok_or_else(|| {
                CatalogError::InvalidCommand {
                    reason: format!("no destination outcome for platform {:?}", cmd.platform),
                }
            })?;
        outcome.observed_visibility = Some(cmd.visibility);
        outcome.observed_at = Some(Utc::now());
        Ok(Vec::new())
    }

    /// Destinations declared but not yet landed (ADR-077 §6).
    ///
    /// This is the conformance measurement: declared minus landed.
    /// `Skipped` destinations are excluded — the operator removed them
    /// deliberately. Manual `Other` targets never appear because
    /// `Platform` cannot represent them (ADR-077 §Deferred #2), which is
    /// exactly the exclusion §Decisions-resolved #3 commits to.
    pub fn missing_destinations(&self) -> Vec<Platform> {
        self.destination_outcomes
            .iter()
            .filter(|o| matches!(o.state, OutcomeState::Pending | OutcomeState::Failed))
            .map(|o| o.platform)
            .collect()
    }

    /// True when every declared, non-skipped destination landed.
    ///
    /// Distinct from `status == Published`, which per
    /// §Decisions-resolved #1 means only "at least one landed".
    pub fn is_fully_published(&self) -> bool {
        let tracked: Vec<&DestinationOutcome> = self
            .destination_outcomes
            .iter()
            .filter(|o| o.state != OutcomeState::Skipped)
            .collect();
        !tracked.is_empty() && tracked.iter().all(|o| o.state == OutcomeState::Pushed)
    }

    /// Backfill outcomes from existing Destination locations.
    ///
    /// The entire ADR-077 §1 migration. A record written before this
    /// field existed deserialises with no outcomes; its Destination
    /// locations are the historical record of what landed, so they
    /// become `Pushed` outcomes on first touch. Idempotent, and a no-op
    /// once any outcome exists.
    ///
    /// `declared_visibility` stays `None` for synthesised outcomes: what
    /// the series asked for at the time was never recorded, and guessing
    /// it from today's series definition would fabricate intent.
    pub fn hydrate_outcomes(&mut self) {
        if !self.destination_outcomes.is_empty() {
            return;
        }
        for loc in self
            .locations
            .iter()
            .filter(|l| l.role == LocationRole::Destination)
        {
            if self
                .destination_outcomes
                .iter()
                .any(|o| o.platform == loc.platform)
            {
                continue;
            }
            self.destination_outcomes.push(DestinationOutcome {
                platform: loc.platform,
                declared_visibility: None,
                state: OutcomeState::Pushed,
                external_id: Some(loc.external_id.clone()),
                external_url: loc.external_url.clone(),
                pushed_at: Some(loc.synced_at),
                observed_visibility: None,
                observed_at: None,
                error: None,
            });
        }
    }

    /// Add or refresh a Destination location for a platform, reusing
    /// ADR-049 slice 1's normalised-id dedupe so a born-on-platform
    /// record doesn't gain a redundant peer entry.
    fn upsert_destination_location(
        &mut self,
        platform: Platform,
        external_id: String,
        external_url: Option<String>,
        now: DateTime<Utc>,
    ) {
        let norm = platform.normalize_external_id(&external_id);
        let already = self.locations.iter().any(|l| {
            l.platform == platform && l.platform.normalize_external_id(&l.external_id) == norm
        });
        if already {
            return;
        }
        self.locations.push(PlatformLocation {
            platform,
            external_id,
            external_url,
            role: LocationRole::Destination,
            ordinal: 0,
            synced_at: now,
            status: None,
        });
    }

    /// Keep the legacy scalars pointing at the primary outcome.
    ///
    /// "Primary" is the YouTube copy when there is one, else the first
    /// destination that landed. YouTube is preferred purely for
    /// continuity: every existing reader of these fields was written
    /// when YouTube was the only destination, so this keeps their
    /// meaning stable rather than silently repointing them at a Drive
    /// file id.
    fn sync_destination_scalars(&mut self) {
        let primary = self
            .destination_outcomes
            .iter()
            .find(|o| o.state == OutcomeState::Pushed && o.platform == Platform::YouTube)
            .or_else(|| {
                self.destination_outcomes
                    .iter()
                    .find(|o| o.state == OutcomeState::Pushed)
            });
        if let Some(p) = primary {
            self.destination_id = p.external_id.clone();
            self.destination_url = p.external_url.clone();
        }
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
        // ADR-049 slice 1: dedupe across roles by normalising the
        // external_id (strip the platform prefix). For born-on-platform
        // records (YouTube Live broadcast → YouTube record), the Origin
        // location at import time already represents this video; the
        // Destination push here is a no-op rather than a redundant
        // entry like (Origin, "youtube-X") + (Destination, "X").
        let dest_norm = dest_platform.normalize_external_id(&dest_location.external_id);
        if !self.locations.iter().any(|l|
            l.platform == dest_location.platform
                && l.platform.normalize_external_id(&l.external_id) == dest_norm
        ) {
            self.locations.push(dest_location);
        }

        // ADR-077 §1 — the legacy single-destination path still records a
        // per-destination outcome, so records published through it stay
        // consistent with ones published through record_destination_result.
        // Without this, the outcome list would silently disagree with
        // locations[] for every publish made from a pre-§3 call site.
        self.hydrate_outcomes();
        match self
            .destination_outcomes
            .iter_mut()
            .find(|o| o.platform == dest_platform)
        {
            Some(existing) => {
                existing.state = OutcomeState::Pushed;
                existing.external_id = Some(self.destination_id.clone().unwrap_or_default());
                existing.external_url = self.destination_url.clone();
                existing.pushed_at = Some(now);
                existing.error = None;
            }
            None => self.destination_outcomes.push(DestinationOutcome {
                platform: dest_platform,
                declared_visibility: None,
                state: OutcomeState::Pushed,
                external_id: self.destination_id.clone(),
                external_url: self.destination_url.clone(),
                pushed_at: Some(now),
                observed_visibility: None,
                observed_at: None,
                error: None,
            }),
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

        // ADR-049 slice 1: dedupe across roles by normalising the
        // external_id (strip the platform prefix). An Origin entry of
        // "youtube-X" and a proposed Destination entry of "X" point
        // to the same YouTube video; reject the duplicate before it
        // produces the redundant-location mess on YouTube Live records.
        let new_norm = cmd.platform.normalize_external_id(&cmd.external_id);
        if self.locations.iter().any(|l|
            l.platform == cmd.platform
                && l.platform.normalize_external_id(&l.external_id) == new_norm
        ) {
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
        if let Some(ref extra_edit) = edits.metadata_extra {
            match extra_edit {
                serde_json::Value::Object(patch) => {
                    let mut current = match self.metadata_extra.take() {
                        Some(serde_json::Value::Object(m)) => m,
                        _ => serde_json::Map::new(),
                    };
                    for (k, v) in patch {
                        if v.is_null() {
                            current.remove(k);
                        } else {
                            current.insert(k.clone(), v.clone());
                        }
                    }
                    self.metadata_extra = Some(serde_json::Value::Object(current));
                }
                _ => {
                    self.metadata_extra = Some(extra_edit.clone());
                }
            }
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
