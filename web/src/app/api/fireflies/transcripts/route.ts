/**
 * POST /api/fireflies/transcripts
 * Fetches transcripts from Fireflies.ai GraphQL API for a date range.
 * ADR-015 — Fireflies import integration.
 *
 * Credentials sent in POST body (ADR-011 credential-proxy pattern).
 */

import { NextRequest, NextResponse } from "next/server";
import { withRequestLogging, serverLog } from "../../../../lib/serverLogger";

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";
const PAGE_SIZE = 50; // Fireflies max per query

const TRANSCRIPTS_QUERY = `
  query GetTranscripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
    transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
      id
      title
      date
      duration
      organizer_email
      participants
      speakers { name }
      meeting_link
      audio_url
      video_url
      summary {
        gist
        overview
        action_items
        outline
      }
      sentences {
        speaker_name
        text
      }
    }
  }
`;

interface FirefliesSpeaker { name: string }
interface FirefliesSentence { speaker_name?: string; text: string }
interface FirefliesSummary {
  gist?: string;
  overview?: string;
  action_items?: string;
  outline?: string;
}
interface FirefliesTranscript {
  id: string;
  title: string;
  date: number;        // Unix ms timestamp
  duration: number;    // minutes
  organizer_email?: string;
  participants?: string[];
  speakers?: FirefliesSpeaker[];
  meeting_link?: string;
  audio_url?: string;
  video_url?: string;
  summary?: FirefliesSummary;
  sentences?: FirefliesSentence[];
}

/** Merge organizer + participants + speaker names, deduplicating. */
function buildParticipants(t: FirefliesTranscript): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  function add(s: string) {
    const key = s.trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); result.push(s.trim()); }
  }

  if (t.organizer_email) add(t.organizer_email);
  for (const p of t.participants ?? []) add(p);
  // Append speaker names not already represented by an email
  for (const sp of t.speakers ?? []) {
    const nameLower = sp.name.trim().toLowerCase();
    const alreadyCovered = [...seen].some((s) => s.includes(nameLower) || nameLower.includes(s.split("@")[0]));
    if (!alreadyCovered) add(sp.name);
  }

  return result;
}

/** Join sentences into plain text, marking speaker turn changes. */
function buildTranscriptText(sentences: FirefliesSentence[]): string {
  let text = "";
  let lastSpeaker = "";
  for (const s of sentences) {
    if (s.speaker_name && s.speaker_name !== lastSpeaker) {
      text += `[${s.speaker_name}] `;
      lastSpeaker = s.speaker_name;
    }
    text += s.text.trim() + " ";
  }
  return text.trim();
}

/** Normalise a raw Fireflies transcript to a VideoRecord-compatible shape. */
function normalise(t: FirefliesTranscript) {
  const transcriptText = t.sentences?.length
    ? buildTranscriptText(t.sentences)
    : null;

  const description = t.summary?.overview?.trim() || t.summary?.gist?.trim() || null;
  const downloadUrl = t.video_url || t.audio_url || null;

  const metadataExtra: Record<string, string> = {};
  if (t.meeting_link) metadataExtra.meeting_link = t.meeting_link;
  if (t.summary?.action_items) metadataExtra.action_items = t.summary.action_items;
  if (t.summary?.outline) metadataExtra.outline = t.summary.outline;

  return {
    source_id: `fireflies-${t.id}`,
    source_platform: "Fireflies",
    title: t.title || "(Untitled)",
    recorded_at: new Date(t.date).toISOString(),
    duration_seconds: Math.round((t.duration ?? 0) * 60),
    participants: buildParticipants(t),
    description,
    transcript_text: transcriptText,
    download_url: downloadUrl,
    tags: ["fireflies-import"],
    ...(Object.keys(metadataExtra).length > 0 ? { metadata_extra: metadataExtra } : {}),
  };
}

async function graphql(apiKey: string, variables: Record<string, unknown>) {
  const res = await fetch(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: TRANSCRIPTS_QUERY, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fireflies API error (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Fireflies GraphQL error: ${json.errors[0]?.message}`);
  }
  return json.data?.transcripts as FirefliesTranscript[];
}

async function handler(req: NextRequest) {
  let body: { apiKey?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey, from, to } = body;
  if (!apiKey?.trim()) {
    return NextResponse.json(
      { error: "Fireflies API key is required. Add it in the Connections panel." },
      { status: 400 },
    );
  }

  const rid = req.headers.get("x-request-id") ?? "n/a";
  const toDate = to || new Date().toISOString().slice(0, 10);
  const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // Fireflies expects ms timestamps
  const fromMs = new Date(fromDate).setHours(0, 0, 0, 0);
  const toMs = new Date(toDate).setHours(23, 59, 59, 999);

  try {
    const all: FirefliesTranscript[] = [];
    let skip = 0;
    while (true) {
      const page = await graphql(apiKey.trim(), {
        fromDate: fromMs,
        toDate: toMs,
        limit: PAGE_SIZE,
        skip,
      });
      if (!page || page.length === 0) break;
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }

    serverLog("info", "ext:fireflies", "done", { count: all.length, pages: Math.ceil(all.length / PAGE_SIZE), rid });
    return NextResponse.json({
      transcripts: all.map(normalise),
      total: all.length,
    });
  } catch (err) {
    serverLog("error", "ext:fireflies", "failed", { error: String(err), rid });
    return NextResponse.json(
      { error: String(err) },
      { status: 502 },
    );
  }
}

export const POST = withRequestLogging("api:fireflies/transcripts", handler);
