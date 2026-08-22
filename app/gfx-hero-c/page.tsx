import type { Metadata } from "next";
import { GfxHeroCClient } from "./gfx-hero-c-client";

export const metadata: Metadata = {
  title: "Hero Slice C · Debris to Twinkle",
  description: "Human debris, three-shell unknown ship, and living-light evidence for Lonely Star.",
};

export default function GfxHeroCPage() {
  return <GfxHeroCClient />;
}
