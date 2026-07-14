import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { CoreAgentRuntime } from './core-agent-runtime.js';
import { registerIpcHandlers, type IpcHandlerRegistrar } from './ipc-handlers.js';
import { SessionManager } from './session-manager.js';

const WINDOW_WIDTH = 1_440;
const WINDOW_HEIGHT = 920;
const WINDOW_MIN_WIDTH = 1_000;
const WINDOW_MIN_HEIGHT = 680;
const WINDOW_BACKGROUND_COLOR = '#FAFBFC';
const PRELOAD_ENTRY_PATH = '../preload/index.cjs';
const RENDERER_ENTRY_PATH = '../renderer/index.html';
const MACOS_PLATFORM = 'darwin';

let mainWindow: BrowserWindow | null = null;
let unregisterIpcHandlers: (() => void) | null = null;
const sessionManager = new SessionManager(new CoreAgentRuntime());

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, PRELOAD_ENTRY_PATH),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, RENDERER_ENTRY_PATH));
  }
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function registerDesktopIpc(): void {
  const registrar: IpcHandlerRegistrar = {
    handle(channel, handler): void {
      ipcMain.handle(channel, (event, input) => handler(event, input));
    },
  };
  unregisterIpcHandlers = registerIpcHandlers(registrar, sessionManager, {
    send(channel, snapshot): void {
      if (!mainWindow?.isDestroyed()) {
        mainWindow?.webContents.send(channel, snapshot);
      }
    },
  });
}

app.whenReady().then(() => {
  registerDesktopIpc();
  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== MACOS_PLATFORM) app.quit();
});

app.on('before-quit', () => {
  unregisterIpcHandlers?.();
  unregisterIpcHandlers = null;
});
