import {
  phaseAt,
  shotAt,
  type JourneyState,
} from "../../game/model";
import type { RailFlightState } from "../../game/rail-flight-state";
import type { JourneyRenderSnapshot, RailRenderSnapshot } from "./contracts";

/**
 * Creates the only game-to-renderer projection used by the production v2
 * boundary. It copies every mutable container and intentionally omits gameplay
 * velocity rules, input state, replay implementation, and quality/backend data.
 */
export function projectJourneyState(state: Readonly<JourneyState>): JourneyRenderSnapshot {
  return {
    seed: state.seed,
    storyTime: state.time,
    phase: phaseAt(state.time),
    shotId: shotAt(state.time).id,
    position: { x: state.position.x, y: state.position.y },
    velocity: { x: state.velocity.x, y: state.velocity.y },
    pulses: state.pulses.map((pulse) => ({
      id: pulse.id,
      journeyTime: pulse.journeyTime,
      x: pulse.x,
      y: pulse.y,
      phase: pulse.phase,
      source: pulse.source,
      value: pulse.value,
    })),
    answerAt: state.answerAt,
    finished: state.finished,
  };
}

/** Copies only canonical rail presentation scalars; no renderer preference enters this projection. */
export function projectRailFlightState(
  state: Readonly<RailFlightState>,
): Readonly<RailRenderSnapshot> {
  return Object.freeze({
    distanceMm: state.distanceMm === 0 ? 0 : state.distanceMm,
    forwardSpeedMmPerSecond: state.forwardSpeedMmPerSecond === 0
      ? 0
      : state.forwardSpeedMmPerSecond,
    corridorOffset: Object.freeze({
      x: state.corridorOffset.x === 0 ? 0 : state.corridorOffset.x,
      y: state.corridorOffset.y === 0 ? 0 : state.corridorOffset.y,
    }),
  });
}
