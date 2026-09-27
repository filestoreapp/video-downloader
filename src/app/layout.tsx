import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SnapDown — YouTube & Instagram Downloader",
  description: "Download YouTube videos & audio, Instagram reels & photos, and cut clips.",
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
