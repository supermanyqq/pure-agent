import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type DesktopAPI,
  type SendMessageInput,
  type SessionSnapshot,
  type SessionUpdateListener,
} from '../shared/ipc.js';

const desktopAPI: DesktopAPI = {
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions) as Promise<SessionSnapshot[]>,
  createSession: () => ipcRenderer.invoke(IPC_CHANNELS.createSession) as Promise<SessionSnapshot>,
  sendMessage: (input: SendMessageInput) => (
    ipcRenderer.invoke(IPC_CHANNELS.sendMessage, input) as Promise<void>
  ),
  stopSession: (sessionId: string) => (
    ipcRenderer.invoke(IPC_CHANNELS.stopSession, sessionId) as Promise<void>
  ),
  onSessionUpdated: (listener: SessionUpdateListener) => {
    const receiveUpdate = (_event: IpcRendererEvent, snapshot: SessionSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.sessionUpdated, receiveUpdate);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.sessionUpdated, receiveUpdate);
  },
};

contextBridge.exposeInMainWorld('desktopAPI', desktopAPI);
