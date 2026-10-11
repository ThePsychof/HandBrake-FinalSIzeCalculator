export type ContainerType = 'mp4' | 'mkv' | 'm4v' | 'mov' | 'avi' | 'mpegts' | 'unknown';

export type TrackKind = 'video' | 'audio' | 'subtitle';

export type VideoCodec = 'x264' | 'x265' | 'h264' | 'hevc' | 'av1' | 'vp9' | 'mpeg4' | 'mpeg2' | 'unknown';
export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'mp3' | 'opus' | 'flac' | 'copy' | 'unknown';
export type SubtitleCodec = 'subrip' | 'dvdsub' | 'ass' | 'copy' | 'bitmap' | 'text' | 'unknown';

export interface VideoTrack {
  index?: number;
  codec: VideoCodec;
  width?: number;
  height?: number;
  frameRate?: number;
  frameRateMode?: 'constant' | 'variable' | 'unknown';
  avgBitrateKbps?: number;
  nominalBitrateKbps?: number;
  pixelFormat?: string;
  scanType?: 'progressive' | 'interlaced';
}

export interface AudioTrack {
  index: number;
  streamIndex?: number;
  codec: AudioCodec;
  language?: string;
  channels?: number;
  channelLayout?: string;
  sampleRate?: number;
  durationSeconds?: number;
  bitrateKbps?: number;
  nominalBitrateKbps?: number;
  streamSizeBytes?: number;
  isPassthrough?: boolean;
  isEnabled?: boolean;
}

export interface SubtitleTrack {
  index: number;
  codec: SubtitleCodec;
  language?: string;
  isPassthrough?: boolean;
  isForced?: boolean;
  isBurnedIn?: boolean;
  isBitmap?: boolean;
  textLengthChars?: number;
  isEnabled?: boolean;
}

export interface MediaInfo {
  filePath: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  frameRate?: number;
  frameRateMode?: 'constant' | 'variable' | 'unknown';
  scanType?: 'progressive' | 'interlaced';
  container: ContainerType;
  sourceContainer?: ContainerType;
  sourceBitrateKbps?: number;
  sourceFileSizeBytes?: number;
  videoTracks: VideoTrack[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  chapters?: number;
  metadata?: Record<string, string>;
  handbrakeVersion?: string;
  sourceTitle?: string;
  scanError?: string;
  audioTracksKnown?: boolean;
  subtitleTracksKnown?: boolean;
}

export interface OutputSettings {
  mode: 'average-bitrate' | 'constant-quality';
  container: ContainerType;
  videoCodec: VideoCodec;
  videoEncoderName?: string;
  videoBitrateKbps?: number;
  twoPass?: boolean;
  qualityRf?: number;
  encoderPreset?: string;
  encoderTune?: string;
  encoderProfile?: string;
  encoderLevel?: string;
  encoderOptions?: string;
  outputWidth?: number;
  outputHeight?: number;
  frameRateMode?: string;
  frameRate?: number;
  audioTracks: Array<{
    index: number;
    sourceStreamIndex?: number;
    sourceTrackMatch?: boolean;
    codec: AudioCodec;
    bitrateKbps?: number;
    quality?: number;
    passthrough: boolean;
    enabled: boolean;
    channels?: number;
    mixdown?: string;
    sampleRate?: string;
    gainDb?: number;
    drc?: number;
    encoderOptions?: string;
  }>;
  subtitleTracks: Array<{
    index: number;
    codec: SubtitleCodec;
    passthrough: boolean;
    burnIn: boolean;
    enabled: boolean;
    forcedOnly?: boolean;
    default?: boolean;
    trackName?: string;
  }>;
  chapters?: boolean;
  attachments?: number;
  muxingOverheadPercent?: number;
  filterSettings?: string;
  metadataPassthrough?: boolean;
  webOptimized?: boolean;
  alignAvStart?: boolean;
  iPod5GSupport?: boolean;
}

export interface PredictionBreakdownItem {
  label: string;
  bytes: number;
  percent: number;
}

export interface PredictionResult {
  mode: 'average-bitrate' | 'constant-quality';
  predictedBytes: number | null;
  lowerBoundBytes: number | null;
  upperBoundBytes: number | null;
  streamPayloadBytes: number | null;
  predictedGiB: number;
  predictedGB: number;
  breakdown: PredictionBreakdownItem[];
  methodology: string;
  assumptions: string[];
  uncertaintyText: string;
  calibrationFactor?: number;
  calibrationSamples: number;
  estimateStatus: 'estimate' | 'insufficient-inputs' | 'experimental' | 'sample-based' | 'calibrated';
  missingContributions?: string[];
  isPartial?: boolean;
}

export interface CalibrationRecord {
  id: string;
  createdAt: string;
  sourceDurationSeconds: number;
  handbrakeVersion?: string;
  encoder: string;
  preset?: string;
  bitrateKbps?: number;
  qualityRf?: number;
  container: string;
  predictedBytes: number;
  actualBytes: number;
  method: 'average-bitrate' | 'constant-quality';
  sourcePath?: string;
  videoCodec?: VideoCodec;
  encoderVersion?: string;
  width?: number;
  height?: number;
  filters?: string;
  audioSignature?: string;
  subtitleSignature?: string;
}

export interface SampleAnalysis {
  sampleStartSeconds: number;
  sampleDurationSeconds: number;
  videoPayloadBytes: number;
}

export interface LiveHandBrakeJob {
  taskId?: string;
  processId: number;
  status: string;
  sourcePath?: string;
  titleNumber?: number;
  sourceDurationSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  sourceAudioTracks: AudioTrack[];
  sourceSubtitleTracks: SubtitleTrack[];
  sourceAudioTracksKnown?: boolean;
  sourceSubtitleTracksKnown?: boolean;
  retrievedFields?: string[];
  audioSummary?: string[];
  subtitleSummary?: string[];
  preset?: string;
  destination?: string;
  partialOutputBytes?: number;
  settings: Partial<OutputSettings>;
  unavailableFields: string[];
}

export interface LiveHandBrakeSnapshot {
  available: boolean;
  guiRunning: boolean;
  processId?: number;
  windowTitle?: string;
  synchronizedAt: string;
  sourcePath?: string;
  sourceDisplayName?: string;
  titleNumber?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  audioTrackCount?: number;
  subtitleTrackCount?: number;
  preset?: string;
  destination?: string;
  guiStatus?: string;
  jobs: LiveHandBrakeJob[];
  currentConfiguration?: LiveHandBrakeJob;
  unavailableFields: string[];
  message: string;
}
