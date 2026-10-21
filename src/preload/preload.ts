import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { pathToFileURL } from 'node:url';

import type { FfmpegRunOptions, Settings, TestApiRequest, VideoCutApi } from '../shared/api';

const api: VideoCutApi = {
  ffprobe: (args) => ipcRenderer.invoke('ffprobe', args),
  ffmpeg: (args, options?: FfmpegRunOptions) => ipcRenderer.invoke('ffmpeg', args, options),
  ffmpegOutput: (args, options?: FfmpegRunOptions) => ipcRenderer.invoke('ffmpegOutput', args, options),
  cancel: (jobId) => ipcRenderer.invoke('cancel', jobId),
  onProgress: (listener) => {
    const handler = (_e: unknown, jobId: string, progress: number) => listener(jobId, progress);
    ipcRenderer.on('progress', handler);
    return () => { ipcRenderer.off('progress', handler); };
  },

  openFiles: (options) => ipcRenderer.invoke('openFiles', options),
  chooseFolder: (title) => ipcRenderer.invoke('chooseFolder', title),
  pathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (path) => pathToFileURL(path).href,
  previewUrl: (path, start) => `vcpreview://stream/?path=${encodeURIComponent(path)}&start=${start.toFixed(3)}&n=${Date.now()}`,

  readText: (path) => ipcRenderer.invoke('readText', path),
  writeText: (path, content) => ipcRenderer.invoke('writeText', path, content),
  exists: (path) => ipcRenderer.invoke('exists', path),
  remove: (path) => ipcRenderer.invoke('remove', path),
  showInFolder: (path) => ipcRenderer.invoke('showInFolder', path),

  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (changes: Partial<Settings>) => ipcRenderer.invoke('setSettings', changes),
  appVersion: () => ipcRenderer.invoke('appVersion'),

  onTestRequest: (listener) => {
    const handler = (_e: unknown, request: TestApiRequest) => listener(request);
    ipcRenderer.on('testRequest', handler);
    return () => { ipcRenderer.off('testRequest', handler); };
  },
  sendTestResponse: (id, result) => ipcRenderer.send('testResponse', id, result),
};

contextBridge.exposeInMainWorld('videocut', api);
