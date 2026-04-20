/** Resolve internal pseudo-URLs to real web URLs, or return null for non-navigable schemes. */
export function resolveExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("fireflies://")) {
    const id = url.slice("fireflies://".length);
    return `https://app.fireflies.ai/view/${id}`;
  }
  if (url.startsWith("zoom://recording/")) {
    const uuid = url.slice("zoom://recording/".length);
    const encoded = uuid.includes("/")
      ? encodeURIComponent(encodeURIComponent(uuid))
      : encodeURIComponent(uuid);
    return `https://zoom.us/recording/play/${encoded}`;
  }
  return null;
}
