"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

const STORAGE_KEY = "video-sync:connections";
type CallbackStatus = {
  message: string;
  isError: boolean;
};

function CallbackHandler() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<CallbackStatus>({
    message: "Completing YouTube authorization...",
    isError: false,
  });

  useEffect(() => {
    const code = searchParams.get("code");
    const error = searchParams.get("error");

    if (error) {
      setStatus({ message: `Authorization denied: ${error}`, isError: true });
      setTimeout(() => router.push("/"), 2000);
      return;
    }

    if (!code) {
      setStatus({ message: "No authorization code received.", isError: true });
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
      setStatus({ message: `Error: ${String(err)}`, isError: true });
      setTimeout(() => router.push("/"), 3000);
      return;
    }

    const redirectUri = `${window.location.origin}/youtube-callback`;

    setStatus({ message: "Exchanging authorization code for tokens...", isError: false });
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
        localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));

        // Fetch the authorized channel info so user knows which channel uploads target
        setStatus({ message: "Verifying channel...", isError: false });
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
              localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
            }
          }
        } catch { /* non-fatal — channel info is nice-to-have */ }

        const chName = yt.credentials.authorizedChannelTitle;
        setStatus({
          message: chName
            ? `Authorized for channel "${chName}". Redirecting...`
            : "YouTube authorized successfully. Redirecting...",
          isError: false,
        });
        setTimeout(() => router.push("/"), 2000);
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("invalid_client")) {
          setStatus({
            message: "Authorization failed: Client ID or Client Secret is incorrect. Update your YouTube credentials in Connections and try again.",
            isError: true,
          });
        } else {
          setStatus({ message: `Authorization failed: ${msg}`, isError: true });
        }
        setTimeout(() => router.push("/"), 6000);
      });
  }, [searchParams, router]);

  return (
    <p
      role={status.isError ? "alert" : "status"}
      aria-live={status.isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={status.isError ? "callback-status callback-status-error" : "callback-status"}
    >
      {status.message}
    </p>
  );
}

export default function YouTubeCallback() {
  return (
    <main className="callback-page">
      <section className="callback-card" aria-labelledby="callback-title">
        <h1 id="callback-title">YouTube authorization</h1>
        <Suspense fallback={<p role="status" aria-live="polite">Loading authorization details...</p>}>
          <CallbackHandler />
        </Suspense>
      </section>
    </main>
  );
}
