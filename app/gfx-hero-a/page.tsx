import type { Metadata } from "next";
import { GfxHeroAClient } from "./gfx-hero-a-client";

export const metadata: Metadata = {
  title: "Hero Slice A · Ocean",
  description: "Ocean, living ecology, submerged rectilinear ruin, and waterline evidence for Lonely Star.",
};

export default function GfxHeroAPage() {
  return <GfxHeroAClient />;
}

