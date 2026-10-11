import type {
  AudioCodec,
  ContainerType,
  LiveHandBrakeJob,
  MediaInfo,
  OutputSettings,
  SubtitleCodec,
  VideoCodec,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function get(source: unknown, ...names: string[]): unknown {
  const object = record(source);
  if (!object) return undefined;
  const desired = new Set(names.map((name) => name.toLowerCase()));
  const key = Object.keys(object).find((candidate) => desired.has(candidate.toLowerCase()));
  return key === undefined ? undefined : object[key];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function positive(value: unknown): number | undefined {
  const result = numeric(value);
  return result !== undefined && result > 0 ? result : undefined;
}

function truth(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function durationSeconds(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = raw.match(/(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const result = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function videoCodec(value: unknown): VideoCodec {
  const codec = String(value ?? '').toLowerCase();
  if (codec.includes('x264') || codec.includes('h264')) return 'x264';
  if (codec.includes('x265') || codec.includes('hevc') || codec.includes('h265')) return 'x265';
  if (codec.includes('av1') || codec.includes('svt_av1')) return 'av1';
  if (codec.includes('vp9')) return 'vp9';
  if (codec.includes('mpeg4')) return 'mpeg4';
  if (codec.includes('mpeg2')) return 'mpeg2';
  return 'unknown';
}

function audioCodec(value: unknown): AudioCodec {
  const codec = String(value ?? '').toLowerCase();
  if (codec.includes('copy')) return 'copy';
  if (codec.includes('eac3') || codec.includes('e-ac-3')) return 'eac3';
  if (codec.includes('ac3') || codec.includes('ac-3')) return 'ac3';
  if (codec.includes('aac')) return 'aac';
  if (codec.includes('mp3')) return 'mp3';
  if (codec.includes('opus')) return 'opus';
  if (codec.includes('flac')) return 'flac';
  return 'unknown';
}

function container(value: unknown, destination: string | undefined): ContainerType {
  const raw = String(value ?? '').toLowerCase();
  const extension = destination?.split('.').pop()?.toLowerCase() ?? '';
  if (raw.includes('mp4') || extension === 'mp4') return 'mp4';
  if (raw.includes('mkv') || extension === 'mkv') return 'mkv';
  if (raw.includes('mov') || extension === 'mov') return 'mov';
  if (raw.includes('m4v') || extension === 'm4v') return 'm4v';
  if (raw.includes('webm') || extension === 'webm') return 'unknown';
  if (extension === 'avi') return 'avi';
  return 'unknown';
}

function subtitleCodec(value: unknown): SubtitleCodec {
  const codec = String(value ?? '').toLowerCase();
  if (/pgs|vobsub|dvd.?sub|bitmap/.test(codec)) return 'bitmap';
  if (/srt|subrip/.test(codec)) return 'subrip';
  if (/ass|ssa/.test(codec)) return 'ass';
  if (codec) return 'text';
  return 'unknown';
}

function queueStatus(value: unknown): string {
  if (typeof value === 'number') {
    return ['Waiting', 'In Progress', 'Completed', 'Error', 'Paused', 'Cancelled'][value] ?? `Unknown (${value})`;
  }
  return text(value) ?? 'Unknown';
}

function readSourceTitle(item: unknown): unknown {
  return get(item, 'SourceTitleInfo');
}

export function parseHandBrakeQueue(
  raw: string,
  processId: number,
  synchronizedAt: string,
  partialSizes: Map<string, number>,
): LiveHandBrakeJob[] {
  const queue: unknown = JSON.parse(raw);
  if (!Array.isArray(queue)) throw new Error('HandBrake queue JSON root was not an array.');

  return queue.flatMap((entry): LiveHandBrakeJob[] => {
    const task = get(entry, 'Task');
    const job = get(task, 'Job') ?? task;
    if (!record(job)) return [];
    const source = get(job, 'Source');
    const destinationObject = get(job, 'Destination');
    const destination = text(get(job, 'Destination')) ?? text(get(destinationObject, 'File'));
    const sourceTitle = readSourceTitle(entry);
    const sourcePath = text(get(source, 'Path')) ?? text(get(entry, 'ScannedSourcePath')) ?? text(get(sourceTitle, 'SourcePath'));
    const titleNumber = numeric(get(source, 'Title')) ?? numeric(get(job, 'Title')) ?? numeric(get(sourceTitle, 'TitleNumber'));
    const resolution = get(sourceTitle, 'Resolution');
    const width = positive(get(resolution, 'Width')) ?? positive(get(sourceTitle, 'Width'));
    const height = positive(get(resolution, 'Height')) ?? positive(get(sourceTitle, 'Height'));
    const frameRate = positive(get(sourceTitle, 'Fps'));
    const duration = durationSeconds(get(sourceTitle, 'Duration'));
    const sourceAudioValue = get(sourceTitle, 'AudioTracks');
    const sourceSubtitleValue = get(sourceTitle, 'Subtitles');
    const sourceAudioTracks = list(sourceAudioValue).map((track, index) => {
      const channelsText = text(get(track, 'ChannelLayout'));
      const channelCount = channelsText?.match(/(\d+(?:\.\d+)?)/)?.[1];
      return {
        index: numeric(get(track, 'TrackNumber')) ?? index,
        codec: audioCodec(get(track, 'Description')),
        language: text(get(track, 'Language')),
        channels: channelCount ? Number(channelCount) : undefined,
        bitrateKbps: positive(get(track, 'Bitrate')),
        isPassthrough: false,
        isEnabled: false,
      };
    });
    const sourceSubtitleTracks = list(sourceSubtitleValue).map((track, index) => {
      const type = String(get(track, 'TypeString', 'SubtitleType') ?? '');
      const codec = subtitleCodec(type);
      return {
        index: numeric(get(track, 'TrackNumber')) ?? index,
        codec,
        language: text(get(track, 'Language')),
        isPassthrough: false,
        isBitmap: codec === 'bitmap',
        isEnabled: false,
      };
    });
    const video = get(job, 'Video') ?? job;
    const encoder = get(video, 'Encoder', 'VideoEncoder');
    const bitrate = positive(get(video, 'Bitrate', 'VideoBitrate'));
    const quality = positive(get(video, 'Quality'));
    const rateTypeValue = get(video, 'VideoEncodeRateType');
    const rateType = String(rateTypeValue ?? '').toLowerCase();
    const qualityMode = rateType === '2' || rateType.includes('quality') || rateType.includes('constant');
    const averageBitrateMode = rateType === '1' || rateType.includes('average') || rateType.includes('bitrate');
    const preset = text(get(entry, 'SelectedPresetKey'));
    const encoderPreset = text(get(video, 'Preset', 'VideoPreset'));
    const mux = get(destinationObject, 'Mux') ?? get(job, 'OutputFormat');
    const outputAudioValue = get(job, 'AudioTracks', 'AudioList') ?? get(get(job, 'Audio'), 'AudioList');
    const settingsAudio = list(outputAudioValue).map((outputTrack, index) => {
      const trackIndex = numeric(get(outputTrack, 'Track')) ?? index;
      const sourceTrack = sourceAudioTracks.find((track) => track.index === trackIndex);
      const outputEncoder = get(outputTrack, 'Encoder');
      const isPassthrough = String(outputEncoder ?? '').toLowerCase().includes('copy');
      const outputRate = positive(get(outputTrack, 'Bitrate'));
      const sourceRate = positive(get(sourceTrack, 'Bitrate'));
      return {
        index: trackIndex,
        codec: audioCodec(outputEncoder ?? get(sourceTrack, 'Description')),
        bitrateKbps: isPassthrough ? sourceRate : outputRate,
        passthrough: isPassthrough,
        enabled: true,
      };
    });
    const outputSubtitleValue = get(job, 'SubtitleTracks', 'SubtitleList') ?? get(get(job, 'Subtitle'), 'SubtitleList');
    const outputSubtitles = list(outputSubtitleValue);
    const sourceSubtitles = list(get(sourceTitle, 'Subtitles'));
    const settingsSubtitles = outputSubtitles.map((outputTrack, index) => {
      const trackIndex = numeric(get(outputTrack, 'Track')) ?? index;
      const sourceTrack = sourceSubtitles.find((track) => numeric(get(track, 'TrackNumber')) === trackIndex);
      const sourceSubtitleCodec = get(sourceTrack, 'TypeString', 'SubtitleType');
      const burnIn = truth(get(outputTrack, 'Burn'));
      return {
        index: trackIndex,
        codec: subtitleCodec(sourceSubtitleCodec),
        passthrough: false,
        burnIn,
        enabled: true,
      };
    });
    const settings: Partial<OutputSettings> = {
      ...(qualityMode ? { mode: 'constant-quality' as const } : averageBitrateMode ? { mode: 'average-bitrate' as const } : {}),
      container: container(mux, destination),
      videoCodec: videoCodec(encoder),
      ...(qualityMode
        ? { videoBitrateKbps: undefined, qualityRf: quality }
        : averageBitrateMode ? { videoBitrateKbps: bitrate, qualityRf: undefined } : {}),
      ...(booleanValue(get(video, 'MultiPass')) !== undefined ? { twoPass: booleanValue(get(video, 'MultiPass')) } : {}),
      encoderPreset,
      filterSettings: JSON.stringify(get(job, 'VideoFilters') ?? get(get(job, 'Filters'), 'FilterList') ?? []),
      ...(Array.isArray(outputAudioValue) ? { audioTracks: settingsAudio } : {}),
      ...(Array.isArray(outputSubtitleValue) ? { subtitleTracks: settingsSubtitles } : {}),
    };
    const filters = get(job, 'VideoFilters') ?? get(get(job, 'Filters'), 'FilterList');
    const outputFileSize = destination ? partialSizes.get(destination.toLowerCase()) : undefined;
    const taskStatus = queueStatus(get(entry, 'Status'));
    const unavailableFields: string[] = [];
    if (!sourcePath) unavailableFields.push('Source path');
    if (duration === undefined) unavailableFields.push('Source duration');
    if (!width || !height) unavailableFields.push('Source resolution');
    if (!encoder || videoCodec(encoder) === 'unknown') unavailableFields.push('Output video encoder');
    if (qualityMode ? quality === undefined : bitrate === undefined) unavailableFields.push('Video quality/bitrate');
    if (!qualityMode && !averageBitrateMode) unavailableFields.push('Rate-control mode (unsupported or missing)');
    if (!preset && !encoderPreset) unavailableFields.push('Preset');
    if (!destination) unavailableFields.push('Destination');
    if (filters === undefined) unavailableFields.push('Filters');
    if (frameRate === undefined) unavailableFields.push('Source frame rate');
    if (!Array.isArray(sourceAudioValue)) unavailableFields.push('Source audio tracks');
    if (!Array.isArray(sourceSubtitleValue)) unavailableFields.push('Source subtitles');
    if (!Array.isArray(outputAudioValue)) unavailableFields.push('Audio output settings');
    if (!Array.isArray(outputSubtitleValue)) unavailableFields.push('Subtitle output settings');

    return [{
      taskId: text(get(entry, 'TaskId')),
      processId,
      status: taskStatus,
      sourcePath,
      titleNumber,
      sourceDurationSeconds: duration,
      width,
      height,
      frameRate,
      sourceAudioTracks,
      sourceSubtitleTracks,
      sourceAudioTracksKnown: Array.isArray(sourceAudioValue),
      sourceSubtitleTracksKnown: Array.isArray(sourceSubtitleValue),
      preset,
      destination,
      partialOutputBytes: outputFileSize,
      settings,
      unavailableFields,
    }];
  });
}

export function queueJobToMedia(job: LiveHandBrakeJob): MediaInfo | undefined {
  if (!job.sourcePath) return undefined;
  return {
    filePath: job.sourcePath,
    durationSeconds: job.sourceDurationSeconds,
    width: job.width,
    height: job.height,
    frameRate: job.frameRate,
    container: 'unknown',
    videoTracks: [],
    audioTracks: job.sourceAudioTracks,
    subtitleTracks: job.sourceSubtitleTracks,
    audioTracksKnown: job.sourceAudioTracksKnown,
    subtitleTracksKnown: job.sourceSubtitleTracksKnown,
  };
}

export function selectedQueueJob(jobs: LiveHandBrakeJob[]): LiveHandBrakeJob | undefined {
  return jobs.find((job) => job.status === 'In Progress')
    ?? jobs.find((job) => job.status === 'Waiting');
}
