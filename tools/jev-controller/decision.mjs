const steeringValues = Object.freeze({
  hard_left: -0.8,
  left: -0.45,
  slight_left: -0.18,
  straight: 0,
  slight_right: 0.18,
  right: 0.45,
  hard_right: 0.8,
});

const throttleValues = Object.freeze({
  hard_brake: { accel: 0, brake: true },
  coast: { accel: 0, brake: false },
  cruise: { accel: 0.55, brake: false },
  full: { accel: 1, brake: false },
});

export function deriveDrivingState(telemetry) {
  const lookahead = Array.isArray(telemetry?.track?.lookahead)
    ? telemetry.track.lookahead
    : [];
  const angles = lookahead
    .map((point) => headingDegrees(point?.local_x_m, point?.local_z_m))
    .filter(Number.isFinite);
  const maxCurveDeg = angles.reduce(
    (maximum, angle) => Math.max(maximum, Math.abs(angle)),
    0,
  );
  const targetHeadingDeg = angles.length > 0 ? angles[Math.min(1, angles.length - 1)] : 0;
  const width = Math.max(0.1, number(telemetry?.track?.width_m));
  const lateralOffset = number(telemetry?.track?.lateral_offset_m);
  const edgeMargin = width / 2 - Math.abs(lateralOffset);
  const offTrack = Boolean(telemetry?.track?.off_track);

  let recommendedSpeedKph = 92;
  if (maxCurveDeg > 90) recommendedSpeedKph = 12;
  else if (maxCurveDeg > 55) recommendedSpeedKph = 24;
  else if (maxCurveDeg > 38) recommendedSpeedKph = 34;
  else if (maxCurveDeg > 25) recommendedSpeedKph = 46;
  else if (maxCurveDeg > 14) recommendedSpeedKph = 62;
  else if (maxCurveDeg > 7) recommendedSpeedKph = 76;
  if (offTrack) recommendedSpeedKph = Math.min(recommendedSpeedKph, 20);

  return {
    target_heading_deg: round(targetHeadingDeg),
    maximum_curve_deg: round(maxCurveDeg),
    lateral_offset_m: round(lateralOffset),
    road_edge_margin_m: round(edgeMargin),
    recommended_speed_kph: recommendedSpeedKph,
    off_track: offTrack,
    local_lateral_speed_mps: round(
      number(telemetry?.kart?.velocity_local_mps?.x),
    ),
    local_forward_speed_mps: round(
      number(telemetry?.kart?.velocity_local_mps?.z),
    ),
    yaw_rate_deg_s: round(
      number(telemetry?.kart?.yaw_rate_rad_s) * (180 / Math.PI),
    ),
  };
}

/** Summarizes recent samples and predicts where the kart will be when Jev's
 * response is likely to arrive. Records are captured by the bridge as
 * { telemetry, received_at_ms } so this remains independent of game pauses. */
export function deriveMotionTrend(
  records,
  { predictionHorizonMs = 400, stuckForS = 0 } = {},
) {
  const valid = Array.isArray(records)
    ? records.filter(
        (record) =>
          record?.telemetry && Number.isFinite(record?.received_at_ms),
      )
    : [];
  const latestRecord = valid.at(-1);
  const latest = latestRecord?.telemetry;
  const latestDriving = deriveDrivingState(latest);
  const horizonS = clamp(number(predictionHorizonMs) / 1000, 0, 1.5);

  if (!latestRecord || valid.length < 2) {
    const steering = steeringDemand(
      latest,
      latestDriving,
      latestDriving.target_heading_deg,
      latestDriving.lateral_offset_m,
    );
    const speed = speedGuidance(
      latest,
      latestDriving,
      number(latest?.kart?.speed_kph),
    );
    return {
      sample_span_s: 0,
      speed_trend_kph_s: 0,
      lateral_offset_rate_mps: 0,
      path_heading_rate_deg_s: 0,
      progress_rate_mps: 0,
      predicted_path_heading_deg: latestDriving.target_heading_deg,
      predicted_lateral_offset_m: latestDriving.lateral_offset_m,
      ...steering,
      ...speed,
      prediction_horizon_ms: Math.round(horizonS * 1000),
      stuck_for_s: round(stuckForS),
    };
  }

  const oldestRecord = valid[0];
  const oldest = oldestRecord.telemetry;
  const spanS = Math.max(
    0.001,
    (latestRecord.received_at_ms - oldestRecord.received_at_ms) / 1000,
  );
  const oldestDriving = deriveDrivingState(oldest);
  const speedTrend =
    (number(latest?.kart?.speed_kph) - number(oldest?.kart?.speed_kph)) /
    spanS;
  const offsetRate = clamp(
    (latestDriving.lateral_offset_m - oldestDriving.lateral_offset_m) / spanS,
    -30,
    30,
  );
  const headingRate = clamp(
    angleDifference(
      latestDriving.target_heading_deg,
      oldestDriving.target_heading_deg,
    ) / spanS,
    -360,
    360,
  );
  const progressRate = progressDifference(oldest, latest) / spanS;
  const predictedHeading = normalizeAngle(
    latestDriving.target_heading_deg + headingRate * horizonS,
  );
  const predictedOffset = latestDriving.lateral_offset_m + offsetRate * horizonS;
  const steering = steeringDemand(
    latest,
    latestDriving,
    predictedHeading,
    predictedOffset,
  );
  const predictedSpeed = clamp(
    number(latest?.kart?.speed_kph) + speedTrend * horizonS,
    -20,
    160,
  );
  const speed = speedGuidance(
    latest,
    latestDriving,
    predictedSpeed,
  );

  return {
    sample_span_s: round(spanS),
    speed_trend_kph_s: round(speedTrend),
    lateral_offset_rate_mps: round(offsetRate),
    path_heading_rate_deg_s: round(headingRate),
    progress_rate_mps: round(progressRate),
    predicted_path_heading_deg: round(predictedHeading),
    predicted_lateral_offset_m: round(predictedOffset),
    ...steering,
    ...speed,
    prediction_horizon_ms: Math.round(horizonS * 1000),
    stuck_for_s: round(stuckForS),
  };
}

export function actionFromEvaluation(answers, basedOn, telemetry) {
  const steeringChoice = answers?.steering?.choice;
  const throttleChoice = answers?.throttle?.choice;
  if (!(steeringChoice in steeringValues)) {
    throw new Error(`Unexpected steering choice: ${String(steeringChoice)}`);
  }
  if (!(throttleChoice in throttleValues)) {
    throw new Error(`Unexpected throttle choice: ${String(throttleChoice)}`);
  }
  let throttle = throttleValues[throttleChoice];
  let guard;
  // STK maps a held brake to reverse gear after the kart stops. Make a
  // stalled/reversing kart crawl forward even if a delayed decision still
  // asks for braking.
  if (
    telemetry &&
    throttleChoice === "hard_brake" &&
    number(telemetry?.kart?.speed_kph) <= 5
  ) {
    throttle = throttleValues.cruise;
    guard = "forward_recovery";
  }
  const action = {
    based_on: basedOn,
    steer: steeringValues[steeringChoice],
    accel: throttle.accel,
    brake: throttle.brake,
    nitro: probability(answers?.nitro) >= 0.7,
    drift: probability(answers?.drift) >= 0.67,
    fire: probability(answers?.use_item) >= 0.72,
    rescue: probability(answers?.rescue) >= 0.78,
    choices: {
      steering: steeringChoice,
      throttle: throttleChoice,
    },
  };
  if (guard) action.guard = guard;
  return action;
}

export function mockAction(telemetry) {
  const derived = deriveDrivingState(telemetry);
  const targetRadians = derived.target_heading_deg * (Math.PI / 180);
  const width = Math.max(1, number(telemetry?.track?.width_m));
  const centering = -number(telemetry?.track?.lateral_offset_m) / (width / 2);
  const steer = clamp(targetRadians * 2.1 + centering * 0.35, -1, 1);
  const speed = number(telemetry?.kart?.speed_kph);
  const brake = speed > derived.recommended_speed_kph + 9;
  return {
    based_on: telemetry.sequence,
    steer: round(steer),
    accel: brake ? 0 : speed < derived.recommended_speed_kph ? 1 : 0.35,
    brake,
    nitro:
      !derived.off_track &&
      derived.maximum_curve_deg < 5 &&
      number(telemetry?.kart?.energy) > 1,
    drift: derived.maximum_curve_deg > 28 && speed > 35,
    fire: false,
    rescue: derived.off_track && Math.abs(derived.target_heading_deg) > 100,
    choices: { steering: "mock", throttle: "mock" },
  };
}

export function isTelemetry(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.type === "telemetry" &&
    value.version === 1 &&
    Number.isSafeInteger(value.session) &&
    value.session > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    value.race !== null &&
    typeof value.race === "object" &&
    typeof value.race.jev_started === "boolean" &&
    value.kart !== null &&
    typeof value.kart === "object" &&
    value.track !== null &&
    typeof value.track === "object"
  );
}

function probability(answer) {
  return Number.isFinite(answer?.probability) ? answer.probability : 0;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function headingDegrees(x, z) {
  const localX = number(x);
  const localZ = number(z);
  if (Math.abs(localX) < 0.0001 && Math.abs(localZ) < 0.0001) return 0;
  return Math.atan2(localX, localZ) * (180 / Math.PI);
}

function angleDifference(current, previous) {
  return normalizeAngle(number(current) - number(previous));
}

function normalizeAngle(value) {
  let normalized = number(value);
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  return normalized;
}

function progressDifference(oldest, latest) {
  const lapLength = Math.max(
    number(oldest?.track?.lap_length_m),
    number(latest?.track?.lap_length_m),
  );
  const oldDistance = number(oldest?.track?.distance_m);
  const newDistance = number(latest?.track?.distance_m);
  const oldLap = number(oldest?.race?.lap);
  const newLap = number(latest?.race?.lap);
  if (lapLength > 0 && oldLap >= 0 && newLap >= 0) {
    return (newLap - oldLap) * lapLength + newDistance - oldDistance;
  }
  let difference = newDistance - oldDistance;
  if (lapLength > 0 && difference < -lapLength / 2) difference += lapLength;
  if (lapLength > 0 && difference > lapLength / 2) difference -= lapLength;
  return difference;
}

function steeringDemand(telemetry, driving, predictedHeading, predictedOffset) {
  const halfWidth = Math.max(0.5, number(telemetry?.track?.width_m) / 2);
  const centerCorrection =
    -clamp(number(predictedOffset) / halfWidth, -1.5, 1.5) * 24;
  const lateralVelocityCorrection =
    -clamp(number(driving?.local_lateral_speed_mps), -10, 10) * 2;
  const yawDamping = -clamp(number(driving?.yaw_rate_deg_s), -180, 180) * 0.06;
  const demand = normalizeAngle(
    number(predictedHeading) +
      centerCorrection +
      lateralVelocityCorrection +
      yawDamping,
  );
  return {
    center_correction_deg: round(centerCorrection),
    steering_demand_deg: round(demand),
    steering_demand_direction:
      demand < -4 ? "left" : demand > 4 ? "right" : "straight",
  };
}

function speedGuidance(telemetry, driving, predictedSpeed) {
  const currentSpeed = number(telemetry?.kart?.speed_kph);
  const targetSpeed = number(driving?.recommended_speed_kph);
  let guidance = "accelerate";
  if (driving?.off_track && Math.abs(currentSpeed) < 25) {
    guidance = "recover_with_throttle";
  } else if (currentSpeed > 25 && predictedSpeed > targetSpeed + 10) {
    guidance = "brake";
  } else if (predictedSpeed > targetSpeed) {
    guidance = "coast";
  } else if (predictedSpeed > targetSpeed - 8) {
    guidance = "cruise";
  }
  return {
    predicted_speed_kph: round(predictedSpeed),
    speed_error_to_target_kph: round(predictedSpeed - targetSpeed),
    throttle_guidance: guidance,
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
