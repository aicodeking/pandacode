import base from './playwright.config.ts';
export default { ...base, testMatch: ['**/extensions-runtime-private-secrets.spec.ts'], grep: undefined };
