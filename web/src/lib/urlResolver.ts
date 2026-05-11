/** Resolve internal pseudo-URLs (used as download_url on catalog records)
 *  to real navigable web URLs, or return null for unhandled schemes. */
export function resolveExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  if (url.startsWith("fireflies://")) {
    const id = url.slice("fireflies://".length);
    return `https://app.fireflies.ai/view/${id}`;
  }

  if (url.startsWith("zoom://recording/")) {
    const uuid = url.slice("zoom://recording/".length);
    // Zoom requires double-encoding when the UUID contains a slash
    const encoded = uuid.includes("/")
      ? encodeURIComponent(encodeURIComponent(uuid))
      : encodeURIComponent(uuid);
    return `https://zoom.us/recording/play/${encoded}`;
  }

  if (url.startsWith("youtube://")) {
    return `https://www.youtube.com/watch?v=${url.slice("youtube://".length)}`;
  }

  if (url.startsWith("kaltura://entry/")) {
    return `https://kmc.kaltura.com/index.php/kmcng/content/entries/entry/${url.slice("kaltura://entry/".length)}`;
  }

  return null;
}
