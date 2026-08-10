"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

const STORAGE_KEY = "video-sync:connections";

function CallbackHandler() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState("Completing YouTube authorization...");

  useEffect(() => {
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error) {
      setStatus(`Authorization denied: ${error}`);
      setTimeout(() => router.push("/"), 2000);
      return;
    }

    if (!code) {
      setStatus("No authorization code received.");
      setTimeout(() => router.push("/"), 2000);
      return;
    }

    let clientId: string;
    let clientSecret: string;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) throw new Error("No connections configured");
      const connections = JSON.parse(raw);
      const yt = connections["YouTube"];
      if (!yt?.credentials?.clientId || !yt?.credentials?.clientSecret) {
        throw new Error("YouTube Client ID / Secret not configured");
      }
      clientId = yt.credentials.clientId;
      clientSecret = yt.credentials.clientSecret;
    } catch (err) {
      setStatus(`Error: ${String(err)}`);
      setTimeout(() => router.push("/"), 3000);
      return;
    }

    const redirectUri = `${window.location.origin}/youtube-callback`;

    setStatus("Exchanging authorization code for tokens...");
    fetch("/api/youtube/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, clientId, clientSecret, redirectUri }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Token exchange failed (${res.status})`);
        if (!data.refreshToken) {
          throw new Error("No refresh token received. Try revoking app access in your Google account and re-authorizing.");
        }

        const raw = localStorage.getItem(STORAGE_KEY) || "{}";
        const connections = JSON.parse(raw);
        const yt = connections["YouTube"] || { connected: true, credentials: {} };
        yt.credentials = {
          ...yt.credentials,
          refreshToken: data.refreshToken,
          accessToken: data.accessToken,
          tokenExpiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000,
        };
        yt.connected = true;
        connections["YouTube"] = yt;
        // If the records blob has claimed most of the origin's quota
        // (previously reported as "localStorage exceeded"), setItem
        // silently throws QuotaExceededError. Catch it explicitly so
        // the user sees WHY authorization "didn't stick" — otherwise
        // they'd return to the app, click Publish again, and see
        // the same "YouTube not authorised" message.
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
        } catch (storeErr) {
          throw new Error(
            `Authorization succeeded, but writing the refresh token to localStorage failed: ${String(storeErr)}. ` +
            `The connections blob may have been evicted by the records cache. Try reloading the page — the store now trims the records cache to fit — and reauthorize.`,
          );
        }

        // Fetch the authorized channel info so user knows which channel uploads target
        setStatus("Verifying channel...");
        try {
          const chRes = await fetch(
            "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
            { headers: { Authorization: `Bearer ${data.accessToken}` } },
          );
          if (chRes.ok) {
            const chData = await chRes.json();
            const channel = chData.items?.[0];
            if (channel) {
              yt.credentials.authorizedChannelId = channel.id;
              yt.credentials.authorizedChannelTitle = channel.snippet?.title || channel.id;
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
              } catch { /* first write already succeeded — channel-title annotation is nice-to-have */ }
            }
          }
        } catch { /* non-fatal — channel info is nice-to-have */ }

        const chName = yt.credentials.authorizedChannelTitle;
        setStatus(chName
          ? `Authorized for channel "${chName}"! Redirecting...`
          : "YouTube authorized successfully! Redirecting...");
        setTimeout(() => router.push("/config#connections"), 2000);
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("invalid_client")) {
          setStatus("Authorization failed: Client ID or Client Secret is incorrect. Update your YouTube credentials in Connections and try again.");
          setTimeout(() => router.push("/config#connections"), 8000);
        } else if (msg.includes("QuotaExceeded") || msg.includes("quota") || msg.includes("localStorage failed")) {
          // Storage-related failures: keep the message on screen and
          // give the user a manual "Back to Connections" affordance —
          // auto-redirect could re-trigger the same error path.
          setStatus(`${msg}\n\nWhen you close this tab you can retry from /config#connections.`);
        } else {
          setStatus(`Authorization failed: ${msg}`);
          setTimeout(() => router.push("/config#connections"), 8000);
        }
      });
  }, [searchParams, router]);

  return <p>{status}</p>;
}

export default function YouTubeCallback() {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "60vh",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      color: "#e5e5e5",
      background: "#0a0a0a",
      fontSize: "1rem",
    }}>
      <Suspense fallback={<p>Loading...</p>}>
        <CallbackHandler />
      </Suspense>
    </div>
  );
}
