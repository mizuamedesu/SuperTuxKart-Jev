#!/usr/bin/env node

import dgram from "node:dgram";
import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate } from "ai";
import {
  actionFromEvaluation,
  deriveDrivingState,
  deriveMotionTrend,
  isTelemetry,
  mockAction,
} from "./decision.mjs";

const localEnvFile = fileURLToPath(new URL(".env", import.meta.url));
const repoEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
const envFile = existsSync(localEnvFile) ? localEnvFile : repoEnvFile;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const mock = process.argv.includes("--mock");
const statePort = integerSetting("JEV_STATE_PORT", 19736, 1, 65535);
const controlPort = integerSetting("JEV_CONTROL_PORT", 19737, 1, 65535);
const decisionIntervalMs = integerSetting(
  "JEV_DECISION_INTERVAL_MS",
  100,
  100,
  5000,
);
const maxInFlight = integerSetting("JEV_MAX_IN_FLIGHT", 12, 1, 64);
const inputPricePerMillion = numberSetting(
  "JEV_INPUT_PRICE_PER_MILLION_USD",
  0.04,
  0,
  1000,
);

if (statePort === controlPort) {
  throw new Error("JEV_STATE_PORT and JEV_CONTROL_PORT must differ");
}
if (!mock && !process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is required. Use --mock only to test the transport.");
  process.exit(1);
}

const gateway = mock
  ? null
  : createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
const socket = dgram.createSocket("udp4");

let latestTelemetry;
let lastDispatchedTelemetry;
let activeSession = 0;
let lastDispatchedSequence = 0;
let lastAppliedSequence = 0;
let commandSequence = 0;
let lastAction;
let lastDecision;
let lastDecisionAt = 0;
let evaluationTimer;
let inFlight = 0;
let closing = false;
let telemetryHistory = [];
let decisionHistory = [];
let stuckSince = 0;
let lastRescueAt = 0;
let telemetryEpoch = 0;
let lastKartAnimated = false;
let lastRaceStarted = false;

const bridgeStartedAt = Date.now();
const requestTimes = [];
const responseTimes = [];
const appliedTimes = [];
const latencySamples = [];
const abortControllers = new Set();
let totalRequests = 0;
let totalSucceeded = 0;
let totalFailed = 0;
let totalStale = 0;
let totalApplied = 0;
let totalInputTokens = 0;

socket.on("error", (error) => {
  console.error(`[bridge] UDP error: ${error.message}`);
});

socket.on("message", (message) => {
  let telemetry;
  try {
    telemetry = JSON.parse(message.toString("utf8"));
  } catch {
    console.warn("[bridge] Ignored malformed telemetry JSON");
    return;
  }
  if (!isTelemetry(telemetry)) {
    console.warn("[bridge] Ignored telemetry with an unsupported schema");
    return;
  }
  if (telemetry.session < activeSession) return;
  if (telemetry.session > activeSession) {
    activeSession = telemetry.session;
    latestTelemetry = undefined;
    lastDispatchedTelemetry = undefined;
    lastDispatchedSequence = 0;
    lastAppliedSequence = 0;
    lastAction = undefined;
    lastDecision = undefined;
    lastDecisionAt = 0;
    telemetryHistory = [];
    decisionHistory = [];
    stuckSince = 0;
    lastRescueAt = 0;
    telemetryEpoch++;
    lastKartAnimated = false;
    lastRaceStarted = false;
    console.log(`[bridge] game session ${activeSession}`);
  }
  if (latestTelemetry && telemetry.sequence <= latestTelemetry.sequence) return;
  const receivedAt = Date.now();
  latestTelemetry = telemetry;
  const animated = Boolean(telemetry.kart?.animated);
  const raceStarted = Boolean(telemetry.race?.started);
  if (animated !== lastKartAnimated || raceStarted !== lastRaceStarted) {
    telemetryEpoch++;
    telemetryHistory = [];
    stuckSince = 0;
    if (animated) {
      lastAction = undefined;
      lastDecisionAt = 0;
    }
    lastKartAnimated = animated;
    lastRaceStarted = raceStarted;
  }
  telemetryHistory.push({ telemetry, received_at_ms: receivedAt });
  while (
    telemetryHistory.length > 2 &&
    telemetryHistory[0].received_at_ms < receivedAt - 1500
  ) {
    telemetryHistory.shift();
  }
  updateStuckClock(telemetry, receivedAt);

  // Refresh a recent action while Jev is evaluating. If evaluations stop for
  // longer than two seconds, refreshes stop and the game's watchdog brakes.
  if (lastAction && receivedAt - lastDecisionAt < 2000) sendAction(lastAction);
});

socket.bind(statePort, "127.0.0.1", () => {
  const mode = mock ? "MOCK transport test" : "Jev typesafe-ai/jev";
  console.log(`[bridge] ${mode}`);
  console.log(`[bridge] telemetry 127.0.0.1:${statePort} -> controls 127.0.0.1:${controlPort}`);
  console.log(
    `[bridge] Jev input ${(1000 / decisionIntervalMs).toFixed(1)} Hz, ` +
      `up to ${maxInFlight} concurrent requests`,
  );
  console.log("[bridge] waiting for SuperTuxKart telemetry...");
  evaluationTimer = setInterval(dispatchLatest, decisionIntervalMs);
});

function dispatchLatest() {
  if (
    closing ||
    !latestTelemetry ||
    latestTelemetry.race?.jev_started !== true ||
    !latestTelemetry.race?.started ||
    latestTelemetry.race?.finished ||
    latestTelemetry.kart?.animated ||
    inFlight >= maxInFlight ||
    latestTelemetry.sequence <= lastDispatchedSequence
  ) {
    return;
  }
  const telemetry = latestTelemetry;
  lastDispatchedSequence = telemetry.sequence;
  lastDispatchedTelemetry = telemetry;
  void evaluateTelemetry(telemetry, makeDecisionContext(telemetry));
}

async function evaluateTelemetry(telemetry, decisionContext) {
  const startedAt = Date.now();
  const previousAction = lastAction ?? null;
  const controller = new AbortController();
  abortControllers.add(controller);
  inFlight++;
  totalRequests++;
  requestTimes.push(startedAt);

  try {
    let action;
    let usage;
    let answers;
    if (mock) {
      action = mockAction(telemetry);
      answers = mockAnswers(action);
    } else {
      const result = await evaluateWithJev(
        telemetry,
        previousAction,
        decisionContext,
        AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
      );
      action = actionFromEvaluation(result.answers, telemetry.sequence, telemetry);
      usage = result.usage;
      answers = result.answers;
    }

    const finishedAt = Date.now();
    const latencyMs = finishedAt - startedAt;
    responseTimes.push(finishedAt);
    latencySamples.push(latencyMs);
    if (latencySamples.length > 40) latencySamples.shift();
    recordUsage(usage);
    totalSucceeded++;

    if (
      telemetry.session !== activeSession ||
      decisionContext.epoch !== telemetryEpoch ||
      telemetry.sequence <= lastAppliedSequence
    ) {
      totalStale++;
      return;
    }
    lastAppliedSequence = telemetry.sequence;
    lastDecisionAt = finishedAt;
    action = applyRuntimeGuards(action, latestTelemetry, finishedAt);
    lastDecision = {
      telemetry,
      answers,
      action,
      latencyMs,
    };
    decisionHistory.unshift(makeHistoryLine(lastDecision));
    decisionHistory = decisionHistory.slice(0, 10);
    appliedTimes.push(finishedAt);
    totalApplied++;
    lastAction = { ...action, fire: false, rescue: false };
    sendAction(action);
    logDecision(telemetry, action, usage, latencyMs);
  } catch (error) {
    if (closing && controller.signal.aborted) return;
    responseTimes.push(Date.now());
    totalFailed++;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Jev] state #${telemetry.sequence} failed: ${message}`);
  } finally {
    inFlight--;
    abortControllers.delete(controller);
  }
}

async function evaluateWithJev(
  telemetry,
  previousAction,
  decisionContext,
  abortSignal,
) {
  const derived = deriveDrivingState(telemetry);
  return evaluate({
    model: gateway.evaluationModel("typesafe-ai/jev"),
    state: {
      task:
        "Choose one SuperTuxKart control command for the predicted state " +
        `when this evaluation returns. A fresher command is requested every ${decisionIntervalMs} milliseconds.`,
      coordinate_system: {
        steering: "Negative is left; positive is right.",
        speed_kph:
          "Signed speed: positive is forward and negative is reverse. In SuperTuxKart, holding brake after stopping engages reverse.",
        lateral_offset_m:
          "Negative is left of the driveline center; positive is right. Correct it toward zero.",
        lookahead:
          "Points are kart-local: negative local_x_m is left, positive local_x_m is right, and positive local_z_m is forward.",
        nearby_karts:
          "Positions are kart-local. Positive local_z_m is ahead.",
        motion:
          "velocity_local_mps.x is lateral velocity, velocity_local_mps.z is forward velocity, and positive yaw_rate turns right.",
      },
      priorities: [
        "Use motion_trend.steering_demand_deg as the primary steering signal: negative means left and positive means right.",
        "Use motion_trend.throttle_guidance as the primary speed-control signal.",
        "Use predicted values because the command takes effect after the expected latency.",
        "If speed_kph is 5 or less, never brake; accelerate forward while steering toward the path.",
        "Recover onto the road when off_track is true.",
        "Follow the lookahead path and preserve road-edge margin.",
        "Slow before sharp curves, then accelerate on exit.",
        "Avoid nearby karts without leaving the road.",
      ],
      derived,
      timing: {
        request_interval_ms: decisionIntervalMs,
        expected_response_latency_ms: decisionContext.expectedLatencyMs,
      },
      motion_trend: decisionContext.motionTrend,
      recent_motion_oldest_to_newest: decisionContext.recentMotion,
      telemetry: {
        race: telemetry.race,
        kart: telemetry.kart,
        track: telemetry.track,
        nearby_karts: telemetry.nearby_karts,
      },
      previous_action: previousAction,
    },
    questions: {
      steering: {
        type: "choice",
        instructions:
          "Choose steering from steering_demand_deg, which already combines predicted path heading, centering, lateral motion, and yaw damping. Never choose the opposite sign. Keep the previous direction only while its sign remains valid.",
        criteria: {
          hard_left: "Strong left (-0.80) when steering_demand_deg is below -55, especially during recovery.",
          left: "Clear left (-0.45) when steering_demand_deg is about -18 to -55.",
          slight_left: "Small left (-0.18) when steering_demand_deg is about -4 to -18.",
          straight: "Centered (0.0) when steering_demand_deg is between about -4 and +4.",
          slight_right: "Small right (+0.18) when steering_demand_deg is about +4 to +18.",
          right: "Clear right (+0.45) when steering_demand_deg is about +18 to +55.",
          hard_right: "Strong right (+0.80) when steering_demand_deg is above +55, especially during recovery.",
        },
      },
      throttle: {
        type: "choice",
        instructions:
          "Choose speed control from throttle_guidance and speed_error_to_target_kph. Account for predicted speed at response time so a delayed series of brake choices does not stop the kart.",
        criteria: {
          hard_brake: "Use only when throttle_guidance is brake. Never brake during low-speed or off-road recovery; continued braking at a stop engages reverse.",
          coast: "Use when throttle_guidance is coast: no throttle and no brake while settling at target speed.",
          cruise: "Moderate forward acceleration (0.55) for cornering, any off-road recovery below 25 km/h, or other low-speed recovery.",
          full: "Full acceleration (1.0) when throttle_guidance is accelerate and the trajectory is stable.",
        },
      },
      drift: {
        type: "boolean",
        instructions: "Should drift be held during this interval?",
        criteria: {
          true: "A sharp reachable turn benefits from drifting and the kart is on the road.",
          false: "Straight, gentle, unstable, airborne, or off-road; normal grip is safer.",
        },
      },
      nitro: {
        type: "boolean",
        instructions: "Should nitro be held during this interval?",
        criteria: {
          true: "Energy is available and the road ahead is straight, stable, and clear.",
          false: "Energy is unavailable or a curve, obstacle, edge, or recovery makes boost unsafe.",
        },
      },
      use_item: {
        type: "boolean",
        instructions: "Should the held powerup be fired now?",
        criteria: {
          true: "A powerup is held and using it now has a clear racing benefit.",
          false: "No powerup is held or there is no useful target or timing.",
        },
      },
      rescue: {
        type: "boolean",
        instructions: "Should the kart request rescue now?",
        criteria: {
          true: "stuck_for_s is at least 3, or the kart is nearly stopped and the predicted path is behind it so normal steering cannot recover.",
          false: "The kart is moving or can recover normally. Rescue loses time, so use it rarely.",
        },
      },
    },
    maxRetries: 0,
    abortSignal,
  });
}

function sendAction(action) {
  if (closing) return;
  const wireAction = {
    type: "control",
    version: 1,
    sequence: ++commandSequence,
    based_on_session: activeSession,
    based_on: action.based_on,
    steer: action.steer,
    accel: action.accel,
    brake: action.brake,
    nitro: action.nitro,
    drift: action.drift,
    fire: action.fire,
    rescue: action.rescue,
  };
  const hudLines = makeHudLines();
  for (let index = 0; index < hudLines.length; index++) {
    wireAction[`hud_${index + 1}`] = hudLines[index];
  }
  for (let index = 0; index < 10; index++) {
    wireAction[`history_${index + 1}`] = decisionHistory[index] ?? "";
  }
  const packet = Buffer.from(JSON.stringify(wireAction));
  socket.send(packet, controlPort, "127.0.0.1");
}

function makeHudLines() {
  const now = Date.now();
  const input = lastDispatchedTelemetry ?? latestTelemetry;
  const derived = input ? deriveDrivingState(input) : undefined;
  const expectedLatency = averageLatencyMs(400);
  const motion = deriveMotionTrend(telemetryHistory, {
    predictionHorizonMs: expectedLatency,
    stuckForS: stuckDurationS(now),
  });
  const decision = lastDecision;
  const requestHz = recentRate(requestTimes, now);
  const responseHz = recentRate(responseTimes, now);
  const appliedHz = recentRate(appliedTimes, now);
  const cost = (totalInputTokens * inputPricePerMillion) / 1_000_000;
  const action = decision?.action;

  return [
    `JEV LIVE | REQUEST ${requestHz.toFixed(1)} Hz | RESULT ${responseHz.toFixed(1)} Hz | APPLY ${appliedHz.toFixed(1)} Hz | IN-FLIGHT ${inFlight} | LAT ${Math.round(expectedLatency)} ms`,
    input && derived
      ? `INPUT #${input.sequence} | SPEED ${formatNumber(input.kart.speed_kph, 1)} km/h | LOCAL VX ${formatSigned(derived.local_lateral_speed_mps, 2)} VZ ${formatSigned(derived.local_forward_speed_mps, 2)} m/s | YAW ${formatSigned(derived.yaw_rate_deg_s, 1)} deg/s`
      : "INPUT | waiting for game telemetry",
    input && derived
      ? `PATH | NOW ${formatSigned(derived.target_heading_deg, 1)} -> PRED ${formatSigned(motion.predicted_path_heading_deg, 1)} deg @ ${motion.prediction_horizon_ms} ms | STEER DEMAND ${formatSigned(motion.steering_demand_deg, 1)} ${label(motion.steering_demand_direction)} | CURVE ${formatNumber(derived.maximum_curve_deg, 1)} deg`
      : "PATH | waiting",
    input && derived
      ? `TRACK | OFFSET ${formatSigned(derived.lateral_offset_m, 2)} -> ${formatSigned(motion.predicted_lateral_offset_m, 2)} m | RATE ${formatSigned(motion.lateral_offset_rate_mps, 2)} m/s | EDGE ${formatNumber(derived.road_edge_margin_m, 2)} m | ${derived.off_track ? "OFF TRACK" : "ON TRACK"}`
      : "TRACK | waiting",
    input
      ? `MOTION | SPEED ${formatNumber(motion.predicted_speed_kph, 1)} PRED / ${derived.recommended_speed_kph} TARGET | ${label(motion.throttle_guidance)} | TREND ${formatSigned(motion.speed_trend_kph_s, 1)} km/h/s | PROGRESS ${formatSigned(motion.progress_rate_mps, 1)} m/s | STUCK ${formatNumber(motion.stuck_for_s, 1)} s`
      : "MOTION | waiting",
    decision && action
      ? `LAST APPLY #${decision.telemetry.sequence} | ${directionToken(action)} / ${label(action.choices.throttle)} | ${decision.latencyMs} ms${action.guard ? ` | GUARD ${label(action.guard)}` : ""}`
      : "LAST APPLY | waiting for Jev",
    `CALLS | ${totalRequests} REQ | ${totalSucceeded} OK | ${totalApplied} APPLIED | ${totalStale} STALE | ${totalFailed} FAIL | ${totalInputTokens.toLocaleString("en-US")} INPUT TOKENS`,
    `EST COST | $${cost.toFixed(6)} @ $${inputPricePerMillion.toFixed(2)} / 1M INPUT TOKENS`,
  ];
}

function makeDecisionContext(telemetry) {
  const records = telemetryHistory
    .filter(
      (record) =>
        record.telemetry.session === telemetry.session &&
        record.telemetry.sequence <= telemetry.sequence,
    )
    .slice(-12);
  const expectedLatencyMs = Math.round(averageLatencyMs(400));
  const motionTrend = deriveMotionTrend(records, {
    predictionHorizonMs: expectedLatencyMs,
    stuckForS: stuckDurationS(Date.now()),
  });
  const newestAt = records.at(-1)?.received_at_ms ?? Date.now();
  const recentMotion = records.slice(-7).map((record) => {
    const sample = record.telemetry;
    const driving = deriveDrivingState(sample);
    return {
      age_ms: newestAt - record.received_at_ms,
      sequence: sample.sequence,
      speed_kph: rounded(sample.kart.speed_kph, 1),
      lateral_velocity_mps: rounded(
        sample.kart.velocity_local_mps?.x,
        2,
      ),
      forward_velocity_mps: rounded(
        sample.kart.velocity_local_mps?.z,
        2,
      ),
      yaw_rate_deg_s: rounded(driving.yaw_rate_deg_s, 1),
      path_heading_deg: rounded(driving.target_heading_deg, 1),
      lateral_offset_m: rounded(driving.lateral_offset_m, 2),
      off_track: driving.off_track,
      applied_controls: {
        steer: rounded(sample.kart.controls?.steer, 2),
        accel: rounded(sample.kart.controls?.accel, 2),
        brake: Boolean(sample.kart.controls?.brake),
      },
    };
  });
  return { expectedLatencyMs, motionTrend, recentMotion, epoch: telemetryEpoch };
}

function updateStuckClock(telemetry, now) {
  const speed = Math.abs(Number(telemetry.kart.speed_kph) || 0);
  const shouldMeasure =
    telemetry.race?.started &&
    !telemetry.race?.finished &&
    !telemetry.kart?.animated &&
    speed < 2.5;
  if (shouldMeasure) {
    if (!stuckSince) stuckSince = now;
  } else {
    stuckSince = 0;
  }
}

function stuckDurationS(now) {
  return stuckSince ? Math.max(0, now - stuckSince) / 1000 : 0;
}

function applyRuntimeGuards(action, currentTelemetry, now) {
  if (!currentTelemetry) return action;
  const guarded = { ...action };
  const guards = action.guard ? [action.guard] : [];
  const currentSpeed = Number(currentTelemetry.kart?.speed_kph) || 0;
  const driving = deriveDrivingState(currentTelemetry);
  if (
    guarded.brake &&
    (Math.abs(currentSpeed) <= 8 ||
      (driving.off_track && Math.abs(currentSpeed) < 25) ||
      Math.abs(currentSpeed) <= driving.recommended_speed_kph + 3)
  ) {
    guarded.brake = false;
    guarded.accel =
      driving.off_track ||
      Math.abs(currentSpeed) < driving.recommended_speed_kph - 4
        ? 0.55
        : 0;
    guards.push("brake_release");
  }

  const currentMotion = deriveMotionTrend(telemetryHistory, {
    predictionHorizonMs: Math.min(600, averageLatencyMs(400)),
    stuckForS: stuckDurationS(now),
  });
  const steeringDemand = Number(currentMotion.steering_demand_deg) || 0;
  const stateAge = currentTelemetry.sequence - (Number(action.based_on) || 0);
  if (stateAge >= 2 && Math.abs(steeringDemand) >= 7) {
    const desiredSign = Math.sign(steeringDemand);
    const appliedSign = Math.sign(Number(guarded.steer) || 0);
    if (desiredSign !== appliedSign) {
      const magnitude = Math.abs(steeringDemand) > 55
        ? 0.8
        : Math.abs(steeringDemand) > 18
          ? 0.45
          : 0.18;
      guarded.steer = desiredSign * magnitude;
      guards.push("latency_steer");
    }
  }
  const maxSteer = Math.abs(currentSpeed) > 60
    ? 0.45
    : Math.abs(currentSpeed) > 40
      ? 0.6
      : 0.8;
  if (Math.abs(guarded.steer) > maxSteer) {
    guarded.steer = Math.sign(guarded.steer) * maxSteer;
    guards.push("speed_steer_limit");
  }

  const stuckForS = stuckDurationS(now);
  const needsRecovery =
    driving.off_track ||
    Math.abs(driving.target_heading_deg) > 75 ||
    stuckForS >= 6;
  if (
    stuckForS >= 3.5 &&
    needsRecovery &&
    !currentTelemetry.kart?.animated &&
    now - lastRescueAt >= 5000
  ) {
    guarded.rescue = true;
    guards.push("stuck_rescue");
    lastRescueAt = now;
  }
  if (guards.length) guarded.guard = [...new Set(guards)].join("+");
  return guarded;
}

function makeHistoryLine(decision) {
  const action = decision.action;
  const steerProbability = formatProbability(
    choiceProbability(decision.answers?.steering),
  );
  const throttleProbability = formatProbability(
    choiceProbability(decision.answers?.throttle),
  );
  const sequence = String(decision.telemetry.sequence).padStart(5, "0");
  const buttons = [
    action.drift ? "D+" : "D-",
    action.nitro ? "N+" : "N-",
    action.fire ? "F+" : "F-",
    action.rescue ? "R+" : "R-",
  ].join(" ");
  const actualDirection = directionToken(action);
  const selectedDirection = selectedDirectionToken(action);
  const actualThrottle = throttleToken(action);
  const selectedThrottle = selectedThrottleToken(action);
  const overridden = [];
  if (actualDirection !== selectedDirection) {
    overridden.push(`DIR ${selectedDirection}`);
  }
  if (actualThrottle !== selectedThrottle) {
    overridden.push(`THR ${selectedThrottle}`);
  }
  const selectedSuffix = overridden.length
    ? ` | JEV ${overridden.join(" ")}`
    : "";
  return (
    `#${sequence} [${actualDirection} ${steerProbability}] ` +
    `[${actualThrottle} ${throttleProbability}] ${buttons} ` +
    `${decision.latencyMs}ms${action.guard ? " G!" : ""}${selectedSuffix}`
  );
}

function directionToken(action) {
  const steer = Number(action?.steer) || 0;
  if (steer <= -0.65) return "<<<";
  if (steer <= -0.3) return "<<";
  if (steer < -0.05) return "<";
  if (steer >= 0.65) return ">>>";
  if (steer >= 0.3) return ">>";
  if (steer > 0.05) return ">";
  return "-";
}

function selectedDirectionToken(action) {
  const tokens = {
    hard_left: "<<<",
    left: "<<",
    slight_left: "<",
    straight: "-",
    slight_right: ">",
    right: ">>",
    hard_right: ">>>",
  };
  const choice = action?.choices?.steering;
  if (tokens[choice]) return tokens[choice];
  return directionToken(action);
}

function throttleToken(action) {
  if (action?.brake) return "BRAKE";
  if ((Number(action?.accel) || 0) > 0.8) return "FULL";
  if ((Number(action?.accel) || 0) > 0) return "CRUISE";
  return "COAST";
}

function selectedThrottleToken(action) {
  const tokens = {
    hard_brake: "BRAKE",
    coast: "COAST",
    cruise: "CRUISE",
    full: "FULL",
  };
  const choice = action?.choices?.throttle;
  if (tokens[choice]) return tokens[choice];
  return throttleToken(action);
}

function averageLatencyMs(fallback = 0) {
  return latencySamples.length
    ? latencySamples.reduce((sum, value) => sum + value, 0) /
        latencySamples.length
    : fallback;
}

function logDecision(telemetry, action, usage, latencyMs) {
  const speed = Math.round(Number(telemetry.kart.speed_kph) || 0);
  const driving = deriveDrivingState(telemetry);
  const currentMotion = deriveMotionTrend(telemetryHistory, {
    predictionHorizonMs: Math.min(600, averageLatencyMs(400)),
    stuckForS: stuckDurationS(Date.now()),
  });
  const mode = mock ? "mock" : "Jev";
  const tokenText = usage
    ? ` tokens=${usage.totalTokens ?? "?"}`
    : "";
  const guardText = action.guard ? ` guard=${action.guard}` : "";
  const cost = (totalInputTokens * inputPricePerMillion) / 1_000_000;
  console.log(
    `[${mode}] state #${telemetry.sequence} ${speed}km/h ` +
      `steer=${action.choices.steering}->${action.steer.toFixed(2)} ` +
      `throttle=${action.choices.throttle}->${throttleToken(action)} ` +
      `drift=${action.drift} nitro=${action.nitro}${guardText} ` +
      `path=${driving.target_heading_deg}° offset=${driving.lateral_offset_m}m ` +
      `demand=${currentMotion.steering_demand_deg}° off=${driving.off_track} ` +
      `latency=${latencyMs}ms${tokenText} ` +
      `rate=${recentRate(requestTimes, Date.now()).toFixed(1)}Hz cost=$${cost.toFixed(6)}`,
  );
}

function recordUsage(usage) {
  if (!usage) return;
  const input = finiteNumber(usage.inputTokens)
    ? usage.inputTokens
    : finiteNumber(usage.totalTokens)
      ? usage.totalTokens
      : 0;
  totalInputTokens += input;
}

function recentRate(timestamps, now) {
  const windowMs = 2000;
  while (timestamps.length && timestamps[0] < now - windowMs) timestamps.shift();
  const observedMs = Math.min(windowMs, Math.max(250, now - bridgeStartedAt));
  return (timestamps.length * 1000) / observedMs;
}

function choiceProbability(answer) {
  const probability = answer?.probabilities?.[answer?.choice];
  return finiteNumber(probability) ? probability : undefined;
}

function mockAnswers(action) {
  return {
    steering: { choice: action.choices.steering },
    throttle: { choice: action.choices.throttle },
    drift: { probability: action.drift ? 1 : 0 },
    nitro: { probability: action.nitro ? 1 : 0 },
    use_item: { probability: action.fire ? 1 : 0 },
    rescue: { probability: action.rescue ? 1 : 0 },
  };
}

function label(value) {
  return String(value ?? "waiting").replaceAll("_", " ").toUpperCase();
}

function formatProbability(value) {
  return finiteNumber(value) ? `${Math.round(value * 100)}%` : "--";
}

function formatNumber(value, digits) {
  return finiteNumber(value) ? value.toFixed(digits) : "--";
}

function formatSigned(value, digits) {
  if (!finiteNumber(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function rounded(value, digits) {
  if (!finiteNumber(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function numberSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function close() {
  if (closing) return;
  closing = true;
  if (evaluationTimer) clearInterval(evaluationTimer);
  for (const controller of abortControllers) controller.abort();
  socket.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
