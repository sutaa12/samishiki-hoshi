import type { Metadata } from "next";
import { GfxContractClient } from "./gfx-contract-client";

export const metadata: Metadata = {
  title: "GFX-002 Render Contract Laboratory",
  description: "Local-only lifecycle and backend-contract evidence surface for the isolated R2 graphics foundation.",
};

export default function GfxContractPage() {
  return <GfxContractClient />;
}
