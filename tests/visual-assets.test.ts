import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createCloudBank,
  createEarthNature,
  createLifeBiome,
  createLifeWaveAccents,
  createLivingEarth,
  createLuminousDropletHero,
  createNaturalLighting,
  createNebulaGalaxy,
  createUnknownRibbonShip,
  disposeVisualAsset,
} from "../src/game/visual-assets";

function namesIn(group: THREE.Object3D): string[] {
  const names: string[] = [];
  group.traverse((child) => names.push(child.name));
  return names;
}

describe("Notion-reference visual assets", () => {
  it("keeps the droplet identity in named volumetric parts without an eye-like face", () => {
    const hero = createLuminousDropletHero({ seed: 42, quality: "balanced" });
    const names = namesIn(hero);
    expect(names).toEqual(expect.arrayContaining(["droplet-envelope", "droplet-rim", "droplet-nucleus", "droplet-warm-core", "wing-left", "wing-right", "water-tail"]));
    expect(names.join(" ")).not.toMatch(/face|eye|mouth/i);
    expect(hero.userData.faceSafe).toBe(true);
    expect(hero.userData.nucleusToBodyRadius).toBeLessThan(0.25);
    const nucleus = hero.getObjectByName("droplet-nucleus") as THREE.Mesh;
    const warm = hero.getObjectByName("droplet-warm-core") as THREE.Mesh;
    expect(nucleus.position.x).not.toBe(0);
    expect(nucleus.position.z).toBeLessThan(0);
    expect(warm.position.x).not.toBe(0);
    expect((hero.getObjectByName("water-tail") as THREE.Mesh).geometry).toBeInstanceOf(THREE.BufferGeometry);
    disposeVisualAsset(hero);
  });

  it("ships exactly three broad open ribbon-shell meshes around a tagged void", () => {
    const ship = createUnknownRibbonShip({ seed: 17, quality: "high" });
    const shells = ship.children.filter((child) => child.userData.assetRole === "broad-curved-ribbon-shell");
    expect(shells).toHaveLength(3);
    expect(ship.userData.centralVoid).toBe(true);
    shells.forEach((shell) => {
      expect(shell).toBeInstanceOf(THREE.Mesh);
      const geometry = (shell as THREE.Mesh).geometry;
      expect(geometry.getIndex()?.count).toBeGreaterThan(12);
      expect(shell.userData.shellThickness).toBeGreaterThan(0.09);
      expect(shell.children.some((child) => child.userData.assetRole === "restrained-internal-color-flow")).toBe(true);
    });
    disposeVisualAsset(ship);
  });

  it("creates deterministic, quality-bounded natural and final scenery", () => {
    const low = createLifeBiome({ seed: 7, quality: "low" });
    const high = createLifeBiome({ seed: 7, quality: "high" });
    expect(namesIn(low)).toContain("coral-garden");
    expect(namesIn(low)).toContain("kelp-forest");
    expect(namesIn(low)).toContain("fish-school");
    expect(namesIn(low)).toEqual(expect.arrayContaining(["reef-background", "reef-midground", "reef-foreground"]));
    expect(high.children.length).toBe(low.children.length);
    expect(namesIn(high).filter((name) => name.startsWith("coral-")).length).toBeGreaterThan(namesIn(low).filter((name) => name.startsWith("coral-")).length);

    const earthNature = createEarthNature({ seed: 9, quality: "balanced" });
    const earth = createLivingEarth({ seed: 9, quality: "balanced" });
    const clouds = createCloudBank({ seed: 9, quality: "balanced" });
    const nebula = createNebulaGalaxy({ seed: 9, quality: "balanced" });
    const waves = createLifeWaveAccents({ seed: 9, quality: "balanced" });
    const lights = createNaturalLighting();
    expect(namesIn(earthNature)).toEqual(expect.arrayContaining(["living-river", "forest", "waterfall", "canopy-background", "canopy-midground", "canopy-foreground", "river-rock-banks"]));
    expect(namesIn(earth)).toEqual(expect.arrayContaining(["earth-ocean", "earth-land", "earth-atmosphere"]));
    expect(namesIn(nebula)).toContain("nebula-0");
    expect(namesIn(clouds)).toEqual(expect.arrayContaining(["cloud-far", "cloud-mid", "cloud-near"]));
    expect(namesIn(waves).some((name) => name.startsWith("life-wave-"))).toBe(true);
    expect(namesIn(lights.group)).toEqual(expect.arrayContaining(["sky-water-hemisphere", "warm-key", "cyan-rim", "coral-bounce"]));
    [low, high, earthNature, earth, clouds, nebula, waves, lights.group].forEach(disposeVisualAsset);
  });
});
