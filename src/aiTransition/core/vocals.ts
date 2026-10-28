import type { StereoPcm } from './mdx';

export interface VocalPresence {
    hasVocals: boolean;
    // Share of audible frames where the vocal stem carries a real part of the energy.
    activity: number;
}

const FRAME_SECONDS = 0.05;
const SILENCE_DB = -45;
const VOCAL_SHARE = 0.18;
const MIN_ACTIVITY = 0.2;

function rms(pcm: StereoPcm, start: number, end: number): number {
    let sum = 0;
    for (let i = start; i < end; i++) sum += (pcm.left[i] * pcm.left[i] + pcm.right[i] * pcm.right[i]) / 2;
    return Math.sqrt(sum / Math.max(1, end - start));
}

export function detectVocals(vocals: StereoPcm, mix: StereoPcm): VocalPresence {
    const frame = Math.round(FRAME_SECONDS * mix.sampleRate);
    const floor = Math.pow(10, SILENCE_DB / 20);
    let audible = 0;
    let voiced = 0;
    for (let i = 0; i + frame <= mix.left.length; i += frame) {
        const m = rms(mix, i, i + frame);
        if (m < floor) continue;
        audible++;
        if (rms(vocals, i, i + frame) > VOCAL_SHARE * m) voiced++;
    }
    const activity = audible ? voiced / audible : 0;
    return { hasVocals: activity >= MIN_ACTIVITY, activity };
}
