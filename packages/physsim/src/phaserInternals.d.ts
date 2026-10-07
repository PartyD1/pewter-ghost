/**
 * Untyped Phaser 3.90 internals the parity test (sim.parity.test.ts) loads
 * straight from the package so the agent's collision port can be checked
 * against the engine's own code without booting a browser. These CommonJS
 * modules pull in no device detection. (SeparateTile is declared in
 * apps/editor/src/player/phaserInternals.d.ts.)
 */
declare module "phaser/src/physics/arcade/World.js" {
  const World: {
    prototype: {
      computeVelocity(this: { gravity: { x: number; y: number } }, body: unknown, delta: number): void;
    };
  };
  export default World;
}

declare module "phaser/src/physics/arcade/tilemap/TileIntersectsBody.js" {
  const TileIntersectsBody: (
    rect: { left: number; top: number; right: number; bottom: number },
    body: unknown,
  ) => boolean;
  export default TileIntersectsBody;
}

declare module "phaser/src/tilemaps/components/GetTilesWithin.js" {
  const GetTilesWithin: <T>(
    tileX: number,
    tileY: number,
    width: number,
    height: number,
    filteringOptions: { isNotEmpty?: boolean; isColliding?: boolean; hasInterestingFace?: boolean } | null,
    layer: { width: number; height: number; data: (T | null)[][] },
  ) => T[];
  export default GetTilesWithin;
}

declare module "phaser/src/tilemaps/components/CalculateFacesWithin.js" {
  const CalculateFacesWithin: (
    tileX: number,
    tileY: number,
    width: number,
    height: number,
    layer: { width: number; height: number; data: unknown[][] },
  ) => void;
  export default CalculateFacesWithin;
}
