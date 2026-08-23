/**
 * Tests for the ADR-075 destination capability flags.
 *
 * These two predicates drive what the Publish preview tells an operator,
 * and they drifted out of date once the Kaltura (ADR-037) and Drive
 * (ADR-075 §Follow-up #4) push endpoints shipped — the preview went on
 * labelling working automation "⚠ manual" for months. Pin both so the
 * next endpoint that lands has to update them deliberately.
 */

import { describe, it, expect } from "vitest";
import { isAutomatedDestination, appliesDeclaredVisibility, destinationLabel } from "../src/lib/destinationResolver";
import type { DestinationSpec } from "../src/lib/youtubeTitleAlign";

const YOUTUBE: DestinationSpec = { platform: "YouTube", visibility: "public" };
const KALTURA: DestinationSpec = { platform: "Kaltura", visibility: "members" };
const DRIVE: DestinationSpec = { platform: "GoogleDrive", folder_id: "abc123", share_scope: "org_restricted" };
const OTHER: DestinationSpec = { platform: "Other", label: "Vimeo", config: {} };

describe("isAutomatedDestination — can the tool push the media itself?", () => {
  it("is true for every platform with a push endpoint", () => {
    expect(isAutomatedDestination(YOUTUBE)).toBe(true);
    expect(isAutomatedDestination(KALTURA)).toBe(true);  // /api/kaltura/upload
    expect(isAutomatedDestination(DRIVE)).toBe(true);    // /api/drive/publish
  });

  it("is false for Other, which is declared-but-unwired by design", () => {
    expect(isAutomatedDestination(OTHER)).toBe(false);
  });
});

describe("appliesDeclaredVisibility — does the push honour the declared visibility?", () => {
  it("is true only for YouTube, which sends privacyStatus with the upload", () => {
    expect(appliesDeclaredVisibility(YOUTUBE)).toBe(true);
  });

  it("is false for Kaltura — the upload body carries no access-control id", () => {
    expect(appliesDeclaredVisibility(KALTURA)).toBe(false);
  });

  it("is false for Drive — the file inherits the folder's sharing", () => {
    expect(appliesDeclaredVisibility(DRIVE)).toBe(false);
  });

  it("is false for Other", () => {
    expect(appliesDeclaredVisibility(OTHER)).toBe(false);
  });

  it("never claims visibility is applied where the media isn't even pushed", () => {
    // Guards the pairing the Publish preview relies on: "we upload it but
    // you set visibility" is a valid state; "we set visibility but don't
    // upload it" is not.
    for (const d of [YOUTUBE, KALTURA, DRIVE, OTHER]) {
      if (appliesDeclaredVisibility(d)) expect(isAutomatedDestination(d)).toBe(true);
    }
  });
});

describe("destinationLabel", () => {
  it("names each platform with its own visibility vocabulary", () => {
    expect(destinationLabel(YOUTUBE)).toBe("YouTube (public)");
    expect(destinationLabel(KALTURA)).toBe("Kaltura (members)");
    expect(destinationLabel(DRIVE)).toBe("Drive folder (org_restricted)");
    expect(destinationLabel(OTHER)).toBe("Vimeo (manual)");
  });
});
