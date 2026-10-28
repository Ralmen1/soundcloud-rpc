import { app, ipcMain, net, utilityProcess } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DEFAULT_MODEL, type StereoPcm, type TransitionResult } from './core';

const RENDER_TIMEOUT_MS = 60_000;

export class AiTransitionService {
    private modelDownload: Promise<string> | null = null;
    private busy = false;

    constructor() {
        ipcMain.handle('ai-transition:render', (_event, aTail: StereoPcm, bHead: StereoPcm) => this.render(aTail, bHead));
        ipcMain.handle('ai-transition:prepare-model', () => this.ensureModel().then(() => true));
    }

    private modelPath(): string {
        return path.join(app.getPath('userData'), 'models', DEFAULT_MODEL.file);
    }

    // The model is fetched once on first use instead of being shipped in the installer.
    ensureModel(): Promise<string> {
        const target = this.modelPath();
        if (existsSync(target) && statSync(target).size === DEFAULT_MODEL.bytes) return Promise.resolve(target);
        if (!this.modelDownload) {
            this.modelDownload = (async () => {
                mkdirSync(path.dirname(target), { recursive: true });
                const partial = `${target}.part`;
                const response = await net.fetch(DEFAULT_MODEL.url);
                if (!response.ok || !response.body) throw new Error(`model download failed: ${response.status}`);
                await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
                if (statSync(partial).size !== DEFAULT_MODEL.bytes) {
                    unlinkSync(partial);
                    throw new Error('model download incomplete');
                }
                renameSync(partial, target);
                return target;
            })().finally(() => {
                this.modelDownload = null;
            });
        }
        return this.modelDownload;
    }

    async render(aTail: StereoPcm, bHead: StereoPcm): Promise<TransitionResult & { ms: number }> {
        if (this.busy) throw new Error('a transition is already rendering');
        this.busy = true;
        try {
            const modelPath = await this.ensureModel();
            const child = utilityProcess.fork(path.join(__dirname, 'separatorWorker.js'), [], {
                serviceName: 'ai-transition',
            });
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill();
                    reject(new Error('transition render timed out'));
                }, RENDER_TIMEOUT_MS);
                child.once('message', (message) => {
                    clearTimeout(timer);
                    child.kill();
                    if (message.ok) resolve({ ...message.result, ms: message.ms });
                    else reject(new Error(message.error));
                });
                child.once('exit', (code) => {
                    clearTimeout(timer);
                    reject(new Error(`separator exited with code ${code}`));
                });
                child.postMessage({ modelPath, aTail, bHead });
            });
        } finally {
            this.busy = false;
        }
    }
}
