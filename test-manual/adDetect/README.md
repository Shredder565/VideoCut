# Ad break detection test

```
node test-manual/adDetect/run.ts ffmpeg/win32-x64/lib <work dir> [case name filter]
```

Generates synthetic TV recordings in `<work dir>` (cached; regenerated when the timeline changes), runs
`detectAdBreaks` from `src/engine/adDetect.ts` on each, and checks that every planted break is found
within ±1 s at both edges and that there are no other breaks. Prints `OK`/`FAIL` lines, the analysis speed
(seconds per minute of video) and the failure count.

Cases:
- three breaks in a 10 min SD MPEG-2 recording, with traps: a black + silent fade in the programme, a fade exactly
  30 s (a spot length) after a break, a dark scene with quiet audio, and a 120 s programme section between two breaks
- pre-roll / post-roll: the recording starts and ends inside an ad break (partial spots)
- no ads: fades 30 s apart, three fades 15 s apart, and a dark scene
- 1080p H.264, mainly for speed

The synthetic content compresses very well, so decoding real broadcasts is slower than the speed reported here.
