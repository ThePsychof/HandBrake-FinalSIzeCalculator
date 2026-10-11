import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { app } from 'electron';
import { parseHandBrakeQueue } from '../shared/live-handbrake.js';
import type { ContainerType, LiveHandBrakeJob, LiveHandBrakeSnapshot, MediaInfo, OutputSettings } from '../shared/types.js';

interface UiElement {
  id?: string;
  name?: string;
  value?: string;
  selected?: string;
  toggle?: string;
  range?: number;
  isSelected?: boolean;
  type?: string;
}

function tabControls(window: UiWindow, tab: string): UiElement[] {
  const value = window.tabs?.[tab];
  return Array.isArray(value) ? value : [];
}

function controlValue(controls: UiElement[], matcher: RegExp, types?: string[]): string | undefined {
  const item = controls.find((control) =>
    matcher.test(`${control.id ?? ''} ${control.name ?? ''}`)
    && (!types || types.includes(control.type ?? ''))
    && (control.value !== undefined || control.selected !== undefined || control.name !== undefined));
  return item?.selected?.trim() || item?.value?.trim() || undefined;
}

function controlByName(controls: UiElement[], matcher: RegExp): UiElement | undefined {
  return controls.find((control) => matcher.test(`${control.id ?? ''} ${control.name ?? ''}`));
}

function selectedRadio(controls: UiElement[], matcher: RegExp): boolean {
  return controls.some((control) => control.type === 'ControlType.RadioButton'
    && matcher.test(control.name ?? '')
    && control.isSelected === true);
}

function toggled(control: UiElement | undefined): boolean | undefined {
  if (control?.toggle === 'On') return true;
  if (control?.toggle === 'Off') return false;
  return undefined;
}

function numericValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

function mappedVideoCodec(value: string | undefined): OutputSettings['videoCodec'] | undefined {
  const normalized = value?.toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (normalized.includes('x264')) return 'x264';
  if (normalized.includes('h.264') || normalized.includes('h264')) return 'h264';
  if (normalized.includes('x265')) return 'x265';
  if (normalized.includes('h.265') || normalized.includes('h265') || normalized.includes('hevc')) return 'hevc';
  if (normalized.includes('av1')) return 'av1';
  if (normalized.includes('vp9')) return 'vp9';
  if (normalized.includes('mpeg-4') || normalized.includes('mpeg4')) return 'mpeg4';
  if (normalized.includes('mpeg-2') || normalized.includes('mpeg2')) return 'mpeg2';
  return 'unknown';
}

function mappedAudioCodec(value: string | undefined): OutputSettings['audioTracks'][number]['codec'] | undefined {
  const normalized = value?.toLowerCase() ?? '';
  if (!normalized) return undefined;
  if (normalized.includes('e-ac-3') || normalized.includes('eac3')) return 'eac3';
  if (normalized.includes('ac-3') || normalized.includes('ac3')) return 'ac3';
  if (normalized.includes('aac')) return 'aac';
  if (normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('passthru')) return 'copy';
  return 'unknown';
}

function mappedSubtitleCodec(value: string | undefined): OutputSettings['subtitleTracks'][number]['codec'] {
  const normalized = value?.toLowerCase() ?? '';
  if (/pgs|vobsub|dvd.?sub|bitmap/.test(normalized)) return 'bitmap';
  if (/srt|subrip|utf-8/.test(normalized)) return 'subrip';
  if (/ass|ssa/.test(normalized)) return 'ass';
  return 'unknown';
}

function mapContainer(value: string | undefined, destination?: string): ContainerType {
  const format = value?.toLowerCase() ?? '';
  const extension = destination?.split('.').pop()?.toLowerCase() ?? '';
  if (format.includes('mkv') || extension === 'mkv') return 'mkv';
  if (format.includes('m4v') || extension === 'm4v') return 'm4v';
  if (format.includes('mov') || extension === 'mov') return 'mov';
  if (format.includes('mp4') || extension === 'mp4') return 'mp4';
  if (extension === 'avi') return 'avi';
  if (format.includes('mpegts') || extension === 'ts') return 'mpegts';
  return 'unknown';
}

function summaryTrackLines(controls: UiElement[]): { audio: string[]; subtitles: string[] } {
  const text = controls.filter((control) => control.type === 'ControlType.Text')
    .map((control) => control.name?.trim() ?? '')
    .filter(Boolean);
  const start = text.findIndex((value) => value === 'Tracks:');
  const end = text.findIndex((value, index) => index > start && value === 'Chapter Markers');
  if (start < 0) return { audio: [], subtitles: [] };
  const entries = text.slice(start + 1, end < 0 ? undefined : end);
  return {
    audio: entries.filter((value) => /passthru|aac|ac-?3|e-?ac-?3|opus|flac|mp3|kbps/i.test(value)),
    subtitles: entries.filter((value) => /burned|subtitle|srt|subrip|pgs|vobsub|utf-8/i.test(value)),
  };
}

function sourceTracksFromUi(controls: UiElement[], kind: 'Audio' | 'Subtitle'): Array<{
  index: number;
  codec: MediaInfo['audioTracks'][number]['codec'] | MediaInfo['subtitleTracks'][number]['codec'];
  channels?: number;
  language?: string;
}> {
  const dataItems = controls.filter((control) => control.type === 'ControlType.DataItem' || control.type === 'ControlType.ListItem');
  return dataItems.flatMap<{
    index: number;
    codec: MediaInfo['audioTracks'][number]['codec'] | MediaInfo['subtitleTracks'][number]['codec'];
    channels?: number;
    language?: string;
  }>((control) => {
    const label = control.name ?? '';
    const match = label.match(new RegExp(`${kind} Track:\\s*Title\\s+(\\d+)\\s+(.+?)(?:\\s+\\((.*)\\))?$`, 'i'));
    if (!match) return [];
    const details = match[3] ?? '';
    if (kind === 'Audio') {
      const channelsText = details.match(/(\d+)(?:\.(\d+))?\s*ch/i);
      const codecText = details.split(',')[0] ?? '';
      return [{
        index: Math.max(0, Number(match[1]) - 1),
        codec: (mappedAudioCodec(codecText) ?? 'unknown') as MediaInfo['audioTracks'][number]['codec'],
        channels: channelsText ? Number(channelsText[1]) + (Number(channelsText[2] ?? 0) > 0 ? 1 : 0) : undefined,
        language: match[2].trim(),
      }];
    }
    const nameParts = match[2].trim();
    return [{
      index: Math.max(0, Number(match[1]) - 1),
      codec: mappedSubtitleCodec(`${nameParts} ${details}`),
      language: nameParts,
    }];
  });
}

function sourceTrackForSummary<T extends { index: number }>(
  summary: string,
  summaries: string[],
  sources: T[],
): T | undefined {
  const explicitNumber = summary.match(/^\s*(?:Track\s*)?(\d+)\b/i);
  if (explicitNumber) {
    const sourceIndex = Number(explicitNumber[1]) - 1;
    return sources.find((source) => source.index === sourceIndex);
  }
  return summaries.length === 1 && sources.length === 1 ? sources[0] : undefined;
}

function buildCurrentConfiguration(
  gui: UiWindow,
  processId: number,
  sourcePath: string | undefined,
  titleNumber: number | undefined,
): { job: LiveHandBrakeJob; summaries: { audio: string[]; subtitles: string[] } } {
  const summaryTab = tabControls(gui, 'Summary');
  const videoTab = tabControls(gui, 'Video');
  const audioTab = tabControls(gui, 'Audio');
  const subtitleTab = tabControls(gui, 'Subtitles');
  const pictureTab = tabControls(gui, 'Dimensions');
  const filtersTab = tabControls(gui, 'Filters');
  const chaptersTab = tabControls(gui, 'Chapters');
  const summaries = summaryTrackLines(summaryTab);
  const hasTrackSummary = summaryTab.some((control) => control.type === 'ControlType.Text' && control.name === 'Tracks:');
  const sourceAudioTracks = sourceTracksFromUi(audioTab, 'Audio') as LiveHandBrakeJob['sourceAudioTracks'];
  const sourceSubtitleTracks = sourceTracksFromUi(subtitleTab, 'Subtitle') as LiveHandBrakeJob['sourceSubtitleTracks'];
  const videoEncoderText = controlValue(videoTab, /Video Encoder:/i, ['ControlType.ComboBox']);
  const codec = mappedVideoCodec(videoEncoderText);
  const bitrate = numericValue(controlValue(videoTab, /Avg Bitrate/i, ['ControlType.Edit']));
  const qualityText = videoTab.find((control) => control.type === 'ControlType.Text'
    && /^\d+(?:\.\d+)?$/.test(control.name ?? ''))?.name;
  const quality = numericValue(qualityText);
  const qualityMode = selectedRadio(videoTab, /Constant Quality/i);
  const bitrateMode = selectedRadio(videoTab, /Avg Bitrate/i);
  const videoMode = qualityMode ? 'constant-quality' : bitrateMode ? 'average-bitrate' : undefined;
  const videoTextControls = videoTab.filter((control) => control.type === 'ControlType.Text').map((control) => control.name ?? '');
  const presetLabelIndex = videoTextControls.findIndex((value) => /Encoder Preset:/i.test(value));
  const encoderPreset = presetLabelIndex >= 0
    ? videoTextControls.slice(presetLabelIndex + 1).find((value) => value && !/^(Encoder|Tune|Profile|Level)/i.test(value))
    : undefined;
  const subtitlesBurned = summaries.subtitles.some((value) => /burned/i.test(value));
  const selectedSubtitleBurn = toggled(controlByName(subtitleTab, /burnInCheckbox|Burn In/i));
  const forcedOnly = toggled(controlByName(subtitleTab, /Forced Only/i));
  const defaultSubtitle = toggled(controlByName(subtitleTab, /^Default$/i));
  const subtitleName = controlByName(subtitleTab, /TrackName/i)?.value;
  const audioOutputs = summaries.audio.flatMap((summary) => {
    const source = sourceTrackForSummary(summary, summaries.audio, sourceAudioTracks);
    if (!source) return [];
    const passthrough = /passthru|pass-through/i.test(summary);
    const codecName = summary.replace(/\bpassthru\b/i, '').replace(/\bpass-through\b/i, '');
    const audioCodec = mappedAudioCodec(codecName) ?? (passthrough ? 'copy' : 'unknown');
    const bitrateKbps = numericValue(summary.match(/(\d+(?:\.\d+)?)\s*kbps/i)?.[1]);
    return [{
      index: source.index,
      codec: audioCodec,
      bitrateKbps,
      passthrough,
      enabled: true,
      channels: source?.channels,
    }];
  });
  const subtitleOutputs = summaries.subtitles.flatMap((summary) => {
    const source = sourceTrackForSummary(summary, summaries.subtitles, sourceSubtitleTracks);
    if (!source) return [];
    const isBurned = /burned/i.test(summary)
      || (summaries.subtitles.length === 1 && selectedSubtitleBurn === true)
      || (summaries.subtitles.length === 1 && subtitlesBurned);
    return [{
      index: source.index,
      codec: source.codec,
      passthrough: false,
      burnIn: isBurned,
      enabled: true,
      ...(summaries.subtitles.length === 1 && forcedOnly !== undefined ? { forcedOnly } : {}),
      ...(summaries.subtitles.length === 1 && defaultSubtitle !== undefined ? { default: defaultSubtitle } : {}),
      ...(summaries.subtitles.length === 1 && subtitleName !== undefined ? { trackName: subtitleName } : {}),
    }];
  });
  const frameRateText = controlValue(videoTab, /Framerate \(FPS\)/i, ['ControlType.ComboBox']);
  const frameRate = numericValue(frameRateText);
  const frameRateMode = selectedRadio(videoTab, /Constant Framerate/i)
    ? 'constant'
    : selectedRadio(videoTab, /Variable Framerate/i) ? 'variable'
      : selectedRadio(videoTab, /Peak Framerate/i) ? 'peak' : undefined;
  const dimensionsLine = pictureTab.find((control) => /Storage Size:\s*\d+x\d+/i.test(control.name ?? ''))?.name;
  const sizeMatch = dimensionsLine?.match(/Storage Size:\s*(\d+)x(\d+)/i);
  const outputWidth = sizeMatch ? Number(sizeMatch[1]) : undefined;
  const outputHeight = sizeMatch ? Number(sizeMatch[2]) : undefined;
  const filterValues = filtersTab
    .filter((control) => control.type === 'ControlType.ComboBox' || control.type === 'ControlType.CheckBox')
    .map((control) => ({
      name: control.name || control.id || 'unnamed',
      value: control.selected ?? control.toggle ?? control.value,
    }))
    .filter((control) => control.value !== undefined);
  const settings: Partial<OutputSettings> = {
    ...(videoEncoderText ? { videoEncoderName: videoEncoderText } : {}),
    ...(videoMode ? { mode: videoMode } : {}),
    ...(codec ? { videoCodec: codec } : {}),
    ...(videoMode === 'average-bitrate' && bitrate !== undefined ? { videoBitrateKbps: bitrate } : {}),
    ...(videoMode === 'constant-quality' && quality !== undefined ? { qualityRf: quality } : {}),
    ...(encoderPreset ? { encoderPreset } : {}),
    ...(controlValue(videoTab, /Encoder Tune:/i, ['ControlType.ComboBox']) !== undefined
      ? { encoderTune: controlValue(videoTab, /Encoder Tune:/i, ['ControlType.ComboBox']) }
      : {}),
    ...(controlValue(videoTab, /Encoder Profile:/i, ['ControlType.ComboBox']) !== undefined
      ? { encoderProfile: controlValue(videoTab, /Encoder Profile:/i, ['ControlType.ComboBox']) }
      : {}),
    ...(controlValue(videoTab, /Encoder Level:/i, ['ControlType.ComboBox']) !== undefined
      ? { encoderLevel: controlValue(videoTab, /Encoder Level:/i, ['ControlType.ComboBox']) }
      : {}),
    ...(controlByName(videoTab, /Advanced Options:/i)?.value !== undefined
      ? { encoderOptions: controlByName(videoTab, /Advanced Options:/i)?.value ?? '' }
      : {}),
    ...(outputWidth !== undefined ? { outputWidth } : {}),
    ...(outputHeight !== undefined ? { outputHeight } : {}),
    ...(frameRateMode ? { frameRateMode } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(toggled(controlByName(videoTab, /Multi-Pass Encoding/i)) !== undefined
      ? { twoPass: toggled(controlByName(videoTab, /Multi-Pass Encoding/i)) }
      : {}),
    ...(hasTrackSummary && audioOutputs.length === summaries.audio.length ? { audioTracks: audioOutputs } : {}),
    ...(hasTrackSummary && subtitleOutputs.length === summaries.subtitles.length ? { subtitleTracks: subtitleOutputs } : {}),
    ...(controlValue(summaryTab, /Container|Format:/i, ['ControlType.ComboBox']) !== undefined
      ? { container: mapContainer(controlValue(summaryTab, /Container|Format:/i, ['ControlType.ComboBox'])) }
      : {}),
    ...(filterValues.length > 0 ? { filterSettings: JSON.stringify(filterValues) } : {}),
    ...(toggled(controlByName(summaryTab, /Metadata/)) !== undefined
      ? { metadataPassthrough: toggled(controlByName(summaryTab, /Metadata/)) }
      : {}),
    ...(toggled(controlByName(summaryTab, /WebOptimized/)) !== undefined
      ? { webOptimized: toggled(controlByName(summaryTab, /WebOptimized/)) }
      : {}),
    ...(toggled(controlByName(summaryTab, /AlignAVStart/)) !== undefined
      ? { alignAvStart: toggled(controlByName(summaryTab, /AlignAVStart/)) }
      : {}),
    ...(toggled(controlByName(summaryTab, /iPod5G/)) !== undefined
      ? { iPod5GSupport: toggled(controlByName(summaryTab, /iPod5G/)) }
      : {}),
    chapters: toggled(controlByName(chaptersTab, /Create chapter markers/i)),
  };
  const unavailableFields: string[] = [];
  const retrievedFields: string[] = [];
  const mark = (field: string, available: boolean) => {
    (available ? retrievedFields : unavailableFields).push(field);
  };
  mark('Full source path', Boolean(sourcePath));
  mark('Selected title', titleNumber !== undefined);
  mark('Title duration', parseUiDuration(gui.durationText) !== undefined);
  mark('Effective encode duration (selected range)', false);
  mark('Source resolution and frame rate', Boolean(gui.sourceSummary));
  mark('Output container', settings.container !== undefined);
  mark('Output destination', Boolean(gui.destination));
  mark('Video encoder', settings.videoCodec !== undefined && settings.videoCodec !== 'unknown');
  mark('Rate-control mode', settings.mode !== undefined);
  if (settings.mode === 'constant-quality') {
    mark('RF / quality', settings.qualityRf !== undefined);
  } else if (settings.mode === 'average-bitrate') {
    mark('Average video bitrate', settings.videoBitrateKbps !== undefined);
  } else {
    mark('Rate-control parameter (RF/bitrate)', false);
  }
  mark('Encoder preset', settings.encoderPreset !== undefined);
  mark('Encoder tune', settings.encoderTune !== undefined);
  mark('Encoder profile and level', settings.encoderProfile !== undefined && settings.encoderLevel !== undefined);
  mark('Advanced encoder options', settings.encoderOptions !== undefined);
  mark('Output dimensions', settings.outputWidth !== undefined && settings.outputHeight !== undefined);
  mark('Frame-rate mode', settings.frameRateMode !== undefined);
  mark('Audio output tracks, codecs, and source-track match', settings.audioTracks !== undefined);
  mark('Audio bitrate/quality, mixdown, sample rate, gain, DRC and per-track advanced options', false);
  mark('Subtitle selected tracks, source-track match, and burn state', settings.subtitleTracks !== undefined);
  mark('Subtitle forced/default/name options', subtitleOutputs.every((track) => track.forcedOnly !== undefined && track.default !== undefined && track.trackName !== undefined));
  mark('Filters', settings.filterSettings !== undefined);
  mark('Chapter markers and output metadata toggles', settings.chapters !== undefined && settings.metadataPassthrough !== undefined);
  const destination = gui.destination;
  if (destination && settings.container === 'unknown') settings.container = mapContainer(undefined, destination);
  const effectiveDuration = parseUiDuration(gui.durationText);
  const job: LiveHandBrakeJob = {
    processId,
    status: 'Current GUI configuration (not queued)',
    sourcePath,
    titleNumber,
    sourceDurationSeconds: effectiveDuration,
    width: parseSummary(gui.sourceSummary).width,
    height: parseSummary(gui.sourceSummary).height,
    frameRate: parseSummary(gui.sourceSummary).frameRate,
    sourceAudioTracks: sourceAudioTracks as LiveHandBrakeJob['sourceAudioTracks'],
    sourceSubtitleTracks: sourceSubtitleTracks as LiveHandBrakeJob['sourceSubtitleTracks'],
    sourceAudioTracksKnown: audioTab.some((control) => control.type === 'ControlType.DataItem'),
    sourceSubtitleTracksKnown: subtitleTab.some((control) => control.type === 'ControlType.ListItem'),
    retrievedFields,
    audioSummary: summaries.audio,
    subtitleSummary: summaries.subtitles,
    preset: gui.preset,
    destination,
    settings: settings as LiveHandBrakeJob['settings'],
    unavailableFields,
  };
  return { job, summaries };
}

function parseUiTitle(value: string | undefined): number | undefined {
  const match = value?.match(/^\s*(\d+)\b/);
  if (!match) return undefined;
  const title = Number(match[1]);
  return Number.isSafeInteger(title) && title > 0 ? title : undefined;
}

interface UiWindow {
  processId: number;
  windowTitle: string;
  elements: UiElement[];
  texts: string[];
  sourceDisplayName?: string;
  sourceSummary?: string;
  durationText?: string;
  titleText?: string;
  preset?: string;
  destination?: string;
  status?: string;
  activeTab?: string;
  tabs?: Record<string, UiElement[]>;
}

const tabCacheByProcess = new Map<number, Record<string, UiElement[]>>();

function isUiWindow(value: unknown): value is UiWindow {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.processId === 'number'
    && typeof candidate.windowTitle === 'string'
    && Array.isArray(candidate.elements)
    && Array.isArray(candidate.texts);
}

const UI_AUTOMATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$reviewedProcessIds = '__REVIEWED_PROCESS_IDS__'.Split(',') | Where-Object { $_ }
$windows = @()
foreach ($process in @(Get-Process -Name HandBrake -ErrorAction SilentlyContinue)) {
  if ($process.MainWindowHandle -eq 0) { continue }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $tabsData = @{}
  $allNodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $tabControl = $allNodes | Where-Object { $_.Current.AutomationId -eq 'tabControl' } | Select-Object -First 1
  $originalTab = $null
  $originalTabName = $null
  if ($tabControl) {
    try {
      $currentSelection = $tabControl.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if ($currentSelection.Count -gt 0) {
        $originalTab = $currentSelection[0]
        $originalTabName = [string]$originalTab.Current.Name
      }
    } catch {}
  }
  $tabItems = @($allNodes | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem })
  $activeTab = if ($originalTab) { [string]$originalTab.Current.Name } else { $null }
  $needsInitialReview = $reviewedProcessIds -notcontains [string]$process.Id
  if ($tabItems.Count -gt 0 -and $needsInitialReview) {
    try {
      foreach ($tab in $tabItems) {
        $tabName = [string]$tab.Current.Name
        try { $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { continue }
        Start-Sleep -Milliseconds 250
        $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $controls = @()
        foreach ($node in $nodes) {
          $current = $node.Current
          if ($current.IsOffscreen) { continue }
          $kind = $current.ControlType.ProgrammaticName
          if ($kind -notmatch 'Text|Edit|ComboBox|CheckBox|RadioButton|Slider|ListItem|DataItem|List|Button') { continue }
          $value = $null
          $selected = $null
          $toggle = $null
          $range = $null
          $isSelected = $null
          try { $value = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
          try {
            $selection = $node.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
            if ($selection.Count -gt 0) { $selected = ($selection | ForEach-Object { $_.Current.Name }) -join ', ' }
          } catch {}
          try { $toggle = $node.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch {}
          try { $range = $node.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value } catch {}
          try { $isSelected = $node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
          $name = [string]$current.Name
          if ($current.AutomationId -or $name -or $value -or $selected -or $toggle -or $null -ne $range -or $null -ne $isSelected) {
            $controls += [pscustomobject]@{
              id = [string]$current.AutomationId
              name = $name
              value = $value
              selected = $selected
              toggle = $toggle
              range = $range
              isSelected = $isSelected
              type = $kind
            }
          }
        }
        $tabsData[$tabName] = @($controls)
      }
    } finally {
      if ($originalTabName) {
        try {
          $restoreNodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
          $restoreTab = $restoreNodes | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem -and $_.Current.Name -eq $originalTabName
          } | Select-Object -First 1
          if ($restoreTab) {
            $restoreTab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
            Start-Sleep -Milliseconds 100
          }
        } catch {}
      }
    }
  } elseif ($originalTab) {
    $tabName = [string]$originalTab.Current.Name
    $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $controls = @()
    foreach ($node in $nodes) {
      $current = $node.Current
      if ($current.IsOffscreen) { continue }
      $kind = $current.ControlType.ProgrammaticName
      if ($kind -notmatch 'Text|Edit|ComboBox|CheckBox|RadioButton|Slider|ListItem|DataItem|List|Button') { continue }
      $value = $null
      $selected = $null
      $toggle = $null
      $range = $null
      $isSelected = $null
      try { $value = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
      try {
        $selection = $node.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
        if ($selection.Count -gt 0) { $selected = ($selection | ForEach-Object { $_.Current.Name }) -join ', ' }
      } catch {}
      try { $toggle = $node.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch {}
      try { $range = $node.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern).Current.Value } catch {}
      try { $isSelected = $node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
      $name = [string]$current.Name
      if ($current.AutomationId -or $name -or $value -or $selected -or $toggle -or $null -ne $range -or $null -ne $isSelected) {
        $controls += [pscustomobject]@{
          id = [string]$current.AutomationId
          name = $name
          value = $value
          selected = $selected
          toggle = $toggle
          range = $range
          isSelected = $isSelected
          type = $kind
        }
      }
    }
    $tabsData[$tabName] = @($controls)
  }
  $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $elements = @()
  $texts = @()
  foreach ($node in $nodes) {
    $current = $node.Current
    $value = $null
    $selected = $null
    try { $value = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    try {
      $selection = $node.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection()
      if ($selection.Count -gt 0) { $selected = $selection[0].Current.Name }
    } catch {}
    $name = [string]$current.Name
    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $name) { $texts += $name }
    if ($current.AutomationId -or $name -or $value -or $selected) {
      $elements += [pscustomobject]@{ id = [string]$current.AutomationId; name = $name; value = $value; selected = $selected; type = $current.ControlType.ProgrammaticName }
    }
  }
  $sourceName = $null
  $sourceSummary = $null
  $durationText = $null
  $titleText = $null
  $preset = $null
  for ($i = 0; $i -lt $texts.Count; $i++) {
    if ($texts[$i] -eq 'Source:' -and $i + 1 -lt $texts.Count) { $sourceName = $texts[$i + 1] }
    if ($texts[$i] -match '^\d{3,5}x\d{3,5}.*FPS') { $sourceSummary = $texts[$i] }
    if ($texts[$i] -match '^Duration:\s*$' -and $i + 1 -lt $texts.Count) { $durationText = $texts[$i + 1] }
    if ($texts[$i] -match '^Title:\s*$' -and $i + 1 -lt $texts.Count) { $titleText = $texts[$i + 1] }
    if ($texts[$i] -match '^Preset:\s*$' -and $i + 1 -lt $texts.Count) { $preset = $texts[$i + 1] }
  }
  $titleControl = $elements | Where-Object { $_.id -eq 'Titles' } | Select-Object -First 1
  if ($titleControl -and $titleControl.selected) { $titleText = $titleControl.selected }
  $destinationControl = $elements | Where-Object { $_.id -eq 'Destination' } | Select-Object -First 1
  $statusControl = $elements | Where-Object { $_.id -eq 'statusBar' } | Select-Object -First 1
  $windows += [pscustomobject]@{
    processId = $process.Id
    windowTitle = $root.Current.Name
    elements = $elements
    texts = $texts
    sourceDisplayName = $sourceName
    sourceSummary = $sourceSummary
    durationText = $durationText
    titleText = $titleText
    preset = $preset
    destination = if ($destinationControl) { $destinationControl.value } else { $null }
    status = if ($statusControl) { $statusControl.name } else { $null }
    activeTab = $activeTab
    tabs = $tabsData
  }
}
ConvertTo-Json -InputObject @($windows) -Depth 5 -Compress
`;


function parseUiDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+):(\d{2}):(\d{2})/);
  if (!match) return undefined;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parseSummary(summary: string | undefined): {
  width?: number;
  height?: number;
  frameRate?: number;
  audioTrackCount?: number;
  subtitleTrackCount?: number;
} {
  if (!summary) return {};
  const size = summary.match(/(\d{3,5})x(\d{3,5})/);
  const fps = summary.match(/(\d+(?:\.\d+)?)\s*FPS/i);
  const audio = summary.match(/(\d+)\s+Audio Tracks/i);
  const subtitles = summary.match(/(\d+)\s+Subtitle Tracks/i);
  return {
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
    frameRate: fps ? Number(fps[1]) : undefined,
    audioTrackCount: audio ? Number(audio[1]) : undefined,
    subtitleTrackCount: subtitles ? Number(subtitles[1]) : undefined,
  };
}

function basenameWithoutExtension(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
}

function sourceNameMatches(candidatePath: string, sourceDisplayName: string): boolean {
  const candidate = basenameWithoutExtension(candidatePath);
  const displayed = basenameWithoutExtension(sourceDisplayName);
  return candidate === displayed || candidate.startsWith(`${displayed}.`);
}

async function readUiWindows(): Promise<UiWindow[]> {
  if (process.platform !== 'win32') return [];
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const reviewedProcessIds = [...tabCacheByProcess.keys()].join(',');
  const script = UI_AUTOMATION_SCRIPT.replace('__REVIEWED_PROCESS_IDS__', reviewedProcessIds);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer; killed?: boolean };
    const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : failure.stderr?.trim();
    if (failure.killed || failure.code === 'ETIMEDOUT') {
      throw new Error('HandBrake UI Automation did not finish within 60 seconds.');
    }
    if (stderr) {
      throw new Error(`HandBrake UI Automation failed: ${stderr.replace(/^#< CLIXML\s*/, '').trim()}`);
    }
    throw new Error(`HandBrake UI Automation failed${failure.code ? ` (${failure.code})` : ''}.`);
  }
  const parsed: unknown = JSON.parse(stdout.trim() || '[]');
  if (!Array.isArray(parsed)) throw new Error('HandBrake UI Automation returned an invalid response.');
  const windows = parsed.filter(isUiWindow);
  const runningIds = new Set(windows.map((window) => window.processId));
  for (const processId of tabCacheByProcess.keys()) {
    if (!runningIds.has(processId)) tabCacheByProcess.delete(processId);
  }
  return windows.map((window) => {
    const cached = tabCacheByProcess.get(window.processId) ?? {};
    const updated = { ...cached, ...(window.tabs ?? {}) };
    tabCacheByProcess.set(window.processId, updated);
    return { ...window, tabs: updated };
  });
}

async function readCurrentScannedPath(processId: number, sourceDisplayName?: string): Promise<{ sourcePath?: string; titleNumber?: number }> {
  if (!sourceDisplayName) return {};
  const logPath = path.join(app.getPath('appData'), 'HandBrake', 'logs', `activity_log_main.${processId}.txt`);
  try {
    const contents = await readFile(logPath, 'utf8');
    const scanMatches = [...contents.matchAll(/hb_scan:\s*path=(.*?),\s*title_index=(\d+)/gi)];
    for (const match of scanMatches.reverse()) {
      const candidate = match[1].trim();
      if (sourceNameMatches(candidate, sourceDisplayName)) {
        return { sourcePath: candidate, titleNumber: Number(match[2]) + 1 };
      }
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function readQueue(processId: number, synchronizedAt: string): Promise<ReturnType<typeof parseHandBrakeQueue>> {
  const queuePath = path.join(app.getPath('appData'), 'HandBrake', `hb_queue${processId}.json`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const contents = await readFile(queuePath, 'utf8');
      const partialSizes = new Map<string, number>();
      try {
        const entries: unknown = JSON.parse(contents);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const task = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).Task : undefined;
            const destination = typeof task === 'object' && task !== null
              ? (task as Record<string, unknown>).Destination
              : undefined;
            const outputPath = typeof destination === 'string' ? destination : undefined;
            if (!outputPath) continue;
            try {
              const info = await stat(outputPath);
              partialSizes.set(outputPath.toLowerCase(), info.size);
            } catch {
              // A missing output is valid before encoding starts.
            }
          }
        }
      } catch {
        // parseHandBrakeQueue below reports malformed queue data.
      }
      return parseHandBrakeQueue(contents, processId, synchronizedAt, partialSizes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  return [];
}

export async function readHandBrakeLiveSnapshot(): Promise<LiveHandBrakeSnapshot> {
  const synchronizedAt = new Date().toISOString();
  const windows = await readUiWindows();
  if (windows.length === 0) {
    return {
      available: false,
      guiRunning: false,
      synchronizedAt,
      jobs: [],
      unavailableFields: ['HandBrake GUI window', 'Current source', 'Current encode settings', 'Queue jobs', 'Encode progress'],
      message: process.platform === 'win32'
        ? 'HandBrake GUI is not running or did not expose a readable window.'
        : 'Live HandBrake GUI synchronization is currently supported on Windows only.',
    };
  }

  const gui = windows.find((window) => window.sourceDisplayName) ?? windows[0];
  const scanned = await readCurrentScannedPath(gui.processId, gui.sourceDisplayName);
  const summary = parseSummary(gui.sourceSummary);
  const jobLists = await Promise.all(windows.map((window) => readQueue(window.processId, synchronizedAt)));
  const jobs = jobLists.flat();
  const current = buildCurrentConfiguration(gui, gui.processId, scanned.sourcePath, parseUiTitle(gui.titleText) ?? scanned.titleNumber);
  const unavailableFields = [...current.job.unavailableFields];
  if (!jobs.length) unavailableFields.push('Queue jobs (no readable GUI queue JSON for this process)');
  unavailableFields.push('Reliable encode percentage');
  const currentName = gui.sourceDisplayName;
  return {
    available: true,
    guiRunning: true,
    processId: gui.processId,
    windowTitle: gui.windowTitle,
    synchronizedAt,
    sourcePath: scanned.sourcePath,
    sourceDisplayName: currentName,
    titleNumber: parseUiTitle(gui.titleText) ?? scanned.titleNumber,
    durationSeconds: parseUiDuration(gui.durationText),
    ...summary,
    preset: gui.preset,
    destination: gui.destination,
    guiStatus: gui.status,
    jobs,
    currentConfiguration: current.job,
    unavailableFields,
    message: jobs.length > 0
      ? `HandBrake detected through Windows UI Automation and its read-only queue JSON. The current unqueued GUI settings are read from the settings tabs; ${jobs.length} queue job(s) are also available.`
      : 'HandBrake detected through Windows UI Automation. Current unqueued settings are read from the GUI tabs; fields not exposed by accessibility are marked unavailable.',
  };
}
