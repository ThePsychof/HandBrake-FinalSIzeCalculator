<div align="center">

# HandBrake FinalSIzeCalculator

### Know what your encode might cost in storage—before you commit to the full encode.

A compact, local-first desktop companion for HandBrake. See a quick output-size estimate and the settings behind it, without uploading your media or quietly starting a full encode.

</div>

---

## A clearer answer before you encode

Configure your job in HandBrake, open the predictor, and review the estimate alongside a concise summary of the active settings. When HandBrake exposes the information, the app synchronizes it for you; otherwise, the relevant fields remain available for manual entry.

**No account. No media uploads. No analytics. No surprise full encode.**

## What it does

- **Estimates average-bitrate output size** from video bitrate, duration, and each known audio contribution.
- **Accounts for passthrough audio** using locally probed source-stream data when it can be matched reliably.
- **Shows partial estimates honestly** when a contribution is unknown, rather than filling gaps with invented defaults.
- **Reads source metadata locally** with an installed `ffprobe` when available, and uses HandBrakeCLI scanning as a fallback.
- **Synchronizes visible HandBrake settings on Windows** using Windows UI Automation, with read-only access to local queue data for queued jobs.
- **Remembers completed results locally** so comparable real encodes can inform future constant-quality estimates.
- **Keeps the interface focused** on the predicted size, a short input summary, and scan status.

## An estimate, not a guarantee

Average-bitrate mode calculates the nominal video payload from the selected bitrate and duration, then adds known audio payloads. Explicit overhead can be included when configured. Unknown stream or container contributions are called out; they are not hidden behind arbitrary multipliers.

Constant Quality / RF is different: RF is not a bitrate, and content complexity has a major impact on size. Without comparable completed encodes, the app does not invent a precise RF-to-size conversion. Historical calibration is local and only uses a small set of sufficiently comparable results; its observed range is descriptive, not a validated confidence interval.

Predictions have **not yet been validated against completed encodes across representative media and settings**. Treat them as planning estimates, not a promise of final file size.


## HandBrake integration

On Windows, the app reads HandBrake through built-in Windows UI Automation. On first detection, it reviews the accessible settings tabs once and restores the previously selected tab. Later refreshes read the currently selected tab; changing tabs refreshes that tab's cached values. The app does not inject into HandBrake, alter its process, or start an encode to inspect a job.

The active, unqueued job is not fully available through a supported external HandBrake API. Some settings may therefore be unavailable through accessibility, especially details inside audio and subtitle row templates. The app identifies unavailable fields instead of presenting preset defaults as the user's active choices. Full source paths may be recovered from the local HandBrake activity log; source probing runs only when a path is available.

Use **Locate HandBrakeCLI** to select a CLI executable, or set `HANDBRAKE_CLI` before launch. HandBrakeCLI source scanning is a metadata fallback; it is not used to encode the entire video for a prediction.

## Privacy and local data

Media probing and prediction run on your computer. Source files are read for metadata only; they are not modified or uploaded. HandBrake integration reads accessible GUI information and local HandBrake files. Calibration history and the selected CLI path are stored locally by the app.

## Technical notes

- Video payload in average-bitrate mode is based on the selected output bitrate and effective duration available to the app. When only the title duration is exposed, a selected chapter/time range may not be reflected.
- Passthrough estimates use measured stream size when available for a matching full-duration stream, otherwise a known source bitrate. Ambiguous source-track matches are not guessed.
- Burned-in subtitles are part of the video image and are not counted as an additional stream. Unknown separate subtitle payload and variable container/mux overhead can make final size differ.
- Two-pass encoding does not receive an arbitrary size multiplier.
- Sizes are calculated from decimal bitrates; the UI reports binary GiB and decimal GB.
- Windows live integration was developed against HandBrake 1.11.2. UI Automation is version- and accessibility-dependent.

For details on HandBrake's own options, see the [CLI command-line reference](https://handbrake.fr/docs/en/latest/cli/command-line-reference.html), [CLI options guide](https://handbrake.fr/docs/en/latest/cli/cli-options.html), and [official presets](https://handbrake.fr/docs/en/latest/technical/official-presets.html).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/main` | Electron main process, local probing, and HandBrake integration |
| `src/preload` | Context-isolated bridge between the app and UI |
| `src/renderer` | Compact desktop interface |
| `src/shared` | Types, parsers, prediction math, and calibration helpers |

