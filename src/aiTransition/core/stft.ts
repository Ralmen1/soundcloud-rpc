import { FFT } from './fft';

// STFT/iSTFT matching torch.stft(center=True, pad_mode='reflect', window=hann(periodic)), as MDX-Net expects.
export class STFT {
    readonly nFft: number;
    readonly hop: number;
    readonly bins: number;
    private readonly fft: FFT;
    private readonly window: Float64Array;
    private readonly re: Float64Array;
    private readonly im: Float64Array;

    constructor(nFft: number, hop: number) {
        this.nFft = nFft;
        this.hop = hop;
        this.bins = nFft / 2 + 1;
        this.fft = new FFT(nFft);
        this.window = new Float64Array(nFft);
        for (let i = 0; i < nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
        this.re = new Float64Array(nFft);
        this.im = new Float64Array(nFft);
    }

    frameCount(length: number): number {
        return Math.floor(length / this.hop) + 1;
    }

    // Returns real and imaginary parts laid out [bin][frame], cropped to `bins` rows.
    forward(signal: Float32Array, bins = this.bins): { re: Float32Array; im: Float32Array; frames: number } {
        const { nFft, hop, window } = this;
        const pad = nFft / 2;
        const n = signal.length;
        const frames = this.frameCount(n);
        const outRe = new Float32Array(bins * frames);
        const outIm = new Float32Array(bins * frames);
        const at = (i: number) => {
            let j = i - pad;
            if (j < 0) j = -j;
            if (j >= n) j = 2 * (n - 1) - j;
            return signal[Math.min(Math.max(j, 0), n - 1)];
        };
        for (let t = 0; t < frames; t++) {
            const start = t * hop;
            for (let i = 0; i < nFft; i++) {
                this.re[i] = at(start + i) * window[i];
                this.im[i] = 0;
            }
            this.fft.transform(this.re, this.im);
            for (let f = 0; f < bins; f++) {
                outRe[f * frames + t] = this.re[f];
                outIm[f * frames + t] = this.im[f];
            }
        }
        return { re: outRe, im: outIm, frames };
    }

    // Inverse of forward(); rows beyond the given `bins` are treated as zero.
    inverse(re: Float32Array, im: Float32Array, bins: number, frames: number, length: number): Float32Array {
        const { nFft, hop, window } = this;
        const pad = nFft / 2;
        const total = (frames - 1) * hop + nFft;
        const acc = new Float64Array(total);
        const norm = new Float64Array(total);
        for (let t = 0; t < frames; t++) {
            this.re.fill(0);
            this.im.fill(0);
            for (let f = 0; f < Math.min(bins, this.bins); f++) {
                this.re[f] = re[f * frames + t];
                this.im[f] = im[f * frames + t];
            }
            // Hermitian mirror so the result is real.
            for (let f = 1; f < nFft / 2; f++) {
                this.re[nFft - f] = this.re[f];
                this.im[nFft - f] = -this.im[f];
            }
            this.im[0] = 0;
            this.im[nFft / 2] = 0;
            this.fft.transform(this.re, this.im, true);
            const start = t * hop;
            for (let i = 0; i < nFft; i++) {
                acc[start + i] += (this.re[i] / nFft) * window[i];
                norm[start + i] += window[i] * window[i];
            }
        }
        const out = new Float32Array(length);
        for (let i = 0; i < length; i++) {
            const k = i + pad;
            out[i] = norm[k] > 1e-11 ? acc[k] / norm[k] : 0;
        }
        return out;
    }
}
