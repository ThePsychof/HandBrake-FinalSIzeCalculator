import { bitrateToBytesPerSecond, safeDivide } from './units.js';
import {
  AudioTrack,
  CalibrationRecord,
  MediaInfo,
  OutputSettings,
  PredictionBreakdownItem,
  PredictionResult,
  SampleAnalysis,
} from './types.js';

function emptyPrediction(
  mode: PredictionResult['mode'],
  status: PredictionResult['estimateStatus'],
  methodology: string,
  assumptions: string[],
  calibrationSamples = 0,
): PredictionResult {
  return {
    mode,
    predictedBytes: null,
    lowerBoundBytes: null,
    upperBoundBytes: null,
    streamPayloadBytes: null,
    predictedGiB: 0,
    predictedGB: 0,
    breakdown: [],
    methodology,
    assumptions,
    uncertaintyText: 'No validated uncertainty range is available.',
    calibrationSamples,
    estimateStatus: status,
  };
}

function getAudioPayload(
  media: MediaInfo,
  settings: OutputSettings,
  durationSeconds: number,
): { bytes: number; missing: string[] } {
  let bytes = 0;
  const missing: string[] = [];

  for (const selected of settings.audioTracks.filter((track) => track.enabled)) {
    if (selected.sourceTrackMatch === false) {
      missing.push(`Output audio track ${selected.index + 1} could not be matched unambiguously to a source stream.`);
      continue;
    }
    const source: AudioTrack | undefined = selected.sourceStreamIndex !== undefined
      ? media.audioTracks.find((track) => track.streamIndex === selected.sourceStreamIndex)
      : media.audioTracks.find((track) => track.index === selected.index);

    if (selected.passthrough) {
      const outputCodec = selected.codec === 'copy' ? source?.codec : selected.codec;
      const compatibleContainers: Record<string, string[]> = {
        aac: ['mp4', 'm4v', 'mov', 'mkv'],
        ac3: ['mp4', 'm4v', 'mov', 'mkv'],
        eac3: ['mkv'],
        mp3: ['mp4', 'm4v', 'mov', 'mkv'],
        opus: ['mkv'],
        flac: ['mkv'],
      };
      if (!source) {
        missing.push(`Passthrough audio track ${selected.index + 1} has no verified source stream match.`);
        continue;
      }
      if (outputCodec !== source.codec
        || !compatibleContainers[outputCodec]?.includes(settings.container)) {
        missing.push(`Passthrough audio track ${selected.index + 1} is not verified as compatible with ${settings.container}.`);
        continue;
      }
      const durationMatchesStream = source.durationSeconds === undefined
        || Math.abs(source.durationSeconds - durationSeconds) <= 1;
      if (source.streamSizeBytes !== undefined && source.streamSizeBytes >= 0 && durationMatchesStream) {
        bytes += source.streamSizeBytes;
      } else if (source?.bitrateKbps !== undefined && source.bitrateKbps > 0) {
        bytes += bitrateToBytesPerSecond(source.bitrateKbps) * durationSeconds;
      } else if (source?.nominalBitrateKbps !== undefined && source.nominalBitrateKbps > 0) {
        bytes += bitrateToBytesPerSecond(source.nominalBitrateKbps) * durationSeconds;
      } else {
        missing.push(source.streamSizeBytes !== undefined && !durationMatchesStream
          ? `Passthrough audio track ${selected.index + 1} has a measured full-stream size but no bitrate to estimate a trimmed range.`
          : `Passthrough audio track ${selected.index + 1} has no source stream size or bitrate.`);
      }
      continue;
    }

    if (selected.bitrateKbps === undefined || !Number.isFinite(selected.bitrateKbps) || selected.bitrateKbps <= 0) {
      missing.push(`Encoded audio track ${selected.index + 1} has no valid output bitrate.`);
      continue;
    }
    bytes += bitrateToBytesPerSecond(selected.bitrateKbps) * durationSeconds;
  }

  return { bytes, missing };
}

function makeBreakdown(
  videoBytes: number,
  audioBytes: number,
  subtitleBytes: number,
  containerBytes: number,
  totalBytes: number,
): PredictionBreakdownItem[] {
  return [
    { label: 'Video payload', bytes: videoBytes, percent: safeDivide(videoBytes, totalBytes) * 100 },
    { label: 'Audio payload', bytes: audioBytes, percent: safeDivide(audioBytes, totalBytes) * 100 },
    { label: 'Subtitle payload (not estimated)', bytes: subtitleBytes, percent: safeDivide(subtitleBytes, totalBytes) * 100 },
    { label: 'Container overhead', bytes: containerBytes, percent: safeDivide(containerBytes, totalBytes) * 100 },
  ];
}

export function buildAverageBitratePrediction(media: MediaInfo, settings: OutputSettings): PredictionResult {
  const duration = media.durationSeconds;
  const videoBitrate = settings.videoBitrateKbps;
  const missing: string[] = [];

  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
    missing.push('Enter a valid source duration in seconds.');
  }
  if (videoBitrate === undefined || !Number.isFinite(videoBitrate) || videoBitrate <= 0) {
    missing.push('Enter the selected output video bitrate in kbit/s.');
  }
  if (missing.length > 0 || duration === undefined || videoBitrate === undefined) {
    return emptyPrediction(
      'average-bitrate',
      'insufficient-inputs',
      'Average-bitrate payload is calculated from selected output bitrates and source duration.',
      [...missing, 'No bitrate, duration, or stream metadata is substituted when it is missing.'],
    );
  }

  const videoBytes = bitrateToBytesPerSecond(videoBitrate) * duration;
  const audio = getAudioPayload(media, settings, duration);

  const subtitleTracks = settings.subtitleTracks.filter((track) => track.enabled);
  const separateSubtitleCount = subtitleTracks.filter((track) => !track.burnIn).length;
  const containerPercent = settings.muxingOverheadPercent;
  const containerBytes = containerPercent !== undefined && Number.isFinite(containerPercent) && containerPercent >= 0
    ? (videoBytes + audio.bytes) * containerPercent / 100
    : 0;
  const subtitleBytes = 0;
  const payloadBytes = videoBytes + audio.bytes + subtitleBytes;
  const totalBytes = payloadBytes + containerBytes;
  const missingContributions = [
    ...audio.missing,
    ...(separateSubtitleCount > 0 ? [`${separateSubtitleCount} separate subtitle stream(s) are excluded because their output sizes are unavailable.`] : []),
  ];

  const assumptions = [
    'Video and encoded-audio payloads use selected average bitrate × source duration (decimal kbit/s). Two-pass mode does not change this target payload calculation.',
    'Passthrough audio uses the source track byte size when known, otherwise its source bitrate × duration; a missing source measurement blocks a complete estimate.',
    separateSubtitleCount > 0
      ? `${separateSubtitleCount} separate subtitle stream(s) are selected; their sizes are excluded because no source subtitle byte measurement or defensible bitrate is available.`
      : media.subtitleTracksKnown === false
        ? 'The source subtitle list was unavailable; no separate subtitle payload is included.'
        : 'No separate subtitle stream payload is included.',
    ...(settings.audioTracks.filter((track) => track.enabled).length === 0 && media.audioTracksKnown === false
    ? ['The source audio list was unavailable; no audio payload is included. Add a manual audio track if the output will contain audio.']
    : []),
    ...(settings.audioTracks.filter((track) => track.enabled).length === 0 && media.audioTracks.length > 0
    ? ['No audio output tracks are selected; no audio payload is included.']
    : []),
    subtitleTracks.some((track) => track.burnIn)
      ? 'Burned-in subtitles are part of the video pixels and are represented only within the selected video bitrate; no extra subtitle payload is added.'
      : 'Burned-in subtitles are not selected.',
    containerPercent === undefined
      ? 'Container overhead is unknown and excluded; set an overhead percentage only if you have a justified value.'
      : `Container overhead is an explicit user estimate of ${containerPercent}% and is shown separately.`,
    'Average bitrate is a target; encoder rate-control behavior, timestamps, and muxing mean actual stream/file size may differ.',
    ...(audio.missing.length > 0 ? ['The displayed total is a partial estimate: missing audio payload is excluded, not treated as zero output.'] : []),
  ];

  return {
    mode: 'average-bitrate',
    predictedBytes: totalBytes,
    lowerBoundBytes: null,
    upperBoundBytes: null,
    streamPayloadBytes: payloadBytes,
    predictedGiB: totalBytes / (1024 ** 3),
    predictedGB: totalBytes / (1000 ** 3),
    breakdown: makeBreakdown(videoBytes, audio.bytes, subtitleBytes, containerBytes, totalBytes),
    methodology: 'Nominal stream payloads are calculated independently from configured bitrates and duration. Container overhead is separate and only added when explicitly supplied.',
    assumptions,
    uncertaintyText: 'This is a bitrate-derived payload estimate, not a validated final-file range. Subtitle payload (if separate) and unmodelled mux overhead are excluded.',
    calibrationSamples: 0,
    estimateStatus: 'estimate',
    missingContributions,
    isPartial: missingContributions.length > 0,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function buildConstantQualityEstimate(
  media: MediaInfo,
  settings: OutputSettings,
  sampleAnalyses: SampleAnalysis[] = [],
  calibrationRecords: CalibrationRecord[] = [],
): PredictionResult {
  const duration = media.durationSeconds;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
    return emptyPrediction(
      'constant-quality',
      'insufficient-inputs',
      'RF output size cannot be inferred from source bitrate alone.',
      ['Enter a valid source duration.', 'Metadata-only RF size is experimental and no numeric estimate is provided without comparable encode history or measured samples.'],
    );
  }

  const validSamples = sampleAnalyses.filter((sample) =>
    Number.isFinite(sample.sampleDurationSeconds)
    && sample.sampleDurationSeconds > 0
    && Number.isFinite(sample.videoPayloadBytes)
    && sample.videoPayloadBytes >= 0
    && sample.sampleStartSeconds >= 0
    && sample.sampleStartSeconds + sample.sampleDurationSeconds <= duration,
  );
  const validCalibration = calibrationRecords.filter((record) =>
    Number.isFinite(record.actualBytes) && record.actualBytes > 0
    && Number.isFinite(record.sourceDurationSeconds) && record.sourceDurationSeconds > 0,
  );

  if (validSamples.length > 0) {
    const audio = getAudioPayload(media, settings, duration);
    if (audio.missing.length > 0) {
      return emptyPrediction(
        'constant-quality',
        'insufficient-inputs',
        'Sample analysis measures video payload; output audio must still be accounted independently.',
        audio.missing,
      );
    }

    const observedRates = validSamples.map((sample) =>
      sample.videoPayloadBytes * 8 / sample.sampleDurationSeconds / 1000,
    );
    const observedSampleSeconds = validSamples.reduce((sum, sample) => sum + sample.sampleDurationSeconds, 0);
    const observedVideoBytes = validSamples.reduce((sum, sample) => sum + sample.videoPayloadBytes, 0);
    const meanVideoRate = observedVideoBytes * 8 / observedSampleSeconds / 1000;
    const videoBytes = bitrateToBytesPerSecond(meanVideoRate) * duration;
    const containerBytes = settings.muxingOverheadPercent !== undefined && settings.muxingOverheadPercent >= 0
      ? (videoBytes + audio.bytes) * settings.muxingOverheadPercent / 100
      : 0;
    const totalBytes = videoBytes + audio.bytes + containerBytes;
    const rates = [...observedRates].sort((a, b) => a - b);
    const lowerVideo = bitrateToBytesPerSecond(rates[0]) * duration;
    const upperVideo = bitrateToBytesPerSecond(rates[rates.length - 1]) * duration;
    const hasSpread = rates.length > 1 && rates[0] !== rates[rates.length - 1];
    const subtitleCount = settings.subtitleTracks.filter((track) => track.enabled && !track.burnIn).length;

    return {
      mode: 'constant-quality',
      predictedBytes: totalBytes,
      lowerBoundBytes: hasSpread ? lowerVideo + audio.bytes + containerBytes : null,
      upperBoundBytes: hasSpread ? upperVideo + audio.bytes + containerBytes : null,
      streamPayloadBytes: videoBytes + audio.bytes,
      predictedGiB: totalBytes / (1024 ** 3),
      predictedGB: totalBytes / (1000 ** 3),
      breakdown: makeBreakdown(videoBytes, audio.bytes, 0, containerBytes, totalBytes),
      methodology: `Sample-based estimate: ${validSamples.length} measured sample(s), weighted by each sample's actual duration, extrapolated to the full source.`,
      assumptions: [
        'Measured sample sizes must be video payload only; audio and container bytes are accounted separately.',
        'Samples are assumed representative. The observed minimum/maximum sample rates are descriptive only, not a validated confidence interval.',
        `${subtitleCount} separate subtitle stream(s), if any, are not included because their payload was not measured.`,
        media.subtitleTracksKnown === false ? 'The source subtitle list was unavailable.' : 'Subtitle tracks were checked from the parsed source list.',
        'Container overhead is excluded unless an explicit percentage is supplied.',
      ],
      uncertaintyText: hasSpread
        ? 'The displayed bounds reflect only the observed sample-rate spread; sampling bias and scene variation may put the final encode outside this range.'
        : 'One observed rate provides no evidence-based uncertainty range; the result is an experimental extrapolation.',
      calibrationSamples: 0,
      estimateStatus: 'sample-based',
    };
  }

  if (validCalibration.length >= 3) {
    const normalizedSizes = validCalibration.map((record) => record.actualBytes / record.sourceDurationSeconds * duration);
    const estimate = median(normalizedSizes);
    const lower = Math.min(...normalizedSizes);
    const upper = Math.max(...normalizedSizes);
    return {
      mode: 'constant-quality',
      predictedBytes: estimate,
      lowerBoundBytes: lower,
      upperBoundBytes: upper,
      streamPayloadBytes: null,
      predictedGiB: estimate / (1024 ** 3),
      predictedGB: estimate / (1000 ** 3),
      breakdown: [],
      methodology: `Median actual file size normalized by duration from ${validCalibration.length} comparable historical encode(s).`,
      assumptions: [
        'This calibrated result represents whole-file sizes, so the video/audio/container breakdown is not available.',
        'The historical records were filtered for matching encoder, preset, resolution, rate-control settings, filters, and selected tracks where those details are recorded.',
        'Historical minimum and maximum are descriptive, not a validated prediction interval.',
      ],
      uncertaintyText: 'The range shows the observed spread among comparable records; it does not guarantee the next encode will fall within it.',
      calibrationSamples: validCalibration.length,
      estimateStatus: 'calibrated',
    };
  }

  const subtitleCount = settings.subtitleTracks.filter((track) => track.enabled && !track.burnIn).length;
  return emptyPrediction(
    'constant-quality',
    'experimental',
    'Metadata-only RF estimates are experimental and are not converted into a numeric size because no validated content-to-bitrate model is available.',
    [
      'RF is not a bitrate target; source bitrate, RF, codec name, or preset alone cannot reliably determine output size.',
      `Only ${validCalibration.length} comparable historical encode(s) were available; at least three are required before calibration is used.`,
      subtitleCount > 0 ? `${subtitleCount} separate subtitle stream(s) are selected, but their byte contribution is also unknown.` : 'Burned-in subtitles affect video complexity; separate subtitle sizes are not estimated.',
      media.subtitleTracksKnown === false ? 'The source subtitle list was unavailable.' : '',
      'The practical next step is to run short, user-selected HandBrakeCLI sample encodes from representative low-, medium-, and high-motion sections using the exact output settings, measure video payload bytes separately, and keep audio/container accounting outside those measurements.',
    ],
    validCalibration.length,
  );
}

export function createDefaultSettings(media: MediaInfo): OutputSettings {
  return {
    mode: 'average-bitrate',
    container: 'unknown',
    videoCodec: 'unknown',
    videoBitrateKbps: undefined,
    twoPass: false,
    qualityRf: 20,
    encoderPreset: 'medium',
    filterSettings: '',
    audioTracks: media.audioTracks.map((track) => ({
      index: track.index,
      codec: track.codec,
      bitrateKbps: undefined,
      passthrough: false,
      enabled: false,
      channels: track.channels,
    })),
    subtitleTracks: media.subtitleTracks.map((track) => ({
      index: track.index,
      codec: track.codec,
      passthrough: false,
      burnIn: false,
      enabled: false,
    })),
    chapters: true,
    attachments: 0,
  };
}

export function predictSize(
  media: MediaInfo,
  settings: OutputSettings,
  sampleAnalyses: SampleAnalysis[] = [],
  calibrationRecords: CalibrationRecord[] = [],
): PredictionResult {
  if (settings.mode === 'constant-quality') {
    return buildConstantQualityEstimate(media, settings, sampleAnalyses, calibrationRecords);
  }
  return buildAverageBitratePrediction(media, settings);
}
