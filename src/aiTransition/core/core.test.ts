import { describe, expect, it } from 'vitest';
import { FFT } from './fft';
import { STFT } from './stft';
import { MdxSeparator, type MdxConfig, type StereoPcm } from './mdx';
import { detectVocals } from './vocals';
import { chooseTransition, renderTransition } from './plan';

const tone = (n: number, freq: number, amp = 0.3, sr = 44100) =>
    Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr));
const stereo = (ch: Float32Array): StereoPcm => ({ left: ch, right: ch.slice(), sampleRate: 44100 });

describe('fft', () => {
    it('matches a direct DFT for mixed-radix sizes', () => {
        for (const n of [12, 6144 / 64, 7680 / 64]) {
            const re = Float64Array.from({ length: n }, () => Math.random() - 0.5);
            const im = Float64Array.from({ length: n }, () => Math.random() - 0.5);
            const ref = { re: new Float64Array(n), im: new Float64Array(n) };
            for (let k = 0; k < n; k++)
                for (let t = 0; t < n; t++) {
                    const a = (-2 * Math.PI * k * t) / n;
                    ref.re[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
                    ref.im[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
                }
            new FFT(n).transform(re, im);
            for (let k = 0; k < n; k++) {
                expect(re[k]).toBeCloseTo(ref.re[k], 8);
                expect(im[k]).toBeCloseTo(ref.im[k], 8);
            }
        }
    });
});

describe('stft', () => {
    it('round-trips a signal', () => {
        const stft = new STFT(6144, 1024);
        const x = tone(1024 * 40, 440);
        const spec = stft.forward(x);
        const y = stft.inverse(spec.re, spec.im, stft.bins, spec.frames, x.length);
        let err = 0;
        for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
        expect(err).toBeLessThan(1e-4);
    });
});

describe('separator plumbing', () => {
    const cfg: MdxConfig = { nFft: 6144, hop: 1024, dimF: 2048, dimT: 256, compensate: 1, sampleRate: 44100 };

    it('a pass-through model returns the band-limited mix as vocals and keeps vocals + instrumental = mix', async () => {
        const mix = stereo(tone(44100 * 8, 300));
        const sep = new MdxSeparator(async (input) => input, cfg);
        const { vocals, instrumental } = await sep.separate(mix);
        let leak = 0;
        let sumErr = 0;
        for (let i = 0; i < mix.left.length; i++) {
            leak = Math.max(leak, Math.abs(vocals.left[i] - mix.left[i]));
            sumErr = Math.max(sumErr, Math.abs(vocals.left[i] + instrumental.left[i] - mix.left[i]));
        }
        expect(leak).toBeLessThan(5e-3);
        expect(sumErr).toBeLessThan(1e-5);
        expect(detectVocals(vocals, mix).hasVocals).toBe(true);
    }, 30_000);

    it('a silent model means no vocals', async () => {
        const mix = stereo(tone(44100 * 8, 300));
        const sep = new MdxSeparator(async (input) => new Float32Array(input.length), cfg);
        const { vocals } = await sep.separate(mix);
        expect(detectVocals(vocals, mix).hasVocals).toBe(false);
    }, 30_000);
});

describe('transition plan', () => {
    it('follows the rules', () => {
        expect(chooseTransition(true, true)).toBe('vocal-swap');
        expect(chooseTransition(true, false)).toBe('keep-vocal');
        expect(chooseTransition(false, true)).toBe('crossfade');
        expect(chooseTransition(false, false)).toBe('crossfade');
    });

    const n = 44100;
    const a = stereo(tone(n, 200));
    const b = stereo(tone(n, 500));
    const aVoc = stereo(tone(n, 1000, 0.1));
    const aInst = stereo(tone(n, 200, 0.2));
    const bVoc = stereo(tone(n, 1500, 0.1));
    const bInst = stereo(tone(n, 500, 0.2));

    it.each(['vocal-swap', 'keep-vocal', 'crossfade'] as const)('%s starts as A and ends as B', (kind) => {
        const mix = renderTransition(kind, { aMix: a, bMix: b, aVocals: aVoc, aInstrumental: aInst, bVocals: bVoc, bInstrumental: bInst });
        const first = 10;
        const last = n - 1;
        const startOfA = kind === 'crossfade' ? a.left[first] : aVoc.left[first] + aInst.left[first];
        expect(mix.left[first]).toBeCloseTo(startOfA, 2);
        const endOfB = kind === 'vocal-swap' ? bVoc.left[last] + bInst.left[last] : b.left[last];
        expect(mix.left[last]).toBeCloseTo(endOfB, 4);
    });
});
