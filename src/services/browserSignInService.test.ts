import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: {}, clipboard: {} }));

import { isGoogleSignInUrl, parseOauthToken } from './browserSignInService';

describe('browser sign-in', () => {
    it('spots the Google sign-in popup', () => {
        expect(isGoogleSignInUrl('https://accounts.google.com/v3/signin/identifier?client_id=x')).toBe(true);
        expect(isGoogleSignInUrl('https://soundcloud.com/signin')).toBe(false);
        expect(isGoogleSignInUrl('not a url')).toBe(false);
    });

    it('reads an oauth_token copied from the browser', () => {
        expect(parseOauthToken(' 2-301234-123456789-AbCdEfGhIjKlMn ')).toBe('2-301234-123456789-AbCdEfGhIjKlMn');
        expect(parseOauthToken('oauth_token=2-301234-123456789-AbCdEfGhIjKlMn; Path=/')).toBe('2-301234-123456789-AbCdEfGhIjKlMn');
        expect(parseOauthToken('https://soundcloud.com/discover')).toBeNull();
        expect(parseOauthToken('hello')).toBeNull();
    });
});
