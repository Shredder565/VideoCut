import { protocol } from 'electron';
import { Readable } from 'node:stream';

import { start } from './ffmpegProcess';

// Preview playback for files the built-in player can't decode (MPEG-2, some TS recordings, odd audio):
// ffmpeg converts the file on the fly, from the requested start time, into a fragmented MP4 stream that the
// player reads from vcpreview://stream/?path=...&start=... Seeking means asking for a new stream.

export const previewScheme = 'vcpreview';

export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: previewScheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } },
  ]);
}

let counter = 0;

export function handlePreviewProtocol() {
  protocol.handle(previewScheme, (request) => {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');
    const startTime = Number(url.searchParams.get('start') ?? '0');
    if (path == null) return new Response('missing path', { status: 400 });

    counter += 1;
    const jobId = `preview-${counter}`;
    const child = start([
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(startTime > 0 ? ['-ss', startTime.toFixed(3)] : []),
      '-i', path,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-sn', '-dn',
      '-vf', 'scale=-2:\'min(720,ih)\':flags=bilinear,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high', '-level:v', '4.0', '-crf', '22', '-g', '25',
      '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ], jobId);

    const stream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    request.signal?.addEventListener('abort', () => child.kill());
    return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' } });
  });
}
