import type { Metadata } from "next";
import { GfxFoundationClient } from "./gfx-foundation-client";

export const metadata: Metadata = {
  title: "GFX-004/005 Streaming Foundation",
  description: "Real-worker chunk streaming and Linear HDR integration evidence for Lonely Star.",
};

export default function GfxFoundationPage() {
  return <GfxFoundationClient />;
}
