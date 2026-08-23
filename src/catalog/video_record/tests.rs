use super::*;
use crate::catalog::errors::CatalogError;
use crate::catalog::events::{CatalogEvent, MetadataEdits};
use crate::catalog::value_objects::{LocationRole, Platform};
use uuid::Uuid;

fn make_index_cmd() -> IndexVideo {
    IndexVideo {
        source_id: "zoom-123".to_string(),
        source_platform: SourcePlatform::Zoom,
        title: "Weekly Standup".to_string(),
        description: Some("Team standup recording".to_string()),
        duration_seconds: 1800,
        participants: vec!["alice@co.com".to_string(), "bob@co.com".to_string()],
        transcript_text: Some("Hello everyone...".to_string()),
        download_url: "https://zoom.us/rec/123".to_string(),
        thumbnail_url: Some("https://zoom.us/thumb/123".to_string()),
        tags: vec!["standup".to_string(), "engineering".to_string()],
        metadata_extra: None,
        initial_owner: None,
        recorded_at: None,
        // ADR-065 — contributor attribution is optional; the default
        // (operator-submitted, no contributor) is what these tests
        // exercise. Tests covering the contributor path set them.
        contributor_email: None,
        contributor_chapter: None,
    }
}

fn admin_actor() -> Actor {
    Actor::new(Uuid::new_v4(), UserRole::Admin)
}

fn publisher_actor() -> Actor {
    Actor::new(Uuid::new_v4(), UserRole::Publisher)
}

fn viewer_actor() -> Actor {
    Actor::new(Uuid::new_v4(), UserRole::Viewer)
}

// ── Index ────────────────────────────────────────────────

#[test]
fn test_index_creates_discovered_video() {
    let cmd = make_index_cmd();
    let (record, events) = VideoRecord::index(cmd);

    assert_eq!(record.status, VideoStatus::Discovered);
    assert_eq!(record.title, "Weekly Standup");
    assert_eq!(record.source_platform, SourcePlatform::Zoom);
    assert_eq!(record.tags.len(), 2);
    assert!(record.notes.is_empty());
    assert!(record.owners.is_empty());
    assert!(record.moderators.is_empty());
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoIndexed(_)));
}

#[test]
fn test_index_with_initial_owner() {
    let owner_id = Uuid::new_v4();
    let mut cmd = make_index_cmd();
    cmd.initial_owner = Some(owner_id);

    let (record, _) = VideoRecord::index(cmd);
    assert_eq!(record.owners, vec![owner_id]);
}

// ── Approve ──────────────────────────────────────────────

#[test]
fn test_approve_from_discovered() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    let events = record.approve(ApproveVideo {
        actor,
        metadata_edits: None,
    });

    assert!(events.is_ok());
    assert_eq!(record.status, VideoStatus::Approved);
    let events = events.unwrap();
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoApproved(_)));
}

#[test]
fn test_approve_with_metadata_edits() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let owner_id = Uuid::new_v4();
    let actor = admin_actor();

    let events = record
        .approve(ApproveVideo {
            actor,
            metadata_edits: Some(MetadataEdits {
                title: Some("Renamed Standup".to_string()),
                tags: Some(vec!["weekly".to_string()]),
                owners: Some(vec![owner_id]),
                moderators: Some(vec![Uuid::new_v4()]),
                notes: Some(vec!["Looks good".to_string()]),
                ..Default::default()
            }),
        })
        .unwrap();

    assert_eq!(record.title, "Renamed Standup");
    assert_eq!(record.tags, vec!["weekly".to_string()]);
    assert_eq!(record.owners, vec![owner_id]);
    assert_eq!(record.moderators.len(), 1);
    assert_eq!(record.notes.len(), 1);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_approve_rejects_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.approve(ApproveVideo {
        actor: viewer_actor(),
        metadata_edits: None,
    });

    assert_eq!(result, Err(CatalogError::Unauthorized));
    assert_eq!(record.status, VideoStatus::Discovered);
}

#[test]
fn test_approve_rejects_already_published() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo {
        actor: admin_actor(),
        metadata_edits: None,
    }).unwrap();
    record.request_publish(RequestPublish {
        actor: admin_actor(),
    }).unwrap();
    record.mark_published(MarkPublished {
        destination_id: "yt-1".into(),
        destination_url: "https://youtube.com/1".into(),
        destination_platform: None,
    }).unwrap();

    let result = record.approve(ApproveVideo {
        actor: admin_actor(),
        metadata_edits: None,
    });
    assert!(matches!(
        result,
        Err(CatalogError::InvalidStatusTransition { .. })
    ));
}

// ── Skip ─────────────────────────────────────────────────

#[test]
fn test_skip_from_discovered() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let events = record
        .skip(SkipVideo {
            actor: publisher_actor(),
            reason: Some("Not relevant".to_string()),
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Skipped);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoSkipped(_)));
}

#[test]
fn test_skip_rejects_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.skip(SkipVideo {
        actor: viewer_actor(),
        reason: None,
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

// ── Publish lifecycle ────────────────────────────────────

#[test]
fn test_full_publish_lifecycle() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());

    // Approve
    record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Approved);

    // Request publish
    record
        .request_publish(RequestPublish {
            actor: admin_actor(),
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Publishing);

    // Mark published
    let events = record
        .mark_published(MarkPublished {
            destination_id: "yt-abc".to_string(),
            destination_url: "https://youtube.com/watch?v=abc".to_string(),
            destination_platform: None,
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Published);
    assert!(record.published_at.is_some());
    assert_eq!(record.destination_id, Some("yt-abc".to_string()));
    assert_eq!(events.len(), 1);
}

#[test]
fn test_publish_fails_then_retry() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();
    record
        .request_publish(RequestPublish {
            actor: admin_actor(),
        })
        .unwrap();

    // Fail
    record
        .mark_failed(MarkFailed {
            error_message: "Upload timeout".to_string(),
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Failed);

    // Re-approve from Failed
    record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Approved);
}

// ── Notes ────────────────────────────────────────────────

#[test]
fn test_add_note_by_admin() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    let events = record
        .add_note(AddNote {
            actor,
            text: "Needs review before publishing".to_string(),
        })
        .unwrap();

    assert_eq!(record.notes.len(), 1);
    assert_eq!(record.notes[0].text, "Needs review before publishing");
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::NoteAdded(_)));
}

#[test]
fn test_add_note_by_owner() {
    let owner_id = Uuid::new_v4();
    let mut cmd = make_index_cmd();
    cmd.initial_owner = Some(owner_id);
    let (mut record, _) = VideoRecord::index(cmd);

    let events = record
        .add_note(AddNote {
            actor: Actor::new(owner_id, UserRole::Viewer),
            text: "Owner note".to_string(),
        })
        .unwrap();

    assert_eq!(record.notes.len(), 1);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_add_note_by_moderator() {
    let mod_id = Uuid::new_v4();
    let (mut record, _) = VideoRecord::index(make_index_cmd());

    // First assign moderator
    record
        .assign_moderators(AssignModerators {
            actor: admin_actor(),
            moderators: vec![mod_id],
        })
        .unwrap();

    // Moderator adds note
    let events = record
        .add_note(AddNote {
            actor: Actor::new(mod_id, UserRole::Viewer),
            text: "Moderator feedback".to_string(),
        })
        .unwrap();

    assert_eq!(record.notes.len(), 1);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_add_empty_note_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.add_note(AddNote {
        actor: admin_actor(),
        text: "  ".to_string(),
    });
    assert_eq!(result, Err(CatalogError::EmptyNote));
}

#[test]
fn test_add_note_unauthorized_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.add_note(AddNote {
        actor: viewer_actor(),
        text: "Should not work".to_string(),
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

// ── Owners ───────────────────────────────────────────────

#[test]
fn test_assign_owners_by_admin() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let o1 = Uuid::new_v4();
    let o2 = Uuid::new_v4();

    let events = record
        .assign_owners(AssignOwners {
            actor: admin_actor(),
            owners: vec![o1, o2],
        })
        .unwrap();

    assert_eq!(record.owners, vec![o1, o2]);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::OwnersAssigned(_)));
}

#[test]
fn test_assign_owners_by_existing_owner() {
    let owner_id = Uuid::new_v4();
    let mut cmd = make_index_cmd();
    cmd.initial_owner = Some(owner_id);
    let (mut record, _) = VideoRecord::index(cmd);

    let new_owner = Uuid::new_v4();
    let events = record
        .assign_owners(AssignOwners {
            actor: Actor::new(owner_id, UserRole::Viewer),
            owners: vec![owner_id, new_owner],
        })
        .unwrap();

    assert_eq!(record.owners.len(), 2);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_assign_empty_owners_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.assign_owners(AssignOwners {
        actor: admin_actor(),
        owners: vec![],
    });
    assert_eq!(result, Err(CatalogError::OwnerRequired));
}

#[test]
fn test_assign_owners_unauthorized_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.assign_owners(AssignOwners {
        actor: viewer_actor(),
        owners: vec![Uuid::new_v4()],
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

#[test]
fn test_publisher_cannot_assign_owners() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.assign_owners(AssignOwners {
        actor: publisher_actor(),
        owners: vec![Uuid::new_v4()],
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

// ── Moderators ───────────────────────────────────────────

#[test]
fn test_assign_moderators_by_admin() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let m1 = Uuid::new_v4();

    let events = record
        .assign_moderators(AssignModerators {
            actor: admin_actor(),
            moderators: vec![m1],
        })
        .unwrap();

    assert_eq!(record.moderators, vec![m1]);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::ModeratorsAssigned(_)));
}

#[test]
fn test_assign_moderators_by_owner() {
    let owner_id = Uuid::new_v4();
    let mut cmd = make_index_cmd();
    cmd.initial_owner = Some(owner_id);
    let (mut record, _) = VideoRecord::index(cmd);

    let mod_id = Uuid::new_v4();
    let events = record
        .assign_moderators(AssignModerators {
            actor: Actor::new(owner_id, UserRole::Viewer),
            moderators: vec![mod_id],
        })
        .unwrap();

    assert_eq!(record.moderators, vec![mod_id]);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_assign_moderators_by_moderator() {
    let mod_id = Uuid::new_v4();
    let (mut record, _) = VideoRecord::index(make_index_cmd());

    // Admin assigns first moderator
    record
        .assign_moderators(AssignModerators {
            actor: admin_actor(),
            moderators: vec![mod_id],
        })
        .unwrap();

    // Moderator can assign more moderators
    let new_mod = Uuid::new_v4();
    let events = record
        .assign_moderators(AssignModerators {
            actor: Actor::new(mod_id, UserRole::Viewer),
            moderators: vec![mod_id, new_mod],
        })
        .unwrap();

    assert_eq!(record.moderators.len(), 2);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_clear_moderators() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .assign_moderators(AssignModerators {
            actor: admin_actor(),
            moderators: vec![Uuid::new_v4()],
        })
        .unwrap();

    // Empty list clears moderators
    record
        .assign_moderators(AssignModerators {
            actor: admin_actor(),
            moderators: vec![],
        })
        .unwrap();

    assert!(record.moderators.is_empty());
}

#[test]
fn test_assign_moderators_unauthorized_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.assign_moderators(AssignModerators {
        actor: viewer_actor(),
        moderators: vec![Uuid::new_v4()],
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

// ── Update metadata ──────────────────────────────────────

#[test]
fn test_update_metadata_tags_and_description() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let events = record
        .update_metadata(UpdateMetadata {
            actor: admin_actor(),
            edits: MetadataEdits {
                description: Some("Updated description".to_string()),
                tags: Some(vec!["rust".to_string(), "wasm".to_string()]),
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(record.description, Some("Updated description".to_string()));
    assert_eq!(record.tags, vec!["rust", "wasm"]);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::MetadataUpdated(_)));
}

#[test]
fn test_update_metadata_extra_merges_shallow() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    // Seed one key so we can prove non-touched keys survive.
    record.metadata_extra = Some(serde_json::json!({ "existing_key": "keep_me" }));

    record
        .update_metadata(UpdateMetadata {
            actor: admin_actor(),
            edits: MetadataEdits {
                metadata_extra: Some(serde_json::json!({
                    "opus_clip_job_id": "P30726134uS0",
                    "opus_project_url": "https://clip.opus.pro/clip/P30726134uS0",
                })),
                ..Default::default()
            },
        })
        .unwrap();

    let extra = record.metadata_extra.clone().unwrap();
    assert_eq!(extra["existing_key"], "keep_me");
    assert_eq!(extra["opus_clip_job_id"], "P30726134uS0");
    assert_eq!(extra["opus_project_url"], "https://clip.opus.pro/clip/P30726134uS0");
}

#[test]
fn test_update_metadata_extra_null_removes_key() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.metadata_extra = Some(serde_json::json!({ "stale": "value", "keep": "kept" }));

    record
        .update_metadata(UpdateMetadata {
            actor: admin_actor(),
            edits: MetadataEdits {
                metadata_extra: Some(serde_json::json!({ "stale": null })),
                ..Default::default()
            },
        })
        .unwrap();

    let extra = record.metadata_extra.clone().unwrap();
    assert!(extra.get("stale").is_none());
    assert_eq!(extra["keep"], "kept");
}

// ── Serialization roundtrip ──────────────────────────────

#[test]
fn test_json_roundtrip() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .add_note(AddNote {
            actor: admin_actor(),
            text: "Test note".to_string(),
        })
        .unwrap();
    record
        .assign_owners(AssignOwners {
            actor: admin_actor(),
            owners: vec![Uuid::new_v4()],
        })
        .unwrap();

    let json = record.to_json().unwrap();
    let restored = VideoRecord::from_json(&json).unwrap();

    assert_eq!(restored.id, record.id);
    assert_eq!(restored.title, record.title);
    assert_eq!(restored.notes.len(), 1);
    assert_eq!(restored.owners.len(), 1);
    assert_eq!(restored.status, record.status);
}

// ── Locations ────────────────────────────────────────────

#[test]
fn test_index_creates_origin_location() {
    let (record, _) = VideoRecord::index(make_index_cmd());
    assert_eq!(record.locations.len(), 1);
    assert_eq!(record.locations[0].role, LocationRole::Origin);
    assert_eq!(record.locations[0].platform, Platform::Zoom);
    assert_eq!(record.locations[0].external_id, "zoom-123");
    assert_eq!(record.locations[0].external_url, Some("https://zoom.us/rec/123".to_string()));
}

#[test]
fn test_add_location_intermediate() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    let events = record
        .add_location(AddLocation {
            actor,
            platform: Platform::Loom,
            external_id: "loom-456".to_string(),
            external_url: Some("https://loom.com/share/456".to_string()),
            role: LocationRole::Intermediate,
            ordinal: None,
        })
        .unwrap();

    assert_eq!(record.locations.len(), 2);
    assert_eq!(record.locations[1].platform, Platform::Loom);
    assert_eq!(record.locations[1].role, LocationRole::Intermediate);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::LocationAdded(_)));
}

#[test]
fn test_add_location_duplicate_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    // Origin already has Zoom/zoom-123, try adding same
    let result = record.add_location(AddLocation {
        actor,
        platform: Platform::Zoom,
        external_id: "zoom-123".to_string(),
        external_url: None,
        role: LocationRole::Origin,
        ordinal: None,
    });

    assert!(matches!(result, Err(CatalogError::DuplicateLocation { .. })));
}

#[test]
fn test_remove_location() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    // Add then remove
    record
        .add_location(AddLocation {
            actor,
            platform: Platform::Loom,
            external_id: "loom-789".to_string(),
            external_url: None,
            role: LocationRole::Intermediate,
            ordinal: None,
        })
        .unwrap();
    assert_eq!(record.locations.len(), 2);

    let events = record
        .remove_location(RemoveLocation {
            actor,
            platform: Platform::Loom,
            external_id: "loom-789".to_string(),
        })
        .unwrap();

    assert_eq!(record.locations.len(), 1);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::LocationRemoved(_)));
}

#[test]
fn test_remove_location_not_found() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.remove_location(RemoveLocation {
        actor: admin_actor(),
        platform: Platform::Kaltura,
        external_id: "nonexistent".to_string(),
    });
    assert!(matches!(result, Err(CatalogError::LocationNotFound { .. })));
}

#[test]
fn test_add_location_unauthorized_viewer() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.add_location(AddLocation {
        actor: viewer_actor(),
        platform: Platform::Loom,
        external_id: "loom-1".to_string(),
        external_url: None,
        role: LocationRole::Intermediate,
        ordinal: None,
    });
    assert_eq!(result, Err(CatalogError::Unauthorized));
}

#[test]
fn test_mark_published_adds_destination_location() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record
        .mark_published(MarkPublished {
            destination_id: "yt-abc".to_string(),
            destination_url: "https://youtube.com/watch?v=abc".to_string(),
            destination_platform: None,
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Published);
    // Should have Origin + Destination
    assert_eq!(record.locations.len(), 2);
    let dest = record.locations.iter().find(|l| l.role == LocationRole::Destination).unwrap();
    assert_eq!(dest.platform, Platform::YouTube);
    assert_eq!(dest.external_id, "yt-abc");
}

// ── InScope ──────────────────────────────────────────────

#[test]
fn test_mark_in_scope_from_discovered_succeeds() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let events = record
        .mark_in_scope(MarkInScope {
            actor: admin_actor(),
            rule_id: Some("rule-1".to_string()),
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::InScope);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoScoped(_)));
}

#[test]
fn test_mark_in_scope_from_approved_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();

    let result = record.mark_in_scope(MarkInScope {
        actor: admin_actor(),
        rule_id: None,
    });
    assert!(matches!(
        result,
        Err(CatalogError::InvalidStatusTransition { .. })
    ));
}

#[test]
fn test_approve_from_in_scope_succeeds() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .mark_in_scope(MarkInScope {
            actor: admin_actor(),
            rule_id: None,
        })
        .unwrap();

    let events = record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Approved);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_skip_from_in_scope_succeeds() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record
        .mark_in_scope(MarkInScope {
            actor: admin_actor(),
            rule_id: None,
        })
        .unwrap();

    let events = record
        .skip(SkipVideo {
            actor: publisher_actor(),
            reason: Some("Not needed".to_string()),
        })
        .unwrap();
    assert_eq!(record.status, VideoStatus::Skipped);
    assert_eq!(events.len(), 1);
}

// ── Update Location Status ───────────────────────────────

#[test]
fn test_update_location_status() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let events = record
        .update_location_status(UpdateLocationStatus {
            actor: admin_actor(),
            platform: Platform::Zoom,
            external_id: "zoom-123".to_string(),
            status: "Processing".to_string(),
        })
        .unwrap();

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::LocationStatusUpdated(_)));
    assert_eq!(record.locations[0].status, Some("Processing".to_string()));
}

#[test]
fn test_update_location_status_not_found() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.update_location_status(UpdateLocationStatus {
        actor: admin_actor(),
        platform: Platform::YouTube,
        external_id: "nonexistent".to_string(),
        status: "Live".to_string(),
    });
    assert!(matches!(result, Err(CatalogError::LocationNotFound { .. })));
}

// ── Abandon ──────────────────────────────────────────────

#[test]
fn test_abandon_from_failed() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_failed(MarkFailed { error_message: "timeout".into() }).unwrap();

    let events = record
        .abandon(AbandonVideo {
            actor: admin_actor(),
            reason: Some("Giving up".to_string()),
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Abandoned);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoAbandoned(_)));
}

#[test]
fn test_abandon_from_discovered() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let events = record
        .abandon(AbandonVideo {
            actor: admin_actor(),
            reason: None,
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Abandoned);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_abandon_from_published_succeeds() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_published(MarkPublished {
        destination_id: "yt-1".into(),
        destination_url: "https://youtube.com/1".into(),
        destination_platform: None,
    }).unwrap();

    let events = record.abandon(AbandonVideo {
        actor: admin_actor(),
        reason: Some("Video removed from YouTube".to_string()),
    }).unwrap();
    assert_eq!(record.status, VideoStatus::Abandoned);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_mark_to_retry_from_published() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_published(MarkPublished {
        destination_id: "yt-1".into(),
        destination_url: "https://youtube.com/1".into(),
        destination_platform: None,
    }).unwrap();

    let events = record.mark_to_retry(MarkToRetry {
        actor: admin_actor(),
        reason: Some("Re-upload needed".to_string()),
    }).unwrap();
    assert_eq!(record.status, VideoStatus::ToRetry);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_mark_failed_from_published() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_published(MarkPublished {
        destination_id: "yt-1".into(),
        destination_url: "https://youtube.com/1".into(),
        destination_platform: None,
    }).unwrap();

    let events = record.mark_failed(MarkFailed {
        error_message: "YouTube processing failed".to_string(),
    }).unwrap();
    assert_eq!(record.status, VideoStatus::Failed);
    assert_eq!(events.len(), 1);
}

#[test]
fn test_abandon_from_approved_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();

    let result = record.abandon(AbandonVideo {
        actor: admin_actor(),
        reason: None,
    });
    assert!(matches!(result, Err(CatalogError::InvalidStatusTransition { .. })));
}

// ── ToRetry ──────────────────────────────────────────────

#[test]
fn test_mark_to_retry_from_failed() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_failed(MarkFailed { error_message: "timeout".into() }).unwrap();

    let events = record
        .mark_to_retry(MarkToRetry {
            actor: admin_actor(),
            reason: Some("Will retry later".to_string()),
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::ToRetry);
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0], CatalogEvent::VideoMarkedToRetry(_)));
}

#[test]
fn test_mark_to_retry_from_discovered_fails() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let result = record.mark_to_retry(MarkToRetry {
        actor: admin_actor(),
        reason: None,
    });
    assert!(matches!(result, Err(CatalogError::InvalidStatusTransition { .. })));
}

#[test]
fn test_approve_from_to_retry() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();
    record.mark_failed(MarkFailed { error_message: "timeout".into() }).unwrap();
    record.mark_to_retry(MarkToRetry { actor: admin_actor(), reason: None }).unwrap();

    let events = record
        .approve(ApproveVideo {
            actor: admin_actor(),
            metadata_edits: None,
        })
        .unwrap();

    assert_eq!(record.status, VideoStatus::Approved);
    assert_eq!(events.len(), 1);
}

// ── Recorded At ──────────────────────────────────────────

#[test]
fn test_index_with_recorded_at() {
    let mut cmd = make_index_cmd();
    cmd.recorded_at = Some("2024-06-15T10:30:00Z".to_string());
    let (record, _) = VideoRecord::index(cmd);

    assert!(record.recorded_at.is_some());
    assert_eq!(record.recorded_at.unwrap().to_rfc3339().contains("2024-06-15"), true);
}

#[test]
fn test_metadata_edit_recorded_at() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    assert!(record.recorded_at.is_none());

    record
        .update_metadata(UpdateMetadata {
            actor: admin_actor(),
            edits: MetadataEdits {
                recorded_at: Some("2024-01-01T00:00:00Z".to_string()),
                ..Default::default()
            },
        })
        .unwrap();

    assert!(record.recorded_at.is_some());
}

#[test]
fn test_add_location_with_ordinal() {
    let (mut record, _) = VideoRecord::index(make_index_cmd());
    let actor = admin_actor();

    record
        .add_location(AddLocation {
            actor,
            platform: Platform::Loom,
            external_id: "loom-ord".to_string(),
            external_url: None,
            role: LocationRole::Intermediate,
            ordinal: Some(3),
        })
        .unwrap();

    assert_eq!(record.locations.len(), 2);
    assert_eq!(record.locations[1].ordinal, 3);
}

/// ADR-049 slice 1: a YouTube Live record's Origin location uses the
/// prefixed source_id ("youtube-X"); a later add_location attempt
/// using the bare YouTube ID ("X") points to the same video and must
/// be rejected as a duplicate across roles.
#[test]
fn test_add_location_dedupes_across_roles_normalizing_prefix() {
    let mut cmd = make_index_cmd();
    cmd.source_platform = SourcePlatform::YouTube;
    cmd.source_id = "youtube-WQov-UkWpoA".to_string();
    let (mut record, _) = VideoRecord::index(cmd);

    // Sanity: the Origin location was created with the prefixed id.
    assert_eq!(record.locations.len(), 1);
    assert_eq!(record.locations[0].external_id, "youtube-WQov-UkWpoA");
    assert_eq!(record.locations[0].role, LocationRole::Origin);

    // Add Destination with the bare YouTube id — should be rejected
    // because (YouTube, "youtube-WQov-UkWpoA") normalises to the
    // same video as (YouTube, "WQov-UkWpoA").
    let result = record.add_location(AddLocation {
        actor: admin_actor(),
        platform: Platform::YouTube,
        external_id: "WQov-UkWpoA".to_string(),
        external_url: Some("https://www.youtube.com/watch?v=WQov-UkWpoA".to_string()),
        role: LocationRole::Destination,
        ordinal: None,
    });

    assert!(matches!(result, Err(CatalogError::DuplicateLocation { .. })));
    assert_eq!(record.locations.len(), 1, "no second entry should be added");
}

/// ADR-049 slice 1: mark_published on a YouTube-source record where
/// the Origin already covers the same video silently skips the
/// Destination push (matches its pre-existing dedupe contract) once
/// the normalised id is considered.
#[test]
fn test_mark_published_skips_redundant_destination_for_same_video() {
    let mut cmd = make_index_cmd();
    cmd.source_platform = SourcePlatform::YouTube;
    cmd.source_id = "youtube-WQov-UkWpoA".to_string();
    let (mut record, _) = VideoRecord::index(cmd);

    // Walk through approve → request_publish so mark_published is callable.
    record.approve(ApproveVideo { actor: admin_actor(), metadata_edits: None }).unwrap();
    record.request_publish(RequestPublish { actor: admin_actor() }).unwrap();

    let before = record.locations.len();
    record
        .mark_published(MarkPublished {
            destination_id: "WQov-UkWpoA".to_string(),  // bare YouTube id
            destination_url: "https://www.youtube.com/watch?v=WQov-UkWpoA".to_string(),
            destination_platform: Some(Platform::YouTube),
        })
        .unwrap();

    assert_eq!(record.locations.len(), before, "no redundant Destination entry");
    // The single existing location is still the Origin — destination
    // role does NOT get added because the same-video check matched.
    assert_eq!(record.locations[0].role, LocationRole::Origin);
}
