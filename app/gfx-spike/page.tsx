import type { Metadata } from "next";
import { GfxSpikeClient } from "./gfx-spike-client";

export const metadata: Metadata = {
  title: "GFX-001 WebGPU / TSL Spike",
  description: "Isolated Three.js WebGPU renderer and TSL backend capability spike.",
};

export default function GfxSpikePage() {
  return <GfxSpikeClient />;
}
