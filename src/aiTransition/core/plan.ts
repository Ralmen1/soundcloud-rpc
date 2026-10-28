import type { StereoPcm } from './mdx';

export type TransitionKind = 'vocal-swap' | 'keep-vocal' | 'crossfade';

// Ral's rules: A and B both sing -> A's voice goes, B's voice comes in over A's beat, then B fully.
// B has no voice -> A's voice stays, A's music goes, B's music comes in under it. A has no voice -> plain crossfade.
export function chooseTransition(aHasVocals: boolean, bHasVocals: boolean): TransitionKind {
    if (!aHasVocals) return 'crossfade';
    return bHasVocals ? 'vocal-swap' : 'keep-vocal';
}

// Gain over normalized time 0..1: 0 before `from`, 1 after `to`, equal-power in between.
function rise(from: number, to: number): (t: number) => number {
    return (t) => (t <= from ? 0 : t >= to ? 1 : Math.sin(((t - from) / (to - from)) * (Math.PI / 2)));
}

function fall(from: number, to: number): (t: number) => number {
    const r = rise(from, to);
    return (t) => Math.sqrt(Math.max(0, 1 - r(t) * r(t)));
}

interface Layer {
    pcm: StereoPcm;
    gain: (t: number) => number;
}

export interface TransitionStems {
    aMix: StereoPcm;
    bMix: StereoPcm;
    aVocals?: StereoPcm;
    aInstrumental?: StereoPcm;
    bVocals?: StereoPcm;
    bInstrumental?: StereoPcm;
}

export function transitionLayers(kind: TransitionKind, s: TransitionStems): Layer[] {
    const need = (pcm: StereoPcm | undefined, name: string) => {
        if (!pcm) throw new Error(`${kind} needs ${name}`);
        return pcm;
    };
    switch (kind) {
        case 'vocal-swap':
            return [
                { pcm: need(s.aVocals, 'aVocals'), gain: fall(0, 0.12) },
                { pcm: need(s.aInstrumental, 'aInstrumental'), gain: fall(0.55, 1) },
                { pcm: need(s.bVocals, 'bVocals'), gain: rise(0.06, 0.2) },
                { pcm: need(s.bInstrumental, 'bInstrumental'), gain: rise(0.55, 1) },
            ];
        case 'keep-vocal':
            return [
                { pcm: need(s.aVocals, 'aVocals'), gain: fall(0.85, 1) },
                { pcm: need(s.aInstrumental, 'aInstrumental'), gain: fall(0, 0.3) },
                { pcm: s.bMix, gain: rise(0, 0.3) },
            ];
        case 'crossfade':
            return [
                { pcm: s.aMix, gain: fall(0, 1) },
                { pcm: s.bMix, gain: rise(0, 1) },
            ];
    }
}

// Renders the whole transition window: sample 0 is A at (end - window), the last sample hands off to B at `window`.
export function renderTransition(kind: TransitionKind, stems: TransitionStems): StereoPcm {
    const { sampleRate } = stems.aMix;
    const length = Math.min(stems.aMix.left.length, stems.bMix.left.length);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (const layer of transitionLayers(kind, stems)) {
        for (let i = 0; i < length; i++) {
            const g = layer.gain(i / (length - 1));
            if (g === 0) continue;
            left[i] += layer.pcm.left[i] * g;
            right[i] += layer.pcm.right[i] * g;
        }
    }
    for (let i = 0; i < length; i++) {
        left[i] = Math.max(-1, Math.min(1, left[i]));
        right[i] = Math.max(-1, Math.min(1, right[i]));
    }
    return { left, right, sampleRate };
}
