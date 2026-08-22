import {
  phaseAt,
  shotAt,
  type JourneyState,
} from "../../game/model";
import type { JourneyRenderSnapshot } from "./contracts";

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
