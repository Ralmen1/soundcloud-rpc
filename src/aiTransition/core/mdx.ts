import { STFT } from './stft';

export interface StereoPcm {
    left: Float32Array;
    right: Float32Array;
    sampleRate: number;
}

// Runs the network on one [batch, 4, dimF, dimT] spectrogram and returns the same shape.
// Electron uses onnxruntime-node, a phone build can plug in onnxruntime-web or a server call.
export type ModelRunner = (input: Float32Array, dims: [number, number, number, number]) => Promise<Float32Array>;

export interface MdxConfig {
    nFft: number;
    hop: number;
    dimF: number;
    dimT: number;
    compensate: number;
    sampleRate: number;
}

// UVR_MDXNET_1_9703 (UVR MDX-Net, ~28 MB): about half the memory and time of the 64 MB models,
// same vocal detection on our test tracks. Vocals are the primary stem.
export const UVR_MDXNET_1_9703: MdxConfig = {
    nFft: 6144,
    hop: 1024,
    dimF: 2048,
    dimT: 256,
    compensate: 1.03,
    sampleRate: 44100,
};

export const DEFAULT_MODEL = {
    file: 'UVR_MDXNET_1_9703.onnx',
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_1_9703.onnx',
    bytes: 29704436,
    config: UVR_MDXNET_1_9703,
};

export interface Separation {
    vocals: StereoPcm;
    instrumental: StereoPcm;
}

export class MdxSeparator {
    private readonly cfg: MdxConfig;
    private readonly stft: STFT;
    private readonly run: ModelRunner;

    constructor(run: ModelRunner, cfg: MdxConfig = UVR_MDXNET_1_9703) {
        this.cfg = cfg;
        this.run = run;
        this.stft = new STFT(cfg.nFft, cfg.hop);
    }

    async separate(mix: StereoPcm): Promise<Separation> {
        const { nFft, hop, dimF, dimT, compensate, sampleRate } = this.cfg;
        if (mix.sampleRate !== sampleRate) throw new Error(`expected ${sampleRate} Hz, got ${mix.sampleRate}`);
        const n = mix.left.length;
        const chunk = hop * (dimT - 1);
        const trim = nFft / 2;
        const gen = chunk - 2 * trim;
        const pad = gen - (n % gen);
        const padded = [mix.left, mix.right].map((ch) => {
            const p = new Float32Array(trim + n + pad + trim);
            p.set(ch, trim);
            return p;
        });

        const vocals = [new Float32Array(n), new Float32Array(n)];
        for (let offset = 0; offset < n + pad; offset += gen) {
            const input = new Float32Array(4 * dimF * dimT);
            for (let c = 0; c < 2; c++) {
                const spec = this.stft.forward(padded[c].subarray(offset, offset + chunk), dimF);
                if (spec.frames !== dimT) throw new Error(`frame mismatch ${spec.frames} != ${dimT}`);
                input.set(spec.re, (c * 2) * dimF * dimT);
                input.set(spec.im, (c * 2 + 1) * dimF * dimT);
            }
            const output = await this.run(input, [1, 4, dimF, dimT]);
            for (let c = 0; c < 2; c++) {
                const re = output.subarray((c * 2) * dimF * dimT, (c * 2 + 1) * dimF * dimT);
                const im = output.subarray((c * 2 + 1) * dimF * dimT, (c * 2 + 2) * dimF * dimT);
                const wave = this.stft.inverse(re, im, dimF, dimT, chunk);
                const take = Math.min(gen, n - offset);
                for (let i = 0; i < take; i++) vocals[c][offset + i] = wave[trim + i] * compensate;
            }
        }

        const inst = [new Float32Array(n), new Float32Array(n)];
        const src = [mix.left, mix.right];
        for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) inst[c][i] = src[c][i] - vocals[c][i];
        return {
            vocals: { left: vocals[0], right: vocals[1], sampleRate },
            instrumental: { left: inst[0], right: inst[1], sampleRate },
        };
    }
}
