import type { AudioCodec, ContainerType, MediaInfo, SubtitleCodec, VideoCodec } from './types.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function ratio(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d+)\/(\d+)$/);
  const result = match ? Number(match[1]) / Number(match[2]) : Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function codecName(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function mapContainer(value: string): ContainerType {
  const formats = value.toLowerCase().split(',');
  if (formats.includes('matroska') || formats.includes('webm')) return 'mkv';
  if (formats.includes('mov') || formats.includes('mp4') || formats.includes('m4a')) return 'mp4';
  if (formats.includes('mpegts')) return 'mpegts';
  if (formats.includes('avi')) return 'avi';
  return 'unknown';
}

function videoCodec(value: string): VideoCodec {
  if (value === 'h264') return 'h264';
  if (value === 'hevc' || value === 'h265') return 'hevc';
  if (value === 'av1') return 'av1';
  if (value === 'vp9') return 'vp9';
  if (value === 'mpeg4') return 'mpeg4';
  if (value === 'mpeg2video') return 'mpeg2';
  return 'unknown';
}

function audioCodec(value: string): AudioCodec {
  if (value === 'aac') return 'aac';
  if (value === 'ac3') return 'ac3';
  if (value === 'eac3') return 'eac3';
  if (value === 'mp3') return 'mp3';
  if (value === 'opus') return 'opus';
  if (value === 'flac') return 'flac';
  return 'unknown';
}

function subtitleCodec(value: string): SubtitleCodec {
  if (/pgs|dvd_subtitle|dvb_subtitle/.test(value)) return 'bitmap';
  if (/subrip|text/.test(value)) return 'text';
  if (/ass|ssa/.test(value)) return 'ass';
  return 'unknown';
}

function tags(stream: JsonRecord): JsonRecord {
  return record(stream.tags) ?? {};
}

function tagValue(values: JsonRecord, name: string): string | undefined {
  const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === name.toLowerCase()
    || candidate.toLowerCase().startsWith(`${name.toLowerCase()}-`));
  const value = key ? values[key] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function durationFromTag(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const clock = value.match(/(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!clock) return number(value);
  return Number(clock[1] ?? 0) * 86400 + Number(clock[2]) * 3600 + Number(clock[3]) * 60 + Number(clock[4]);
}

function streamBitrate(stream: JsonRecord, streamTags: JsonRecord): number | undefined {
  const bitsPerSecond = number(stream.bit_rate) ?? number(tagValue(streamTags, 'BPS'));
  return bitsPerSecond !== undefined && bitsPerSecond > 0 ? bitsPerSecond / 1000 : undefined;
}

export function parseFfprobeOutput(raw: string, filePath: string, fileSizeBytes?: number): Partial<MediaInfo> {
  const parsed: unknown = JSON.parse(raw);
  const root = record(parsed);
  if (!root) throw new Error('ffprobe returned malformed JSON.');
  const format = record(root.format) ?? {};
  const streams = Array.isArray(root.streams) ? root.streams.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
  const container = mapContainer(typeof format.format_name === 'string' ? format.format_name : '');
  const formatDuration = number(format.duration);
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle');
  const video = videoStreams[0];
  const videoTags = video ? tags(video) : {};
  const avgFrameRate = ratio(video?.avg_frame_rate);
  const realFrameRate = ratio(video?.r_frame_rate);
  const frameRateMode = avgFrameRate !== undefined && realFrameRate !== undefined
    ? Math.abs(avgFrameRate - realFrameRate) > Math.max(0.01, avgFrameRate * 0.001) ? 'variable' : 'constant'
    : 'unknown';
  const sourceDurationSeconds = formatDuration
    ?? (video ? number(video.duration) ?? durationFromTag(tagValue(videoTags, 'DURATION')) : undefined);
  const audioTracks = audioStreams.map((stream, ordinal) => {
    const streamTags = tags(stream);
    const streamDuration = number(stream.duration) ?? durationFromTag(tagValue(streamTags, 'DURATION'));
    const bytes = number(stream.tags ? tagValue(streamTags, 'NUMBER_OF_BYTES') : undefined);
    return {
      index: ordinal,
      streamIndex: number(stream.index),
      codec: audioCodec(codecName(stream.codec_name)),
      language: tagValue(streamTags, 'language'),
      channels: number(stream.channels),
      channelLayout: typeof stream.channel_layout === 'string' ? stream.channel_layout : undefined,
      sampleRate: number(stream.sample_rate),
      durationSeconds: streamDuration,
      bitrateKbps: streamBitrate(stream, streamTags),
      streamSizeBytes: bytes,
    };
  });
  const subtitleTracks = subtitleStreams.map((stream, ordinal) => {
    const streamTags = tags(stream);
    const codec = subtitleCodec(codecName(stream.codec_name));
    return {
      index: ordinal,
      codec,
      language: tagValue(streamTags, 'language'),
      isBitmap: codec === 'bitmap',
    };
  });

  return {
    filePath,
    durationSeconds: sourceDurationSeconds,
    width: number(video?.width),
    height: number(video?.height),
    frameRate: avgFrameRate ?? realFrameRate,
    frameRateMode,
    container,
    sourceContainer: container,
    sourceFileSizeBytes: fileSizeBytes ?? number(format.size),
    sourceBitrateKbps: streamBitrate(format, {}),
    videoTracks: video ? [{
      index: number(video.index),
      codec: videoCodec(codecName(video.codec_name)),
      width: number(video.width),
      height: number(video.height),
      frameRate: avgFrameRate ?? realFrameRate,
      frameRateMode,
      avgBitrateKbps: streamBitrate(video, videoTags),
    }] : [],
    audioTracks,
    subtitleTracks,
    audioTracksKnown: true,
    subtitleTracksKnown: true,
  };
}
