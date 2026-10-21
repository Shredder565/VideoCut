# Recording repair test

End-to-end test of `src/engine/streamFix.ts` (lossless repair of TV recordings) on generated broken samples.

```sh
node test-manual/streamFix/run.ts <dir with ffmpeg and ffprobe> <work dir> [case name filter]
# e.g. on Windows:
node test-manual/streamFix/run.ts ffmpeg/win32-x64/lib %TEMP%\streamfix
```

Every sample's frames show their own frame number as a bit pattern, and the audio has a 40 ms beep starting exactly on every
25th frame. Each case breaks a recording in a typical way, then:

1. `analyzeStream` must report the expected problems (and nothing for the clean recording).
2. `fixStream` remuxes it (to one or more containers / option sets) and must report no remaining problems in its own verification.
3. The output must decode without errors, have increasing video dts and non-overlapping audio packets, a container duration that
   matches the decoded frames, frame numbers that are strictly increasing (only frames that couldn't be decoded may be missing),
   and every beep within 3 ms of where it is in a clean encode with the same settings (for every audio track).

Cases: clean recording; two recordings joined byte-wise with a +5000 s timestamp jump (to .ts, .m2ts, .mkv, .mp4);
a backward jump into the first recording's range with two audio tracks; MPEG-PS (.mpg) recordings joined with a jump;
H.264 open-GOP + AAC that starts mid-GOP and is spliced mid-GOP onto another recording; reception errors (zeroed and
removed bytes); audio starting 300 ms after the video (with and without `fixAvOffset`); 33-bit timestamp wraparound.

It prints one `OK`/`FAIL` line per analysis and per fixed output, and the number of failures at the end (exit code 1 if any).
The work dir gets one `caseN` folder per case with the broken input (`broken.*`), a clean reference (`ref.*`) and the outputs (`fixed-N.*`).
