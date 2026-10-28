// Complex FFT for sizes of the form 2^k * m (m small, e.g. 7680 = 512 * 15), with no platform dependencies.

function radix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i];
            re[i] = re[j];
            re[j] = t;
            t = im[i];
            im[i] = im[j];
            im[j] = t;
        }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (sign * 2 * Math.PI) / len;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k;
                const b = a + half;
                const xr = re[b] * cr - im[b] * ci;
                const xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
                const ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
    }
}

export class FFT {
    readonly size: number;
    private readonly p: number; // power-of-two factor
    private readonly m: number; // odd factor, handled by direct DFT
    private readonly twRe: Float64Array;
    private readonly twIm: Float64Array;
    private readonly dftRe: Float64Array;
    private readonly dftIm: Float64Array;
    private readonly bufRe: Float64Array[];
    private readonly bufIm: Float64Array[];

    constructor(size: number) {
        let p = 1;
        while (size % (p * 2) === 0) p *= 2;
        this.size = size;
        this.p = p;
        this.m = size / p;
        this.twRe = new Float64Array(size);
        this.twIm = new Float64Array(size);
        for (let i = 0; i < size; i++) {
            this.twRe[i] = Math.cos((-2 * Math.PI * i) / size);
            this.twIm[i] = Math.sin((-2 * Math.PI * i) / size);
        }
        const m = this.m;
        this.dftRe = new Float64Array(m * m);
        this.dftIm = new Float64Array(m * m);
        for (let a = 0; a < m; a++) {
            for (let b = 0; b < m; b++) {
                this.dftRe[a * m + b] = Math.cos((-2 * Math.PI * a * b) / m);
                this.dftIm[a * m + b] = Math.sin((-2 * Math.PI * a * b) / m);
            }
        }
        this.bufRe = Array.from({ length: m }, () => new Float64Array(p));
        this.bufIm = Array.from({ length: m }, () => new Float64Array(p));
    }

    // In-place transform. The inverse is unscaled; divide by size yourself.
    transform(re: Float64Array, im: Float64Array, inverse = false): void {
        const { p, m, size } = this;
        if (m === 1) {
            radix2(re, im, inverse);
            return;
        }
        const s = inverse ? -1 : 1;
        for (let n2 = 0; n2 < m; n2++) {
            const br = this.bufRe[n2];
            const bi = this.bufIm[n2];
            for (let n1 = 0; n1 < p; n1++) {
                br[n1] = re[n1 * m + n2];
                bi[n1] = im[n1 * m + n2];
            }
            radix2(br, bi, inverse);
            for (let k1 = 0; k1 < p; k1++) {
                const t = (n2 * k1) % size;
                const wr = this.twRe[t];
                const wi = s * this.twIm[t];
                const xr = br[k1] * wr - bi[k1] * wi;
                bi[k1] = br[k1] * wi + bi[k1] * wr;
                br[k1] = xr;
            }
        }
        for (let k1 = 0; k1 < p; k1++) {
            for (let k2 = 0; k2 < m; k2++) {
                let sr = 0;
                let si = 0;
                for (let n2 = 0; n2 < m; n2++) {
                    const wr = this.dftRe[n2 * m + k2];
                    const wi = s * this.dftIm[n2 * m + k2];
                    const xr = this.bufRe[n2][k1];
                    const xi = this.bufIm[n2][k1];
                    sr += xr * wr - xi * wi;
                    si += xr * wi + xi * wr;
                }
                re[k1 + p * k2] = sr;
                im[k1 + p * k2] = si;
            }
        }
    }
}
