// Where the app lands: the inbox when signed in (or in demo mode), else sign-in. index.tsx and the
// root layout's Stack.Protected guards share these; tests/routes.test.ts checks the files exist.
export const HOME = '/inbox';
export const SIGN_IN = '/sign-in';
export const landing = (signedIn: boolean) => (signedIn ? HOME : SIGN_IN);
