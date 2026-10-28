import type { Session } from 'electron';
import type ElectronStore = require('electron-store');

interface ProxyData {
    user: string;
    password: string;
}

export type ProxyScheme = 'http' | 'https' | 'socks5';

// Hosts SoundCloud needs for the site, API, artwork and audio streams.
export const SOUNDCLOUD_PROXY_DOMAINS = ['soundcloud.com', 'sndcdn.com', 'soundcloud.cloud'];

const PAC_KEYWORDS: Record<ProxyScheme, string> = {
    http: 'PROXY',
    https: 'HTTPS',
    socks5: 'SOCKS5',
};

export function buildPacScript(scheme: ProxyScheme, host: string, port: string | number, domains: string[]): string {
    const target = `${PAC_KEYWORDS[scheme]} ${host}:${port}`;
    const checks = domains.map((d) => `host === '${d}' || dnsDomainIs(host, '.${d}')`).join(' || ');
    return `function FindProxyForURL(url, host) {
    if (${checks}) return '${target}';
    return 'DIRECT';
}`;
}

export function buildProxyConfig(
    scheme: ProxyScheme,
    host: string,
    port: string | number,
    soundCloudOnly: boolean,
): Electron.ProxyConfig {
    if (!soundCloudOnly) {
        return { proxyRules: `${scheme}://${host}:${port}`, proxyBypassRules: '<local>' };
    }
    const pac = buildPacScript(scheme, host, port, SOUNDCLOUD_PROXY_DOMAINS);
    return {
        mode: 'pac_script',
        pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`,
    };
}

export class ProxyService {
    private store: ElectronStore;
    private onNotification: (message: string) => void;
    private sessions = new Set<Session>();

    constructor(store: ElectronStore, notifyCallback: (message: string) => void) {
        this.store = store;
        this.onNotification = notifyCallback;
    }

    // Every session that loads SoundCloud must be registered, including per-account partitions.
    addSession(session: Session): void {
        this.sessions.add(session);
    }

    async apply(): Promise<void> {
        const proxyEnabled = this.store.get('proxyEnabled');
        const proxyHost = String(this.store.get('proxyHost') || '').trim();
        const proxyPort = String(this.store.get('proxyPort') || '').trim();
        const scheme = (this.store.get('proxyScheme') as ProxyScheme) || 'http';
        const soundCloudOnly = this.store.get('proxySoundCloudOnly', true) as boolean;

        const config: Electron.ProxyConfig =
            proxyEnabled && proxyHost && proxyPort
                ? buildProxyConfig(scheme, proxyHost, proxyPort, soundCloudOnly)
                : { mode: 'direct' };

        try {
            for (const session of this.sessions) {
                await session.setProxy(config);
                await session.closeAllConnections();
            }
            if (config.mode !== 'direct') {
                console.log(`Proxy enabled: ${scheme}://${proxyHost}:${proxyPort} (soundcloud only: ${soundCloudOnly})`);
            }
        } catch (err) {
            console.error('Failed to set proxy:', err);
            this.onNotification('Failed to set proxy. Check your settings.');
        }
    }

    // Credentials for app.on('login') when the proxy asks for auth. Chromium cannot authenticate to SOCKS5.
    getCredentials(authInfo: Electron.AuthInfo): { username: string; password: string } | null {
        if (!authInfo.isProxy || !this.store.get('proxyEnabled')) return null;
        const proxyData = this.store.get('proxyData') as ProxyData | undefined;
        if (!proxyData?.user) return null;
        return { username: proxyData.user, password: proxyData.password || '' };
    }

    transformKey(key: string): string {
        const keyMap: Record<string, string> = {
            proxyUser: 'proxyData.user',
            proxyPassword: 'proxyData.password',
        };
        return keyMap[key] || key;
    }
}
