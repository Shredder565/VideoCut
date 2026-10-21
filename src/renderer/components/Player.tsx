import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Ref } from 'react';

import { vc } from '../bridge';
import type { MediaInfo } from '../media';

export interface PlayerHandle {
  play: () => void,
  pause: () => void,
  toggle: () => void,
  seek: (time: number) => void,
  // plays from..to once (preview of a clip)
  playRange: (from: number, to: number) => void,
}

const nativeVideoCodecs = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc', 'theora']);
const nativeAudioCodecs = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8', 'alac']);
const nativeContainers = ['mov', 'mp4', 'm4a', 'matroska', 'webm', 'ogg', 'mp3', 'flac', 'wav', 'aac'];

// Can the built-in player probably decode this file? (otherwise playback goes through an ffmpeg preview stream)
function canPlayNatively(info: MediaInfo) {
  if (!nativeContainers.some((c) => info.formatName.split(',').includes(c))) return false;
  if (info.video != null && !nativeVideoCodecs.has(info.video.codec_name ?? '')) return false;
  if (info.audio != null && !nativeAudioCodecs.has(info.audio.codec_name ?? '')) return false;
  return true;
}

// how far ahead of the playhead the preview stream is read before waiting
const previewReadAhead = 45;

// Plays a preview stream (fragmented MP4 from ffmpeg, starting at `start`) through Media Source Extensions.
// Returns a function that stops it.
function startPreviewStream({ video, info, start, onFatal }: { video: HTMLVideoElement, info: MediaInfo, start: number, onFatal: (msg: string) => void }) {
  const controller = new AbortController();
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  const codecs = [...(info.video != null ? ['avc1.640028'] : []), ...(info.audio != null ? ['mp4a.40.2'] : [])].join(',');

  mediaSource.addEventListener('sourceopen', async () => {
    URL.revokeObjectURL(objectUrl);
    let sourceBuffer: SourceBuffer;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
    } catch (err) {
      onFatal(`Preview not possible: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const appendChunk = (chunk: Uint8Array) => new Promise<void>((resolve, reject) => {
      const done = () => {
        sourceBuffer.removeEventListener('updateend', done);
        sourceBuffer.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        sourceBuffer.removeEventListener('updateend', done);
        sourceBuffer.removeEventListener('error', fail);
        reject(new Error('Preview stream error'));
      };
      sourceBuffer.addEventListener('updateend', done);
      sourceBuffer.addEventListener('error', fail);
      sourceBuffer.appendBuffer(chunk as Uint8Array<ArrayBuffer>);
    });
    try {
      const res = await fetch(vc.previewUrl(info.path, start), { signal: controller.signal });
      if (res.body == null) throw new Error('No preview stream');
      const reader = res.body.getReader();
      for (;;) {
        // don't read too far ahead: ffmpeg then simply waits
        while (!controller.signal.aborted && sourceBuffer.buffered.length > 0 && sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1) - video.currentTime > previewReadAhead) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 400));
        }
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        // eslint-disable-next-line no-await-in-loop
        await appendChunk(value);
        // keep memory in check: drop what is well behind the playhead
        if (sourceBuffer.buffered.length > 0 && video.currentTime - sourceBuffer.buffered.start(0) > 60) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((resolve) => {
            sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
            sourceBuffer.remove(0, video.currentTime - 30);
          });
        }
      }
      if (!controller.signal.aborted && mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch (err) {
      if (!controller.signal.aborted) console.warn('preview stream', err);
    }
  }, { once: true });

  return () => controller.abort();
}

// Plays the open file. Times are seconds from the start of the file.
export default function Player({ info, volume, onTime, onPlaying, ref }: {
  info: MediaInfo,
  volume: number,
  onTime: (time: number) => void,
  onPlaying: (playing: boolean) => void,
  ref: Ref<PlayerHandle>,
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<'native' | 'preview'>(() => (canPlayNatively(info) ? 'native' : 'preview'));
  const [message, setMessage] = useState<string>();
  // in preview mode the stream starts at this file time
  const previewStartRef = useRef(0);
  const stopPreviewRef = useRef<(() => void) | undefined>(undefined);
  const stopAtRef = useRef<number | undefined>(undefined);
  const timeRef = useRef(0);

  const restartPreview = useCallback((start: number, resume: boolean) => {
    const v = videoRef.current;
    if (v == null) return;
    stopPreviewRef.current?.();
    previewStartRef.current = start;
    stopPreviewRef.current = startPreviewStream({ video: v, info, start, onFatal: setMessage });
    if (resume) v.play().catch(() => undefined);
  }, [info]);

  // set up the source
  useEffect(() => {
    const v = videoRef.current;
    if (v == null) return undefined;
    if (mode === 'native') {
      v.src = vc.fileUrl(info.path);
    } else {
      restartPreview(timeRef.current, false);
    }
    return () => {
      stopPreviewRef.current?.();
      stopPreviewRef.current = undefined;
    };
  }, [info.path, mode, restartPreview]);

  const fileTime = useCallback(() => {
    const v = videoRef.current;
    if (v == null) return timeRef.current;
    return mode === 'native' ? v.currentTime : previewStartRef.current + v.currentTime;
  }, [mode]);

  const seek = useCallback((timeIn: number) => {
    const time = Math.max(0, Math.min(info.duration, timeIn));
    const v = videoRef.current;
    timeRef.current = time;
    onTime(time);
    if (v == null) return;
    if (mode === 'native') {
      v.currentTime = time;
      return;
    }
    // inside what the current preview stream has already delivered: seek within it, else start a new stream
    const rel = time - previewStartRef.current;
    const b = v.buffered;
    const inBuffer = b.length > 0 && [...Array(b.length).keys()].some((i) => rel >= b.start(i) && rel <= b.end(i));
    if (rel >= 0 && inBuffer) v.currentTime = rel;
    else restartPreview(time, !v.paused);
  }, [info.duration, mode, onTime, restartPreview]);

  useImperativeHandle(ref, () => ({
    play: () => { videoRef.current?.play().catch(() => undefined); },
    pause: () => videoRef.current?.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (v == null) return;
      stopAtRef.current = undefined;
      if (v.paused) v.play().catch(() => undefined); else v.pause();
    },
    seek,
    playRange: (from, to) => {
      seek(from);
      stopAtRef.current = to;
      // start once the seek has landed
      setTimeout(() => videoRef.current?.play().catch(() => undefined), 200);
    },
  }), [seek]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // report the time smoothly while playing
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v != null && !v.paused) {
        const t = fileTime();
        timeRef.current = t;
        onTime(t);
        if (stopAtRef.current != null && t >= stopAtRef.current) {
          v.pause();
          stopAtRef.current = undefined;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fileTime, onTime]);

  const switchToPreview = useCallback(() => {
    // the built-in player couldn't open it after all: use the preview stream from the same position
    if (mode === 'native') setMode('preview');
  }, [mode]);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v == null) return;
    if (mode === 'native') {
      if (info.video != null && v.videoWidth === 0) {
        switchToPreview();
        return;
      }
      v.currentTime = timeRef.current;
    }
  }, [info.video, mode, switchToPreview]);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: info.video != null ? 'block' : 'none' }}
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onError={() => { if (mode === 'native') switchToPreview(); }}
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
        onEnded={() => onPlaying(false)}
        onSeeked={() => { if (videoRef.current?.paused) onTime(fileTime()); }}
        onClick={() => {
          const v = videoRef.current;
          if (v) {
            if (v.paused) v.play().catch(() => undefined); else v.pause();
          }
        }}
      />
      {info.video == null && <div style={{ color: '#bbb', fontSize: '1.1em' }}>Audio file</div>}
      {mode === 'preview' && (
        <div className="chip" style={{ position: 'absolute', top: 10, left: 10, background: 'rgb(0 0 0 / 50%)', color: '#ddd' }} title="This file's format can't be played directly, so a converted preview is shown. Exports always use the original.">
          Preview
        </div>
      )}
      {message != null && <div className="chip" style={{ position: 'absolute', bottom: 10, left: 10, background: 'rgb(0 0 0 / 60%)', color: '#fbb' }}>{message}</div>}
    </div>
  );
}
