// The bridge between the window (renderer) and the main process. The preload script implements it on `window.videocut`.

export interface FfmpegRunOptions {
  // id for progress events and cancelling
  jobId?: string | undefined,
  // seconds of output expected, so ffmpeg's "time=" can be turned into a 0..1 progress
  duration?: number | undefined,
}

export interface Settings {
  theme: 'light' | 'dark',
  // undefined: next to the input file
  outputDir: string | undefined,
  smartCut: boolean,
  // 'separate': one file per clip, 'merge': all clips joined into one file
  exportMode: 'separate' | 'merge',
  // undefined: same type as the input file
  container: string | undefined,
  volume: number,
}

export const defaultSettings: Settings = {
  theme: 'light',
  outputDir: undefined,
  smartCut: true,
  exportMode: 'separate',
  container: undefined,
  volume: 0.8,
};

export interface TestApiRequest {
  id: number,
  action: 'open' | 'clips' | 'export' | 'settings' | 'state',
  body: unknown,
}

export interface VideoCutApi {
  ffprobe: (args: string[]) => Promise<string>,
  ffmpeg: (args: string[], options?: FfmpegRunOptions) => Promise<{ stderr: string }>,
  // runs ffmpeg and returns what it writes to stdout (pictures, raw audio)
  ffmpegOutput: (args: string[], options?: FfmpegRunOptions) => Promise<Uint8Array>,
  // stops the ffmpeg runs of one job, or all of them
  cancel: (jobId?: string) => Promise<void>,
  onProgress: (listener: (jobId: string, progress: number) => void) => () => void,

  openFiles: (options: { title: string, multiple: boolean }) => Promise<string[]>,
  chooseFolder: (title: string) => Promise<string | undefined>,
  pathForFile: (file: File) => string,
  fileUrl: (path: string) => string,
  previewUrl: (path: string, start: number) => string,

  readText: (path: string) => Promise<string | undefined>,
  writeText: (path: string, content: string) => Promise<void>,
  exists: (path: string) => Promise<boolean>,
  remove: (path: string) => Promise<void>,
  showInFolder: (path: string) => Promise<void>,

  getSettings: () => Promise<Settings>,
  setSettings: (changes: Partial<Settings>) => Promise<Settings>,
  appVersion: () => Promise<string>,

  // the optional local test API (started with --test-api <port>)
  onTestRequest: (listener: (request: TestApiRequest) => void) => () => void,
  sendTestResponse: (id: number, result: { ok: true, value: unknown } | { ok: false, error: string }) => void,
}
