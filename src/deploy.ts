/* Deploy: a header menu that starts an agent task to ship the project to Vercel,
 * Cloudflare, Railway, Netlify, AWS or Google Cloud end to end. The agent deploys with the pandacode_cloud_cli tool,
 * which is already signed in, so no keys appear in prompts. */
import type { CloudConnection } from './cloud-settings';

export type DeployTarget = 'vercel' | 'cloudflare' | 'railway' | 'netlify' | 'aws' | 'gcloud';
export const TARGETS: { id: DeployTarget; label: string; description: string }[] = [
  { id: 'vercel', label: 'Deploy to Vercel', description: 'Preview first, then production' },
  { id: 'cloudflare', label: 'Deploy to Cloudflare', description: 'Workers, static assets or Pages' },
  { id: 'railway', label: 'Deploy to Railway', description: 'Servers, containers and databases' },
  { id: 'netlify', label: 'Deploy to Netlify', description: 'Draft first, then production' },
  { id: 'aws', label: 'Deploy to AWS', description: 'The simplest fitting AWS service' },
  { id: 'gcloud', label: 'Deploy to Google Cloud', description: 'Cloud Run or Cloud Storage' },
];

const COMMON = `Work end to end and verify the result yourself. Use the pandacode_cloud_cli tool for the CLI below: it is already signed in to my account, so never ask me for tokens and never print or commit secrets. First read the project to understand how it builds and runs, install dependencies and run the build locally, and fix anything that stops it. If the app needs environment variables, list them and ask me for their values before deploying. When the deploy finishes, open the URL (fetch it, or use the browser) and check the main page and one key route really work; fix and redeploy if not. Finish with the live URL, what you changed in the project, and how to redeploy.`;

const BRIEFS: Record<DeployTarget, string> = {
  netlify: `Deploy this project to Netlify.\n\n${COMMON}\n\nWith tool "netlify": use the linked or connected project. If neither is set, ask which existing project or team to use before creating one with \`deploy --site-name <name> --team <team>\`. After a successful local build, run \`deploy --dir <output>\` for a draft, check its URL, then \`deploy --prod --dir <output>\` for production. The tool always adds \`--no-build\` so the connected token never enters local build scripts. Keep existing netlify.toml settings. Do not run login, raw API commands, hosted agents, or delete projects.`,
  vercel: `Deploy this project to Vercel.\n\n${COMMON}\n\nWith tool "vercel": run \`deploy --yes\` for a preview, check it, then \`deploy --prod --yes\` for production. Let Vercel detect the framework; add a minimal vercel.json only if it is needed. Add environment variables with \`env add\` if I give you values.`,
  cloudflare: `Deploy this project to Cloudflare.\n\n${COMMON}\n\nWith tool "wrangler": for a static site or a frontend build, prefer a Worker with static assets (a wrangler.jsonc with "assets": {"directory": "<build output>"}); for an API or full-stack app, a Worker with the right compatibility flags (nodejs_compat when Node APIs are used). Run \`deploy\` and report the workers.dev URL. Use Pages (\`pages deploy <dir> --project-name <name>\`) only if the project is already set up for it.`,
  railway: `Deploy this project to Railway.\n\n${COMMON}\n\nWith tool "railway": if the checkout is not linked yet, run \`init --name <project>\` (it links this folder), then \`up --ci\` to build and deploy, and \`domain\` to give the service a public railway.app URL. Let Railway's builder detect the stack; add a minimal railway.json only if the start command or build needs it. If the app needs a database, add it with \`add --database postgres\` and use the variable Railway provides. Set variables with \`variable set KEY=value\` only for values I give you, and never print variable values. Check \`logs\` and \`status\` if the deploy fails. Do not delete existing projects or services.`,
  aws: `Deploy this project to AWS.\n\n${COMMON}\n\nWith tool "aws": choose the simplest fitting service and say why before creating anything: a static site goes to S3 behind CloudFront; a container or server app to App Runner (build and push the image to ECR first) or Lambda for small functions. Tag everything you create with pandacode=deploy, keep it in the configured region, prefer the free tier, and tell me the expected monthly cost before creating anything that is not free. Do not delete existing resources.`,
  gcloud: `Deploy this project to Google Cloud.\n\n${COMMON}\n\nWith tool "gcloud" (signed in to my configured project and region): choose the simplest fitting service and say why before creating anything. Prefer Cloud Run for servers and containers: \`run deploy <service> --source . --allow-unauthenticated --labels pandacode=deploy\` (it builds with Cloud Build; enable the needed APIs with \`services enable\` first if it asks). For a static site, a Cloud Storage bucket (\`storage buckets create\`, \`storage cp --recursive\`, public read) or a small Cloud Run service that serves the build. Label everything you create with pandacode=deploy, keep it in the configured region, prefer the free tier, and tell me the expected monthly cost before creating anything that is not free. Do not delete existing resources.`,
};

export function deployBrief(target: DeployTarget): string {
  return BRIEFS[target];
}

/** Menu items: connected targets are enabled; others point to Settings. */
export function deployItems(connections: CloudConnection[]) {
  return TARGETS.map(target => {
    const connected = connections.some(c => c.provider === target.id && c.connected);
    return { id: target.id, label: target.label, description: connected ? target.description : 'Connect it in Settings → Agents → Cloud sandboxes', icon: 'upload', disabled: !connected };
  });
}
