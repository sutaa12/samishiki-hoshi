import type { Metadata } from "next";
import { GfxSpikeClient } from "./gfx-spike-client";

export const metadata: Metadata = {
  title: "GFX-001 Experimental WebGPU / TSL Lab",
  description: "Experimental lab-only Three.js WebGPU renderer and TSL backend capability spike; not the game runtime.",
};

export default function GfxSpikePage() {
  return <GfxSpikeClient />;
}
