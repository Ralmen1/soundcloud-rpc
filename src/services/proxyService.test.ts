import { describe, expect, it } from 'vitest';
import { buildPacScript, buildProxyConfig, SOUNDCLOUD_PROXY_DOMAINS } from './proxyService';

function runPac(pac: string, host: string): string {
    const dnsDomainIs = (h: string, d: string) => h.endsWith(d);
    return new Function('dnsDomainIs', `${pac}; return FindProxyForURL('https://' + '${host}' + '/', '${host}');`)(
        dnsDomainIs,
    );
}

describe('proxy pac script', () => {
    const pac = buildPacScript('http', '1.2.3.4', 8080, SOUNDCLOUD_PROXY_DOMAINS);

    it('routes soundcloud hosts through the proxy', () => {
        for (const host of ['soundcloud.com', 'api-v2.soundcloud.com', 'cf-hls-media.sndcdn.com', 'playback.media-streaming.soundcloud.cloud']) {
            expect(runPac(pac, host)).toBe('PROXY 1.2.3.4:8080');
        }
    });

    it('sends everything else direct', () => {
        for (const host of ['discord.com', 'ws.audioscrobbler.com', 'notsoundcloud.com']) {
            expect(runPac(pac, host)).toBe('DIRECT');
        }
    });

    it('uses the scheme keyword', () => {
        expect(runPac(buildPacScript('socks5', 'h', 1080, ['sndcdn.com']), 'a.sndcdn.com')).toBe('SOCKS5 h:1080');
    });

    it('proxies everything when soundcloud-only is off', () => {
        expect(buildProxyConfig('http', 'h', 1, false)).toEqual({ proxyRules: 'http://h:1', proxyBypassRules: '<local>' });
    });
});
