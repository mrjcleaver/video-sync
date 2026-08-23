/**
 * Normalise a Google Drive folder reference to a bare id.
 *
 * Series config sometimes stores a whole folder URL where an id is
 * expected, so both shapes have to work.
 *
 * One copy, three former homes: app/api/drive/publish/route.ts (where
 * exporting it broke Next's route contract and blocked deploy.sh's
 * pre-flight type check), the Drive publish adapter, and a local function
 * inside VideoCard. All three now import this.
 */

/** Drive folder ids are 25+ chars of URL-safe base64. */
export function extractDriveFolderId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const m1 = s.match(/\/folders\/([A-Za-z0-9_-]{20,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m2) return m2[1];
  // Bare-id fallback: alphanumeric + _ + - only, >= 20 chars.
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return s;   // leave anything else alone; the Drive API will 404 loudly
}
