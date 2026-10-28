import { contextBridge, ipcRenderer } from 'electron';
import type { TrackInfo, TrackUpdateReason } from './types';

contextBridge.exposeInMainWorld('soundcloudAPI', {
    sendTrackUpdate: (data: TrackInfo, reason: TrackUpdateReason) => {
        ipcRenderer.send('soundcloud:track-update', {
            data,
            reason,
        });
    },
    // AI transition: aTail/bHead are { left, right, sampleRate } at 44.1 kHz.
    aiTransitionRender: (aTail: unknown, bHead: unknown) => ipcRenderer.invoke('ai-transition:render', aTail, bHead),
    aiTransitionPrepareModel: () => ipcRenderer.invoke('ai-transition:prepare-model'),
});
