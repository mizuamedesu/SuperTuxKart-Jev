# Jev external controller protocol

The Jev controller is an opt-in local player controller for the actual
SuperTuxKart game. It exchanges UTF-8 JSON over UDP on IPv4 loopback. The game
never sends screenshots. State comes directly from the race, kart, physics,
and driveline objects.

## Transport

- Game telemetry: `127.0.0.1:19736`, 10 datagrams per second by default.
- Game controls: `127.0.0.1:19737`.
- Every datagram contains one complete JSON object.
- `sequence` is monotonically increasing in each direction. The game ignores
  duplicate and out-of-order controls.
- `session` changes whenever the race controller resets, so telemetry
  sequences can safely restart at one.
- If no fresh control arrives within 2500 ms, the game centers steering,
  releases acceleration and nitro, and brakes.

All ports, telemetry frequency, and watchdog duration can be changed with the
`--jev-*` command-line options shown by `supertuxkart --help`.

## Telemetry packet

```json
{
  "type": "telemetry",
  "version": 1,
  "session": 3,
  "sequence": 42,
  "race": {
    "time_s": 12.5,
    "jev_started": true,
    "started": true,
    "finished": false,
    "lap": 0,
    "laps": 1,
    "position": 2,
    "kart_count": 4
  },
  "kart": {
    "speed_mps": 18.2,
    "speed_kph": 65.52,
    "energy": 4,
    "heading_rad": 1.2,
    "velocity_local_mps": { "x": -0.3, "z": 18.1 },
    "yaw_rate_rad_s": -0.24,
    "on_ground": true,
    "animated": false,
    "xyz": { "x": 1, "y": 2, "z": 3 },
    "powerup": { "name": "cake", "count": 1 },
    "attachment_type": 8,
    "controls": {
      "steer": -0.25,
      "accel": 1,
      "brake": false,
      "nitro": false
    }
  },
  "track": {
    "name": "lighthouse",
    "node": 17,
    "on_road": true,
    "off_track": false,
    "lateral_offset_m": 0.4,
    "width_m": 9.5,
    "distance_m": 128.1,
    "lap_length_m": 815.2,
    "lookahead": [
      { "distance_m": 5.2, "local_x_m": -0.8, "local_z_m": 5.1, "width_m": 9.5 }
    ]
  },
  "nearby_karts": [
    { "distance_m": 8.1, "local_x_m": 1.2, "local_z_m": 8, "speed_mps": 17, "position": 1 }
  ]
}
```

Kart-local `local_x_m` is negative to the left and positive to the right.
`local_z_m` is positive ahead. `lateral_offset_m` is negative left of the
driveline center and positive right. `velocity_local_mps` uses the same kart
axes, and positive `yaw_rate_rad_s` turns right.

`race.jev_started` remains false while the in-game start panel is open. The
bundled bridge does not evaluate telemetry until both it and `race.started`
are true.

## Control packet

```json
{
  "type": "control",
  "version": 1,
  "sequence": 81,
  "based_on": 42,
  "steer": -0.45,
  "accel": 0.55,
  "brake": false,
  "nitro": false,
  "drift": true,
  "fire": false,
  "rescue": false,
  "hud_1": "JEV LIVE | REQUEST 10.0 Hz | RESULT 9.8 Hz | APPLY 8.1 Hz | IN-FLIGHT 4 | LAT 410 ms",
  "hud_2": "INPUT #42 | SPEED 65.5 km/h | LOCAL VX -0.30 VZ +18.10 m/s | YAW -13.8 deg/s",
  "history_1": "#00042 [<< 84%] [CRUISE 91%] D- N- F- R- 410ms"
}
```

`steer` is clamped to `[-1, 1]`; `accel` is clamped to `[0, 1]`. Braking
overrides acceleration. Buttons are booleans. The game currently requires
`sequence`, `steer`, and `accel`; omitted buttons default to false.

The bundled bridge also sends eight optional `hud_N` strings for structured
input, predictions, throughput, usage, and cost. Ten optional `history_N`
strings contain newest-first applied controls and Jev choice probabilities.
The modified game renders the two groups in separate panels over the race;
other protocol clients may omit them.
