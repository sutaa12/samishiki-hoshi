import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "さみしき星のまたたきよ",
  description:
    "豊かな地球から宇宙へ、一滴の生命を導く3分間のプロシージャル・ネイチャーフライト。",
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
