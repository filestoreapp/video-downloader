import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapDown — Instagram Downloader",
  description: "Download Instagram reels, videos & photos, convert to MP3, and cut clips.",
  robots: { index: false, follow: false },
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
