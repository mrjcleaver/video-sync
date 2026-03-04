import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  let body: { code?: string; clientId?: string; clientSecret?: string; redirectUri?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { code, clientId, clientSecret, redirectUri } = body;
  if (!code || !clientId || !clientSecret || !redirectUri) {
    return NextResponse.json(
      { error: "code, clientId, clientSecret, and redirectUri are required" },
      { status: 400 },
    );
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return NextResponse.json(
        { error: `Token exchange failed (${tokenRes.status}): ${text}` },
        { status: 502 },
      );
    }

    const tokens = await tokenRes.json();
    return NextResponse.json({
      refreshToken: tokens.refresh_token ?? null,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to exchange code: ${String(err)}` },
      { status: 502 },
    );
  }
}
