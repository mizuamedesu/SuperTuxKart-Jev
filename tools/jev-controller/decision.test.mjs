import assert from "node:assert/strict";
import test from "node:test";
import {
  actionFromEvaluation,
  deriveDrivingState,
  deriveMotionTrend,
  isTelemetry,
  mockAction,
} from "./decision.mjs";

const telemetry = {
  type: "telemetry",
  version: 1,
  session: 1,
  sequence: 7,
  race: { jev_started: true, started: true, finished: false },
  kart: { speed_kph: 40, energy: 5 },
  track: {
    width_m: 10,
    lateral_offset_m: 2,
    off_track: false,
    lookahead: [
      { local_x_m: -2, local_z_m: 8 },
      { local_x_m: -8, local_z_m: 15 },
    ],
  },
};

test("derives curve and road margin from game telemetry", () => {
  const state = deriveDrivingState(telemetry);
  assert.ok(state.target_heading_deg < -20);
  assert.equal(state.road_edge_margin_m, 3);
  assert.ok(state.recommended_speed_kph < 50);
});

test("maps typed Jev answers to a control packet", () => {
  const action = actionFromEvaluation(
    {
      steering: { choice: "left" },
      throttle: { choice: "cruise" },
      drift: { probability: 0.8 },
      nitro: { probability: 0.2 },
      use_item: { probability: 0.9 },
      rescue: { probability: 0.1 },
    },
    7,
  );
  assert.deepEqual(
    { steer: action.steer, accel: action.accel, drift: action.drift, fire: action.fire },
    { steer: -0.45, accel: 0.55, drift: true, fire: true },
  );
  assert.equal(Object.hasOwn(action, "guard"), false);
});

test("prevents a held brake from becoming reverse gear", () => {
  const action = actionFromEvaluation(
    {
      steering: { choice: "right" },
      throttle: { choice: "hard_brake" },
      drift: { probability: 0 },
      nitro: { probability: 0 },
      use_item: { probability: 0 },
      rescue: { probability: 0 },
    },
    8,
    { kart: { speed_kph: -1 } },
  );
  assert.equal(action.brake, false);
  assert.equal(action.accel, 0.55);
  assert.equal(action.guard, "forward_recovery");
});

test("validates protocol identity and sequence", () => {
  assert.equal(isTelemetry(telemetry), true);
  assert.equal(isTelemetry({ ...telemetry, sequence: 0 }), false);
  assert.equal(isTelemetry({ ...telemetry, version: 2 }), false);
  assert.equal(isTelemetry({ ...telemetry, race: {} }), false);
});

test("mock transport controller steers toward the lookahead", () => {
  const action = mockAction(telemetry);
  assert.ok(action.steer < 0);
  assert.equal(action.based_on, telemetry.sequence);
});

test("preserves a lookahead target behind the kart as an angle over 90 degrees", () => {
  const state = deriveDrivingState({
    ...telemetry,
    track: {
      ...telemetry.track,
      lookahead: [{ local_x_m: 3, local_z_m: -4 }],
    },
  });
  assert.ok(state.target_heading_deg > 90);
  assert.equal(state.recommended_speed_kph, 12);
});

test("derives motion rates and predicts the response-time state", () => {
  const oldTelemetry = structuredClone(telemetry);
  oldTelemetry.kart.speed_kph = 20;
  oldTelemetry.track.lateral_offset_m = 0;
  oldTelemetry.track.distance_m = 100;
  oldTelemetry.track.lap_length_m = 800;
  oldTelemetry.track.lookahead = [{ local_x_m: 0, local_z_m: 10 }];

  const newTelemetry = structuredClone(oldTelemetry);
  newTelemetry.sequence = 8;
  newTelemetry.kart.speed_kph = 30;
  newTelemetry.track.lateral_offset_m = 0.5;
  newTelemetry.track.distance_m = 106;
  newTelemetry.track.lookahead = [{ local_x_m: 4, local_z_m: 10 }];

  const motion = deriveMotionTrend(
    [
      { telemetry: oldTelemetry, received_at_ms: 1000 },
      { telemetry: newTelemetry, received_at_ms: 2000 },
    ],
    { predictionHorizonMs: 500, stuckForS: 2.25 },
  );
  assert.equal(motion.speed_trend_kph_s, 10);
  assert.equal(motion.lateral_offset_rate_mps, 0.5);
  assert.equal(motion.progress_rate_mps, 6);
  assert.ok(motion.predicted_path_heading_deg > 30);
  assert.equal(motion.predicted_lateral_offset_m, 0.75);
  assert.equal(motion.predicted_speed_kph, 35);
  assert.equal(motion.steering_demand_direction, "right");
  assert.equal(motion.throttle_guidance, "accelerate");
  assert.equal(motion.stuck_for_s, 2.25);
});
