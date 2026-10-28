import { clipboard, shell, type WebContents } from 'electron';

const GOOGLE_CALLBACK = 'https://secure.soundcloud.com/web-auth-callback-google';

export function isGoogleSignInUrl(url: string): boolean {
    try {
        return new URL(url).hostname === 'accounts.google.com';
    } catch {
        return false;
    }
}

export function isGoogleCallbackUrl(url: string): boolean {
    return url.trim().startsWith(`${GOOGLE_CALLBACK}?`);
}

// Google blocks sign-in inside embedded browsers, so its popup is sent to the default browser instead.
// After signing in there, the browser lands on SoundCloud's callback URL; copying that address (Ctrl+L, Ctrl+C)
// is enough: the app picks it up from the clipboard and opens it as the popup soundcloud.com expected,
// which finishes the sign-in inside the app.
const WATCH_MS = 5 * 60_000;
let stopWatching: (() => void) | null = null;

export function attachBrowserSignIn(content: WebContents, onHint: (message: string) => void): void {
    const handOff = (url: string) => {
        void shell.openExternal(url);
        watchClipboard(content);
        onHint('Войди через Google в браузере, потом скопируй адрес страницы, куда он перекинет (Ctrl+L, Ctrl+C).');
    };
    content.setWindowOpenHandler(({ url }) => {
        if (!isGoogleSignInUrl(url)) return { action: 'allow' };
        handOff(url);
        return { action: 'deny' };
    });
    // soundcloud.com may open the popup blank and only then point it at Google: catch that navigation too.
    content.on('did-create-window', (popup) => {
        let handedOff = false;
        const intercept = (event: { preventDefault: () => void }, url: string) => {
            if (handedOff || !isGoogleSignInUrl(url) || popup.isDestroyed()) return;
            handedOff = true;
            event.preventDefault();
            handOff(url);
            popup.close();
        };
        popup.webContents.on('will-navigate', (event) => intercept(event, event.url));
        popup.webContents.on('will-redirect', (event) => intercept(event, event.url));
        popup.webContents.on('did-start-navigation', (event) => {
            if (event.isMainFrame) intercept({ preventDefault: () => popup.webContents.stop() }, event.url);
        });
    });
}

function watchClipboard(content: WebContents): void {
    stopWatching?.();
    const before = clipboard.readText();
    const timer = setInterval(() => {
        const text = clipboard.readText().trim();
        if (text === before || !isGoogleCallbackUrl(text)) return;
        stopWatching?.();
        clipboard.clear();
        void content.executeJavaScript(`window.open(${JSON.stringify(text)}, 'scGoogleSignIn', 'width=480,height=640')`, true);
    }, 700);
    const timeout = setTimeout(() => stopWatching?.(), WATCH_MS);
    stopWatching = () => {
        clearInterval(timer);
        clearTimeout(timeout);
        stopWatching = null;
    };
}
