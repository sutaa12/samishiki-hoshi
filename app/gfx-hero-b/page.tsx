import type { Metadata } from "next";
import { GfxHeroBClient } from "./gfx-hero-b-client";

export const metadata: Metadata = {
  title: "Hero Slice B · Forest to City",
  description: "Forest, river, waterfall, and empty rectilinear city evidence for Lonely Star.",
};

export default function GfxHeroBPage() {
  return <GfxHeroBClient />;
}
