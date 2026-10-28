import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {}, clipboard: {} }));

import { isGoogleCallbackUrl, isGoogleSignInUrl } from './browserSignInService';

describe('browser sign-in urls', () => {
    it('spots the Google sign-in popup', () => {
        expect(isGoogleSignInUrl('https://accounts.google.com/v3/signin/identifier?client_id=x')).toBe(true);
        expect(isGoogleSignInUrl('https://soundcloud.com/signin')).toBe(false);
        expect(isGoogleSignInUrl('not a url')).toBe(false);
    });

    it('accepts only the SoundCloud Google callback', () => {
        expect(isGoogleCallbackUrl(' https://secure.soundcloud.com/web-auth-callback-google?code=1&state=2 ')).toBe(true);
        expect(isGoogleCallbackUrl('https://secure.soundcloud.com/web-auth-callback-google#id_token=1&state=2')).toBe(true);
        expect(isGoogleCallbackUrl('https://evil.example/web-auth-callback-google?code=1')).toBe(false);
        expect(isGoogleCallbackUrl('https://secure.soundcloud.com/web-auth-callback-google')).toBe(false);
    });
});
