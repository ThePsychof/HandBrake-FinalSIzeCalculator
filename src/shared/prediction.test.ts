import { describe, expect, it } from 'vitest';
import { buildAverageBitratePrediction, buildConstantQualityEstimate, createDefaultSettings, predictSize } from './prediction.js';
import { MediaInfo } from './types.js';

describe('Average bitrate predictions', () => {
  it('calculates a standard MP4 output estimate with audio and subtitles', () => {
    const media: MediaInfo = {
      filePath: 'C:/video.mkv',
      durationSeconds: 3600,
      width: 1920,
      height: 1080,
      container: 'mkv',
      videoTracks: [{ index: 0, codec: 'x264', width: 1920, height: 1080, frameRate: 23.976, avgBitrateKbps: 6000 }],
      audioTracks: [
        { index: 0, codec: 'aac', channels: 2, bitrateKbps: 192, isPassthrough: false, isEnabled: true },
        { index: 1, codec: 'ac3', channels: 6, bitrateKbps: 384, isPassthrough: true, isEnabled: true },
      ],
      subtitleTracks: [
        { index: 0, codec: 'subrip', isPassthrough: false, isBitmap: false, isEnabled: true },
      ],
    };

    const settings = createDefaultSettings(media);
    settings.container = 'mp4';
    settings.videoBitrateKbps = 4000;
    settings.audioTracks = [
      { index: 0, codec: 'aac', bitrateKbps: 192, passthrough: false, enabled: true },
      { index: 1, codec: 'ac3', bitrateKbps: 384, passthrough: true, enabled: true },
    ];
    settings.subtitleTracks = [{ index: 0, codec: 'subrip', passthrough: false, burnIn: false, enabled: true }];

    const result = buildAverageBitratePrediction(media, settings);
    expect(result.predictedBytes).toBeGreaterThan(0);
    expect(result.methodology).toContain('Average bitrate');
    expect(result.breakdown.some((item) => item.label === 'Video')).toBe(true);
  });

  it('handles a zero or missing duration gracefully', () => {
    const media: MediaInfo = {
      filePath: 'C:/video.mkv',
      durationSeconds: 0,
      container: 'unknown',
      videoTracks: [{ index: 0, codec: 'x264', width: 1280, height: 720 }],
      audioTracks: [],
      subtitleTracks: [],
    };
    const result = buildAverageBitratePrediction(media, createDefaultSettings(media));
    expect(result.predictedBytes).toBeGreaterThan(0);
  });
});

describe('Constant quality estimates', () => {
  it('uses RF and source metadata to form a rough estimate', () => {
    const media: MediaInfo = {
      filePath: 'C:/video.mkv',
      durationSeconds: 1800,
      width: 1920,
      height: 1080,
      container: 'mkv',
      sourceBitrateKbps: 9000,
      videoTracks: [{ index: 0, codec: 'x264', width: 1920, height: 1080, avgBitrateKbps: 9000 }],
      audioTracks: [],
      subtitleTracks: [],
    };
    const settings = createDefaultSettings(media);
    settings.mode = 'constant-quality';
    settings.qualityRf = 23;
    settings.audioTracks = [];
    settings.subtitleTracks = [];

    const result = buildConstantQualityEstimate(media, settings);
    expect(result.predictedBytes).toBeGreaterThan(0);
    expect(result.uncertaintyText).toMatch(/uncertainty|±|range/i);
  });
});

describe('Prediction dispatch', () => {
  it('chooses the correct mode', () => {
    const media: MediaInfo = {
      filePath: 'C:/video.mp4',
      durationSeconds: 600,
      container: 'mp4',
      videoTracks: [{ index: 0, codec: 'x264', width: 1280, height: 720 }],
      audioTracks: [],
      subtitleTracks: [],
    };
    const avg = predictSize(media, { ...createDefaultSettings(media), mode: 'average-bitrate' });
    const cq = predictSize(media, { ...createDefaultSettings(media), mode: 'constant-quality' });
    expect(avg.mode).toBe('average-bitrate');
    expect(cq.mode).toBe('constant-quality');
  });
});
