import type { Metadata } from "next";
import { R5MinimumClient } from "./r5-minimum-client";

export const metadata: Metadata = {
  title: "さみしき星のまたたきよ — 15秒 Graybox",
  description: "Ring、Obstacle、Life Nodeを15秒で体験する隔離済みR5 Graybox。",
};

export default function R5MinimumPage() {
  return <R5MinimumClient />;
}
