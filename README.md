# VideoCut

Frame-accurate video cutting for Windows, with recording repair, ad break detection, joining and a batch queue.

- **Cut:** mark clips, keep or remove them, export frame-accurately. Only the frames next to each cut are re-encoded (smart render); everything else is copied.
- **Repair:** check TV recordings (.ts, .m2ts, .mpg) for broken timestamps, damaged data and late sound, and remux them without re-encoding.
- **Ads:** find commercial breaks from black frames, silence, cut rate and loudness, review them, and cut them out.
- **Join:** join videos with different formats; matching ones are copied, others converted.
- **Queue:** run repairs, ad scans, joins and exports one after another.

## Develop
```
npm install
npm run build      # main + preload (esbuild) and the window (vite) into dist/
npm start          # run it
npm test           # unit tests (vitest)
npm run typecheck
npm run pack       # portable .exe and .zip in release/
```
FFmpeg goes in `ffmpeg/win-x64` (ffmpeg.exe, ffprobe.exe and DLLs, plus FFMPEG-LICENSE.txt); it is not in git.

## End-to-end tests
Each takes the ffmpeg folder and a work folder outside the repo:
```
node test-manual/inApp/run.ts ffmpeg/win-x64 <dir>        # in the app, through --test-api (set VIDEOCUT_EXE for a packaged build)
node test-manual/exporter/run.ts ffmpeg/win-x64 <dir>
node test-manual/smartRender/run.ts ffmpeg/win-x64 <dir>
node test-manual/streamFix/run.ts ffmpeg/win-x64 <dir>
node test-manual/adDetect/run.ts ffmpeg/win-x64 <dir>
node test-manual/smartJoin/run.ts ffmpeg/win-x64 <dir>
```
