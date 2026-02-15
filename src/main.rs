use uuid::Uuid;
use video_sync::catalog::commands::*;
use video_sync::catalog::events::MetadataEdits;
use video_sync::catalog::value_objects::*;

fn main() {
    println!("=== Video Sync — Catalog Domain Demo ===\n");

    let admin = Actor::new(Uuid::new_v4(), UserRole::Admin);

    // 1. Index a new video
    let cmd = IndexVideo {
        source_id: "zoom-abc-123".into(),
        source_platform: SourcePlatform::Zoom,
        title: "Weekly Engineering Standup".into(),
        description: Some("Team standup recording from Monday".into()),
        duration_seconds: 1800,
        participants: vec!["alice@co.com".into(), "bob@co.com".into()],
        transcript_text: Some("Hello everyone, let's get started...".into()),
        download_url: "https://zoom.us/rec/abc123".into(),
        thumbnail_url: Some("https://zoom.us/thumb/abc123".into()),
        tags: vec!["standup".into(), "engineering".into()],
        metadata_extra: None,
        initial_owner: Some(admin.user_id),
    };

    let (mut record, events) = video_sync::VideoRecord::index(cmd);
    println!("1. Indexed video: {}", record.id);
    println!("   Status: {:?}", record.status);
    println!("   Events: {}\n", format_events(&events));

    // 2. Add a note
    let events = record
        .add_note(AddNote {
            actor: admin,
            text: "Good content, approve after review".into(),
        })
        .unwrap();
    println!("2. Added note");
    println!("   Notes: {}", record.notes.len());
    println!("   Events: {}\n", format_events(&events));

    // 3. Approve with metadata edits
    let events = record
        .approve(ApproveVideo {
            actor: admin,
            metadata_edits: Some(MetadataEdits {
                title: Some("Weekly Eng Standup — Jan 13".into()),
                tags: Some(vec!["standup".into(), "engineering".into(), "weekly".into()]),
                ..Default::default()
            }),
        })
        .unwrap();
    println!("3. Approved video");
    println!("   Status: {:?}", record.status);
    println!("   Title:  {}", record.title);
    println!("   Tags:   {:?}", record.tags);
    println!("   Events: {}\n", format_events(&events));

    // 4. Request publish
    let events = record
        .request_publish(RequestPublish { actor: admin })
        .unwrap();
    println!("4. Requested publish");
    println!("   Status: {:?}", record.status);
    println!("   Events: {}\n", format_events(&events));

    // 5. Mark published
    let events = record
        .mark_published(MarkPublished {
            destination_id: "yt-xyz789".into(),
            destination_url: "https://youtube.com/watch?v=xyz789".into(),
            destination_platform: None,
        })
        .unwrap();
    println!("5. Published!");
    println!("   Status:    {:?}", record.status);
    println!("   Dest URL:  {:?}", record.destination_url);
    println!("   Published: {:?}", record.published_at);
    println!("   Events: {}\n", format_events(&events));

    // 6. JSON roundtrip
    let json = record.to_json().unwrap();
    let restored = video_sync::VideoRecord::from_json(&json).unwrap();
    println!("6. JSON roundtrip OK — restored id: {}", restored.id);
    println!("\n=== Done ===");
}

fn format_events(events: &[video_sync::catalog::events::CatalogEvent]) -> String {
    events
        .iter()
        .map(|e| match e {
            video_sync::catalog::events::CatalogEvent::VideoIndexed(_) => "VideoIndexed",
            video_sync::catalog::events::CatalogEvent::VideoApproved(_) => "VideoApproved",
            video_sync::catalog::events::CatalogEvent::VideoSkipped(_) => "VideoSkipped",
            video_sync::catalog::events::CatalogEvent::NoteAdded(_) => "NoteAdded",
            video_sync::catalog::events::CatalogEvent::OwnersAssigned(_) => "OwnersAssigned",
            video_sync::catalog::events::CatalogEvent::ModeratorsAssigned(_) => {
                "ModeratorsAssigned"
            }
            video_sync::catalog::events::CatalogEvent::MetadataUpdated(_) => "MetadataUpdated",
            video_sync::catalog::events::CatalogEvent::StatusChanged(_) => "StatusChanged",
            video_sync::catalog::events::CatalogEvent::LocationAdded(_) => "LocationAdded",
            video_sync::catalog::events::CatalogEvent::LocationRemoved(_) => "LocationRemoved",
        })
        .collect::<Vec<_>>()
        .join(", ")
}
