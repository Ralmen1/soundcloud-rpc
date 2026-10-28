// Runs in an Electron utility process: loads the model, renders one transition, then the process exits,
// so the ~0.7 GB the network needs is handed back to the OS right away.
import * as ort from 'onnxruntime-node';
import { buildTransition, DEFAULT_MODEL, type StereoPcm } from './core';

interface RenderRequest {
    modelPath: string;
    aTail: StereoPcm;
    bHead: StereoPcm;
}

const port = (process as unknown as { parentPort: Electron.ParentPort }).parentPort;

port.once('message', async (event) => {
    const { modelPath, aTail, bHead } = event.data as RenderRequest;
    try {
        const session = await ort.InferenceSession.create(modelPath, {
            intraOpNumThreads: 2,
            executionMode: 'sequential',
            enableCpuMemArena: false,
            enableMemPattern: false,
        });
        const run = async (data: Float32Array, dims: [number, number, number, number]) => {
            const result = await session.run({ input: new ort.Tensor('float32', data, dims) });
            return result.output.data as Float32Array;
        };
        const started = Date.now();
        const result = await buildTransition(run, aTail, bHead, DEFAULT_MODEL.config);
        port.postMessage({ ok: true, result, ms: Date.now() - started });
    } catch (error) {
        port.postMessage({ ok: false, error: String((error as Error)?.message || error) });
    }
});
