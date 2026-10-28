// Platform-independent core of the AI transition. No Electron or Node imports here, so a phone build can reuse it.
import { MdxSeparator, type MdxConfig, type ModelRunner, type StereoPcm } from './mdx';
import { detectVocals } from './vocals';
import { chooseTransition, renderTransition, type TransitionKind } from './plan';

export * from './mdx';
export * from './vocals';
export * from './plan';

export interface TransitionResult {
    kind: TransitionKind;
    mix: StereoPcm;
    aVocalActivity: number;
    bVocalActivity: number;
}

// aTail: last `window` seconds of A. bHead: first `window` seconds of B. Both at the model sample rate.
export async function buildTransition(
    run: ModelRunner,
    aTail: StereoPcm,
    bHead: StereoPcm,
    config?: MdxConfig,
): Promise<TransitionResult> {
    const separator = new MdxSeparator(run, config);
    const a = await separator.separate(aTail);
    const aPresence = detectVocals(a.vocals, aTail);
    let bActivity = 0;
    let kind = chooseTransition(aPresence.hasVocals, false);
    let b: Awaited<ReturnType<MdxSeparator['separate']>> | undefined;
    // B only needs separating when A sings; otherwise it's a plain crossfade.
    if (aPresence.hasVocals) {
        b = await separator.separate(bHead);
        const bPresence = detectVocals(b.vocals, bHead);
        bActivity = bPresence.activity;
        kind = chooseTransition(true, bPresence.hasVocals);
    }
    const mix = renderTransition(kind, {
        aMix: aTail,
        bMix: bHead,
        aVocals: a.vocals,
        aInstrumental: a.instrumental,
        bVocals: b?.vocals,
        bInstrumental: b?.instrumental,
    });
    return { kind, mix, aVocalActivity: aPresence.activity, bVocalActivity: bActivity };
}
