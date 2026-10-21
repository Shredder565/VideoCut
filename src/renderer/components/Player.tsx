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

// Plays the open file. Times are seconds from the start of the file.
export default function Player({ info, volume, onTime, onPlaying, onModeChange, ref }: {
  info: MediaInfo,
  volume: number,
  onTime: (time: number) => void,
  onPlaying: (playing: boolean) => void,
  onModeChange?: (mode: 'native' | 'preview') => void,
  ref: Ref<PlayerHandle>,
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<'native' | 'preview'>(() => (canPlayNatively(info) ? 'native' : 'preview'));
  // in preview mode the stream starts at this file time
  const [previewStart, setPreviewStart] = useState(0);
  const previewStartRef = useRef(0);
  const stopAtRef = useRef<number | undefined>(undefined);
  const pendingSeekRef = useRef<number | undefined>(undefined);
  const resumeRef = useRef(false);
  const timeRef = useRef(0);

  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const src = mode === 'native' ? vc.fileUrl(info.path) : vc.previewUrl(info.path, previewStart);

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
    const buffered = v.buffered.length > 0 ? v.buffered.end(v.buffered.length - 1) : 0;
    if (rel >= 0 && rel <= buffered) {
      v.currentTime = rel;
    } else {
      resumeRef.current = !v.paused;
      previewStartRef.current = time;
      pendingSeekRef.current = 0;
      setPreviewStart(time);
    }
  }, [info.duration, mode, onTime]);

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
      setTimeout(() => videoRef.current?.play().catch(() => undefined), 150);
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

  const onError = useCallback(() => {
    // the built-in player couldn't open it after all: switch to the preview stream at the same position
    if (mode === 'native') {
      resumeRef.current = !(videoRef.current?.paused ?? true);
      previewStartRef.current = timeRef.current;
      setPreviewStart(timeRef.current);
      setMode('preview');
    }
  }, [mode]);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (v == null) return;
    if (mode === 'native' && info.video != null && v.videoWidth === 0) {
      onError();
      return;
    }
    if (pendingSeekRef.current != null) {
      v.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = undefined;
    } else if (mode === 'native') {
      v.currentTime = timeRef.current;
    }
    if (resumeRef.current) {
      resumeRef.current = false;
      v.play().catch(() => undefined);
    }
  }, [info.video, mode, onError]);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        key={src}
        src={src}
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: info.video != null ? 'block' : 'none' }}
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
        onEnded={() => onPlaying(false)}
        onSeeked={() => onTime(fileTime())}
        onClick={() => {
          const v = videoRef.current;
          if (v) {
            if (v.paused) v.play().catch(() => undefined); else v.pause();
          }
        }}
      />
      {info.video == null && (
        <div style={{ color: '#bbb', fontSize: '1.1em' }}>Audio file</div>
      )}
      {mode === 'preview' && (
        <div className="chip" style={{ position: 'absolute', top: 10, left: 10, background: 'rgb(0 0 0 / 50%)', color: '#ddd' }} title="This file's format can't be played directly, so a converted preview is shown. Exports always use the original.">
          Preview
        </div>
      )}
    </div>
  );
}
