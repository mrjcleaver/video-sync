import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Video Sync — Curation Dashboard",
  description: "Video indexing & publishing bridge",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
