import base from './playwright.webkit.config.ts';
export default { ...base, testMatch: ['**/extensions-runtime-private-secrets.spec.ts'], grep: undefined };
