import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://samishiki-hoshi-seoul.sites.openai.com"),
  title: "さみしき星のまたたきよ｜TWINKLE, O LONELY STAR",
  description:
    "豊かな地球から宇宙へ、一滴の生命を導く3分間のプロシージャル・ネイチャーフライト。",
  applicationName: "さみしき星のまたたきよ",
  keywords: ["Three.js", "procedural game", "browser game", "さみしき星のまたたきよ"],
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    title: "さみしき星のまたたきよ",
    description: "ひとりの光は、やがて無数のまたたきになる。",
    images: [{ url: "/og.png", width: 1600, height: 900, alt: "地球と無数の生命光を見つめる一滴の光" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#020916",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
