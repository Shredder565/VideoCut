import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { access, readFile, rm, writeFile, mkdir } from 'node:fs/promises';

import { cancel, run, ToolError } from './ffmpegProcess';
import { handlePreviewProtocol, registerPreviewScheme } from './preview';
import { startTestApi } from './testApi';
import { defaultSettings } from '../shared/api';
import type { FfmpegRunOptions, Settings } from '../shared/api';

registerPreviewScheme();

let mainWindow: BrowserWindow | undefined;

// --test-api <port>, --user-data <dir> (keeps test runs away from the real settings)
function getArg(name: string) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const userDataArg = getArg('--user-data');
if (userDataArg != null) app.setPath('userData', userDataArg);

const settingsPath = () => join(app.getPath('userData'), 'settings.json');
let settings: Settings = { ...defaultSettings };

async function loadSettings() {
  try {
    settings = { ...defaultSettings, ...JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<Settings> };
  } catch {
    settings = { ...defaultSettings };
  }
}

async function saveSettings() {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'VideoCut',
    backgroundColor: settings.theme === 'dark' ? '#161514' : '#f1f0ef',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  // links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    cancel();
    mainWindow = undefined;
  });
  mainWindow = win;
}

function toIpcError(err: unknown) {
  if (err instanceof ToolError) return new Error(err.cancelled ? 'Cancelled' : err.message);
  return err instanceof Error ? err : new Error(String(err));
}

function registerIpc() {
  const progressFor = (options: FfmpegRunOptions | undefined, sender: Electron.WebContents) => (options?.jobId != null && options.duration != null
    ? (p: number) => { if (!sender.isDestroyed()) sender.send('progress', options.jobId, p); }
    : undefined);

  ipcMain.handle('ffprobe', async (_e, args: string[]) => {
    try {
      return (await run('ffprobe', args)).stdout.toString('utf8');
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('ffmpeg', async (e, args: string[], options?: FfmpegRunOptions) => {
    try {
      const { stderr } = await run('ffmpeg', args, { jobId: options?.jobId, duration: options?.duration, onProgress: progressFor(options, e.sender) });
      return { stderr };
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('ffmpegOutput', async (e, args: string[], options?: FfmpegRunOptions) => {
    try {
      const { stdout } = await run('ffmpeg', args, { jobId: options?.jobId, duration: options?.duration, onProgress: progressFor(options, e.sender) });
      return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
    } catch (err) {
      throw toIpcError(err);
    }
  });
  ipcMain.handle('cancel', (_e, jobId?: string) => cancel(jobId));

  ipcMain.handle('openFiles', async (_e, { title, multiple }: { title: string, multiple: boolean }) => {
    const res = await dialog.showOpenDialog(mainWindow!, { title, properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('chooseFolder', async (_e, title: string) => {
    const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? undefined : res.filePaths[0];
  });

  ipcMain.handle('readText', async (_e, path: string) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('writeText', (_e, path: string, content: string) => writeFile(path, content));
  ipcMain.handle('exists', async (_e, path: string) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle('remove', (_e, path: string) => rm(path, { force: true }));
  ipcMain.handle('showInFolder', (_e, path: string) => shell.showItemInFolder(path));

  ipcMain.handle('getSettings', () => settings);
  ipcMain.handle('setSettings', async (_e, changes: Partial<Settings>) => {
    settings = { ...settings, ...changes };
    await saveSettings();
    return settings;
  });
  ipcMain.handle('appVersion', () => app.getVersion());
}

app.whenReady().then(async () => {
  await loadSettings();
  Menu.setApplicationMenu(null);
  handlePreviewProtocol();
  registerIpc();
  createWindow();

  const testPort = getArg('--test-api');
  if (testPort != null) startTestApi(Number(testPort), () => mainWindow);
});

app.on('window-all-closed', () => app.quit());
