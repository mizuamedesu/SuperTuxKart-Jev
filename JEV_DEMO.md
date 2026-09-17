# SuperTuxKart driven by Jev

This fork adds a controller to the real SuperTuxKart engine. C++ code reads
race state and driveline geometry directly, sends structured JSON over local
UDP, and applies returned controls to the player kart. The local Node bridge
uses Vercel AI Gateway's `typesafe-ai/jev` evaluation model to answer typed
steering, throttle, drift, nitro, item, and rescue questions in one request.

No browser game, screen capture, image model, Worker, or separately deployed
bridge is in the control path. The bridge runs on the same Mac and calls Jev
through Vercel AI Gateway.

## macOS quick start

Install the official SuperTuxKart app once so its game assets are available at
`/Applications/SuperTuxKart.app`, then run:

```bash
brew bundle
tools/jev-controller/build-macos.sh
npm --prefix tools/jev-controller ci
export AI_GATEWAY_API_KEY="..."
tools/jev-controller/run-demo.sh
```

You can instead put the key in `.env` at the repository root, or copy
`tools/jev-controller/.env.example` to `tools/jev-controller/.env`. Both files
are ignored by Git.

The launcher opens the modified local game on Lighthouse with four karts for
one lap. The race is paused behind an in-game **START JEV** panel. Jev requests
remain gated until that button is pressed. Set `STK_TRACK`, `STK_KART`, or
`STK_NUM_KARTS` to change the race setup.
The bridge starts one Jev evaluation every 100 ms (10 Hz) and allows the
requests to overlap so model latency does not reduce the input frequency. The
left HUD panel shows the latest structured input, response-time path and speed
predictions, request/result/applied rates, concurrent calls, latency,
cumulative input tokens, and estimated cost. A separate panel on the right
stacks the ten newest applied controls like a fighting-game input history. Each
row shows direction, throttle, button states, choice probabilities, and
latency. `G!` marks a local latency/recovery guard; if it changed a stale Jev
choice, the original selection is printed after `JEV` on that row.

Each request includes kart-local velocity, yaw rate, the latest driveline
points, nearby karts, recent motion samples, and a prediction for the expected
response time. Cost uses Jev's published input price of $0.04 per million
tokens and the usage returned by AI Gateway.

`JEV_DECISION_INTERVAL_MS`, `JEV_MAX_IN_FLIGHT`, and
`JEV_INPUT_PRICE_PER_MILLION_USD` can override those defaults in `.env`.

To verify the game/JSON/control path without making an API call:

```bash
tools/jev-controller/run-demo.sh --mock
```

Mock mode is only a deterministic transport test; the normal command uses
Jev. See [the protocol](doc/jev-controller-protocol.md) to connect another
local controller.
