import { MediaInfo, VideoCodec } from './types.js';

export function getDefaultHandbrakeCandidates(): string[] {
  const configuredPath = process.env.HANDBRAKE_CLI?.trim();
  const platformCandidates = process.platform === 'win32'
    ? ['C:\\Program Files\\HandBrake\\HandBrakeCLI.exe', 'C:\\Program Files (x86)\\HandBrake\\HandBrakeCLI.exe']
    : process.platform === 'darwin'
      ? ['/Applications/HandBrake.app/Contents/MacOS/HandBrakeCLI', '/opt/homebrew/bin/HandBrakeCLI', '/usr/local/bin/HandBrakeCLI']
      : ['/usr/bin/HandBrakeCLI', '/usr/local/bin/HandBrakeCLI'];
  return [...new Set([...(configuredPath ? [configuredPath] : []), ...platformCandidates, 'HandBrakeCLI'])];
}

function parseDuration(value: string): number | undefined {
  const clock = value.match(/(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const units = value.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (!clock && !units) return undefined;
  const duration = clock
    ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    : Number(units?.[1] ?? 0) * 3600 + Number(units?.[2] ?? 0) * 60 + Number(units?.[3] ?? 0);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function parseCodecName(value: string): VideoCodec {
  const codec = value.toLowerCase();
  if (codec.includes('x264')) return 'x264';
  if (codec.includes('x265')) return 'x265';
  if (codec.includes('h.264') || codec.includes('avc')) return 'h264';
  if (codec.includes('h.265') || codec.includes('hevc')) return 'hevc';
  if (codec.includes('av1')) return 'av1';
  if (codec.includes('vp9')) return 'vp9';
  if (codec.includes('mpeg-2') || codec.includes('mpeg2')) return 'mpeg2';
  if (codec.includes('mpeg-4') || codec.includes('mpeg4')) return 'mpeg4';
  return 'unknown';
}

function parseAudioCodec(value: string): MediaInfo['audioTracks'][number]['codec'] {
  const codec = value.toLowerCase();
  if (codec.includes('e-ac-3') || codec.includes('eac3')) return 'eac3';
  if (codec.includes('ac-3') || codec.includes('ac3')) return 'ac3';
  if (codec.includes('aac')) return 'aac';
  if (codec.includes('mp3') || codec.includes('mpeg audio')) return 'mp3';
  if (codec.includes('opus')) return 'opus';
  if (codec.includes('flac')) return 'flac';
  if (codec.includes('dts') || codec.includes('truehd') || codec.includes('pcm')) return 'unknown';
  return 'unknown';
}

export function parseHandBrakeScan(scanOutput: string): Partial<MediaInfo> {
  const output = scanOutput || '';
  const media: Partial<MediaInfo> = {
    videoTracks: [],
    audioTracks: [],
    subtitleTracks: [],
    container: 'unknown',
    audioTracksKnown: false,
    subtitleTracksKnown: false,
  };
  const durationMatch = output.match(/^\s*\+\s*duration:\s*([^\r\n]+)/im);
  if (durationMatch) media.durationSeconds = parseDuration(durationMatch[1]);

  const sizeMatch = output.match(/^\s*\+\s*size:\s*(\d{3,5})x(\d{3,5})/im);
  if (sizeMatch) {
    media.width = Number(sizeMatch[1]);
    media.height = Number(sizeMatch[2]);
  }

  const frameRateMatch = output.match(/(?:^|[, ]+)(\d+(?:\.\d+)?)\s*fps\b/i);
  if (frameRateMatch) {
    const frameRate = Number(frameRateMatch[1]);
    if (Number.isFinite(frameRate) && frameRate > 0) media.frameRate = frameRate;
  }

  const titleMatch = output.match(/^\s*\+\s*title\s+\d+\s*:\s*([^\r\n]+)/im);
  if (titleMatch) media.sourceTitle = titleMatch[1].trim();

  const videoLineIndex = linesForVideoTrack(output);
  if (videoLineIndex) {
    media.videoTracks = [{
      codec: parseCodecName(videoLineIndex.codec),
      width: media.width,
      height: media.height,
      frameRate: videoLineIndex.frameRate ?? media.frameRate,
      avgBitrateKbps: videoLineIndex.bitrateKbps,
    }];
  }

  const lines = output.split(/\r?\n/);
  let section: 'audio' | 'subtitle' | undefined;
  for (const line of lines) {
    if (/^\s*\+\s*audio tracks:\s*$/i.test(line)) {
      section = 'audio';
      media.audioTracksKnown = true;
      continue;
    }
    if (/^\s*\+\s*subtitle tracks:\s*$/i.test(line)) {
      section = 'subtitle';
      media.subtitleTracksKnown = true;
      continue;
    }
    if (/^\s*\+\s*(?:video track|chapters|metadata|duration|size):/i.test(line)) {
      section = undefined;
    }
    const trackMatch = line.match(/^\s*\+\s*(\d+),\s*([^(\r\n]+?)\s*\(([^)\r\n]+)\)/);
    if (!trackMatch || !section) continue;

    const index = Number(trackMatch[1]);
    const language = trackMatch[2].trim();
    const details = trackMatch[3];

    if (section === 'audio') {
      const channelMatch = details.match(/(\d+(?:\.\d+)?)\s*ch/i);
      const sampleRateMatch = details.match(/(\d+)\s*Hz/i);
      const bitrateMatch = details.match(/(\d+(?:\.\d+)?)\s*(?:kbit\/s|kbps)/i);
      const sampleRate = sampleRateMatch ? Number(sampleRateMatch[1]) : undefined;
      const bitrate = bitrateMatch ? Number(bitrateMatch[1]) : undefined;
      media.audioTracks?.push({
        index: Math.max(0, index - 1),
        language,
        codec: parseAudioCodec(details),
        channels: channelMatch ? Number(channelMatch[1]) : undefined,
        sampleRate: sampleRate && Number.isFinite(sampleRate) ? sampleRate : undefined,
        bitrateKbps: bitrate && Number.isFinite(bitrate) ? bitrate : undefined,
      });
    } else {
      const lower = details.toLowerCase();
      const bitmap = /pgs|vobsub|dvd.?sub|bitmap/.test(lower);
      const text = /srt|subrip|ssa|ass|text/.test(lower);
      const codec = bitmap ? 'bitmap' : text ? 'text' : 'unknown';
      media.subtitleTracks?.push({
        index: Math.max(0, index - 1),
        language,
        codec,
        isBitmap: bitmap ? true : text ? false : undefined,
      });
    }
  }

  return media;
}

export function normalizeCodecName(codec: string): VideoCodec {
  return parseCodecName(codec);
}

function linesForVideoTrack(output: string): { codec: string; frameRate?: number; bitrateKbps?: number } | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\+\s*video track:\s*$/i.test(line));
  if (start < 0) return undefined;

  const end = lines.findIndex((line, index) =>
    index > start && /^\s*\+\s*(?:audio tracks|subtitle tracks|chapters|metadata|duration|size):/i.test(line),
  );
  const block = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  const codecMatch = block.match(/^\s*\+\s*(?:decoder|codec):\s*([^\r\n]+)/im);
  const bitrateMatch = block.match(/^\s*\+\s*bitrate:\s*(\d+(?:\.\d+)?)\s*(?:kbit\/s|kbps)/im);
  const frameRateMatch = block.match(/^\s*\+\s*frame rate:\s*(\d+(?:\.\d+)?)\s*fps/im);
  const bitrate = bitrateMatch ? Number(bitrateMatch[1]) : undefined;
  const frameRate = frameRateMatch ? Number(frameRateMatch[1]) : undefined;
  return {
    codec: codecMatch?.[1] ?? '',
    bitrateKbps: bitrate && Number.isFinite(bitrate) ? bitrate : undefined,
    frameRate: frameRate && Number.isFinite(frameRate) ? frameRate : undefined,
  };
}
