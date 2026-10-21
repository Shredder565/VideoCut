import { vc } from './bridge';

export interface MediaStream {
  index: number,
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment' | string,
  codec_name?: string,
  codec_long_name?: string,
  profile?: string,
  level?: number,
  width?: number,
  height?: number,
  pix_fmt?: string,
  field_order?: string,
  has_b_frames?: number,
  avg_frame_rate?: string,
  r_frame_rate?: string,
  sample_rate?: string,
  channels?: number,
  channel_layout?: string,
  bit_rate?: string,
  color_range?: string,
  color_space?: string,
  color_transfer?: string,
  color_primaries?: string,
  disposition?: { attached_pic?: number, default?: number },
  tags?: { language?: string, title?: string },
}

export interface MediaInfo {
  path: string,
  formatName: string,
  duration: number,
  startTime: number,
  size: number | undefined,
  streams: MediaStream[],
  video: MediaStream | undefined,
  audio: MediaStream | undefined,
  fps: number | undefined,
}

function parseRate(rate: string | undefined) {
  if (rate == null) return undefined;
  const [n, d] = rate.split('/').map(Number);
  if (n == null || !Number.isFinite(n) || n <= 0) return undefined;
  const fps = d != null && d > 0 ? n / d : n;
  return fps > 0 && fps < 1000 ? fps : undefined;
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const stdout = await vc.ffprobe(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  const json = JSON.parse(stdout) as { format?: { format_name?: string, duration?: string, start_time?: string, size?: string }, streams?: MediaStream[] };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This file has no duration (is it a video or audio file?)');
  return {
    path,
    formatName: json.format?.format_name ?? '',
    duration,
    startTime: Number(json.format?.start_time) || 0,
    size: Number(json.format?.size) || undefined,
    streams,
    video,
    audio,
    fps: video != null ? (parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)) : undefined,
  };
}

// The container types offered for export, and what to use for "same as the input"
export const containers = [
  { id: 'mp4', label: 'MP4', format: 'mp4', ext: '.mp4' },
  { id: 'mkv', label: 'Matroska (MKV)', format: 'matroska', ext: '.mkv' },
  { id: 'ts', label: 'MPEG-TS', format: 'mpegts', ext: '.ts' },
  { id: 'mov', label: 'QuickTime (MOV)', format: 'mov', ext: '.mov' },
  { id: 'm4a', label: 'M4A (audio)', format: 'ipod', ext: '.m4a' },
  { id: 'mka', label: 'Matroska audio (MKA)', format: 'matroska', ext: '.mka' },
] as const;

export function containerForInput(info: MediaInfo, path: string) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (ext === '.m2ts' || ext === '.mts') return { format: 'mpegts', ext };
  const byExt = containers.find((c) => c.ext === ext);
  if (byExt != null) return { format: byExt.format, ext: byExt.ext };
  if (info.formatName.includes('mpegts')) return { format: 'mpegts', ext: '.ts' };
  if (info.formatName.includes('mpeg')) return { format: 'mpeg', ext: '.mpg' };
  if (info.formatName.includes('matroska') || info.formatName.includes('webm')) return { format: 'matroska', ext: '.mkv' };
  if (info.formatName.includes('avi')) return { format: 'avi', ext: '.avi' };
  return info.video != null ? { format: 'matroska', ext: '.mkv' } : { format: 'matroska', ext: '.mka' };
}

export function formatTime(seconds: number, { short = false }: { short?: boolean } = {}) {
  const neg = seconds < 0;
  const ms = Math.round(Math.abs(seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  if (short) {
    const main = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    return `${neg ? '-' : ''}${main}`;
  }
  return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}.${pad(frac, 3)}`;
}

// "1:02:03.5", "02:03", "123.4", "45" -> seconds
export function parseTime(text: string) {
  const t = text.trim();
  if (t === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m == null) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatBytes(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export interface StripFrame {
  // seconds relative to the file start
  time: number,
  type: string,
  url: string,
}

// JPEG pictures written back to back: split at each start-of-image marker
function splitJpegs(bytes: Uint8Array) {
  const starts: number[] = [];
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) starts.push(i);
  }
  return starts.map((s, i) => bytes.slice(s, starts[i + 1] ?? bytes.length));
}

// The frames around `time`, decoded exactly: `before` frames before it and `after` from it on.
export async function readStripFrames({ info, time, before, after, height }: { info: MediaInfo, time: number, before: number, after: number, height: number }): Promise<StripFrame[]> {
  const { video, fps } = info;
  if (video == null || fps == null) return [];
  const frameDuration = 1 / fps;
  const from = Math.max(0, time - before * frameDuration - frameDuration / 2);
  const count = before + after;
  // frame types and exact times from the decoder, pictures as JPEG
  const absFrom = info.startTime + from;
  const [pictures, typesOut] = await Promise.all([
    vc.ffmpegOutput(['-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(4), '-i', info.path, '-map', `0:${video.index}`, '-frames:v', String(count),
      '-vf', `scale=-2:${height}`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { jobId: 'strip' }),
    vc.ffprobe(['-v', 'error', '-select_streams', String(video.index), '-read_intervals', `${absFrom.toFixed(4)}%+#${count + 8}`,
      '-show_entries', 'frame=best_effort_timestamp_time,pict_type', '-of', 'json', info.path]),
  ]);
  const jpegs = splitJpegs(pictures);
  const frames = (JSON.parse(typesOut) as { frames?: { best_effort_timestamp_time?: string, pict_type?: string }[] }).frames ?? [];
  const times = frames
    .map((f) => ({ t: Number(f.best_effort_timestamp_time) - info.startTime, type: f.pict_type ?? '?' }))
    .filter((f) => Number.isFinite(f.t) && f.t >= from - frameDuration / 4)
    .sort((a, b) => a.t - b.t);
  return jpegs.map((jpeg, i) => {
    const meta = times[i];
    return {
      time: meta?.t ?? from + i * frameDuration,
      type: meta?.type ?? '?',
      url: URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })),
    };
  });
}

// Audio loudness peaks for the whole file: `perSecond` values per second, 0..1
export async function readWaveform(info: MediaInfo, perSecond = 50) {
  if (info.audio == null) return undefined;
  const rate = perSecond * 8;
  const raw = await vc.ffmpegOutput(['-hide_banner', '-loglevel', 'error', '-i', info.path, '-map', `0:${info.audio.index}`, '-ac', '1', '-ar', String(rate),
    '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1'], { jobId: 'waveform' });
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
  const peaks = new Float32Array(Math.ceil(samples.length / 8));
  for (let i = 0; i < peaks.length; i += 1) {
    let max = 0;
    for (let j = i * 8; j < Math.min(samples.length, i * 8 + 8); j += 1) max = Math.max(max, Math.abs(samples[j]!));
    peaks[i] = Math.min(1, Math.sqrt(max / 32768));
  }
  return { peaks, perSecond };
}

// Keyframe times of the main video stream (from the packet index, no decoding)
export async function readKeyframes(info: MediaInfo) {
  if (info.video == null) return [];
  const out = await vc.ffprobe(['-v', 'error', '-select_streams', String(info.video.index), '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', info.path]);
  const times: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [pts, flags] = line.split(',');
    if (flags?.includes('K')) {
      const t = Number(pts) - info.startTime;
      if (Number.isFinite(t)) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}
