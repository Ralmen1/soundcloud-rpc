import { clipboard, shell, type WebContents } from 'electron';

const SIGN_IN_PAGE = 'https://soundcloud.com/signin';
const TOKEN_PATTERN = /^\d-\d{6}-\d+-[A-Za-z0-9]{8,}$/;
const WATCH_MS = 15 * 60_000;

export function isGoogleSignInUrl(url: string): boolean {
    try {
        return new URL(url).hostname === 'accounts.google.com';
    } catch {
        return false;
    }
}

// Accepts the bare cookie value or a pasted "oauth_token=..." pair.
export function parseOauthToken(text: string): string | null {
    const value = text.trim().replace(/^oauth_token\s*[=:]\s*/i, '').replace(/;.*$/, '').trim();
    return TOKEN_PATTERN.test(value) ? value : null;
}

// Google blocks sign-in inside embedded browsers, and SoundCloud can't hand a browser sign-in back to an app.
// So "Continue with Google" opens soundcloud.com in the default browser, where Google works as usual; the user
// then copies their own oauth_token cookie from there, and the app installs that same session for itself.
let stopWatching: (() => void) | null = null;

export function attachBrowserSignIn(content: WebContents, onHint: (message: string) => void): void {
    const handOff = () => {
        void shell.openExternal(SIGN_IN_PAGE);
        watchClipboard(content, onHint);
        onHint('Войди в SoundCloud в браузере, затем скопируй куку oauth_token: F12 → Application → Cookies → soundcloud.com.');
    };
    content.setWindowOpenHandler(({ url }) => {
        if (!isGoogleSignInUrl(url)) return { action: 'allow' };
        handOff();
        return { action: 'deny' };
    });
    // soundcloud.com may open the popup blank and only then point it at Google: catch that navigation too.
    content.on('did-create-window', (popup) => {
        let handedOff = false;
        const intercept = (event: { preventDefault: () => void }, url: string) => {
            if (handedOff || !isGoogleSignInUrl(url) || popup.isDestroyed()) return;
            handedOff = true;
            event.preventDefault();
            handOff();
            popup.close();
        };
        popup.webContents.on('will-navigate', (event) => intercept(event, event.url));
        popup.webContents.on('will-redirect', (event) => intercept(event, event.url));
        popup.webContents.on('did-start-navigation', (event) => {
            if (event.isMainFrame) intercept({ preventDefault: () => popup.webContents.stop() }, event.url);
        });
    });
}

export async function installOauthToken(content: WebContents, token: string): Promise<void> {
    await content.session.cookies.set({
        url: 'https://soundcloud.com',
        domain: '.soundcloud.com',
        path: '/',
        name: 'oauth_token',
        value: token,
        secure: true,
        sameSite: 'no_restriction',
        expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    });
    await content.session.cookies.flushStore();
    content.loadURL('https://soundcloud.com/discover');
}

function watchClipboard(content: WebContents, onHint: (message: string) => void): void {
    stopWatching?.();
    const before = clipboard.readText();
    const timer = setInterval(() => {
        const text = clipboard.readText();
        const token = text === before ? null : parseOauthToken(text);
        if (!token) return;
        stopWatching?.();
        clipboard.clear();
        installOauthToken(content, token)
            .then(() => onHint('Вход выполнен.'))
            .catch((error) => onHint(`Не удалось войти: ${String(error?.message || error)}`));
    }, 700);
    const timeout = setTimeout(() => stopWatching?.(), WATCH_MS);
    stopWatching = () => {
        clearInterval(timer);
        clearTimeout(timeout);
        stopWatching = null;
    };
}
