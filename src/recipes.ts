/* Workflow recipes: pick a saved recipe, see a dry run against this task's harness, then
 * queue its steps as ordinary messages. Recipes are plain JSON (`.pandacode/recipes/<name>.json`
 * in the project, or the global folder); the native side (`recipes.rs`) validates, saves and
 * resolves them. The host supplies the task and the queue, so this module imports no app state. */
import './recipes.css';
import { escape } from './dom';
import { t } from './i18n.ts';

export interface RecipeStep { kind: 'prompt' | 'slash' | 'check' | 'approval'; text?: string; command?: string; requires?: string[] }
export interface Recipe { name: string; description: string; steps: RecipeStep[]; scope?: 'project' | 'global' }
export interface StepReport { index: number; status: 'supported' | 'fallback' | 'manual' | 'blocked'; reason: string }
export interface RecipePlan { steps: StepReport[]; messages: string[] }

export interface RecipesHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  projectId: string;
  provider: string;
  /** Command names (with the leading /) the task's harness offers. */
  slashCommands(): Promise<string[]>;
  /** Queues one message for the task; called once per step, in order. */
  enqueue(text: string): Promise<void>;
  /** Called after a run is queued. */
  done?(count: number): void;
}

const LABEL: Record<StepReport['status'], string> = { supported: t('Supported'), fallback: t('Fallback'), manual: t('Manual'), blocked: t('Blocked') };
const summary = (step: RecipeStep) => (step.kind === 'slash' ? step.command : step.text) ?? '';
const NEW_RECIPE: Recipe = { name: 'my-recipe', description: '', steps: [{ kind: 'prompt', text: 'Review the changed files.' }, { kind: 'check', text: 'npm test' }, { kind: 'approval', text: 'Ready to commit?' }] };

export function mountRecipes(root: HTMLElement, host: RecipesHost): void {
  let recipes: Recipe[] = [];
  let selected: Recipe | null = null;
  let plan: RecipePlan | null = null;
  let editing: string | null = null;
  let message = '';
  let busy = false;

  const rowFor = (recipe: Recipe) => `<li><button type="button" class="recipe-pick" data-recipe="${escape(recipe.name)}" aria-pressed="${recipe.name === selected?.name}"><b>${escape(recipe.name)}</b><span>${escape(recipe.description)}</span><i>${recipe.scope === 'global' ? t('Global') : t('Project')}</i></button></li>`;

  function detail(): string {
    if (editing !== null) {
      return `<textarea class="recipe-json" aria-label="${t('Recipe JSON')}" spellcheck="false">${escape(editing)}</textarea>
        <div class="recipe-actions"><button type="button" class="secondary-button" data-action="recipe-cancel">${t('Cancel')}</button><button type="button" class="primary-button" data-action="recipe-save">${t('Save')}</button></div>`;
    }
    if (!selected) return `<p class="recipe-empty">${t('Choose a recipe, or create one.')}</p>`;
    const rows = selected.steps.map((step, i) => {
      const report = plan?.steps[i];
      return `<tr><td>${i + 1}</td><td>${escape(step.kind)}</td><td class="recipe-text">${escape(summary(step))}</td><td>${report ? `<span class="recipe-status" data-status="${report.status}">${LABEL[report.status]}</span>` : ''}</td><td class="recipe-reason">${escape(report?.reason ?? '')}</td></tr>`;
    }).join('');
    const blocked = !plan || plan.steps.some(s => s.status === 'blocked');
    return `<h3>${escape(selected.name)}</h3><p class="recipe-description">${escape(selected.description)}</p>
      <table class="recipe-steps" aria-label="${t`Dry run for ${escape(selected.name)}`}"><thead><tr><th>#</th><th>${t('Step')}</th><th>${t('What')}</th><th>${t('Status')}</th><th>${t('Why')}</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="recipe-actions"><button type="button" class="secondary-button" data-action="recipe-delete">${t('Delete')}</button><button type="button" class="secondary-button" data-action="recipe-edit">${t('Edit')}</button><button type="button" class="primary-button" data-action="recipe-run" ${blocked || busy ? 'disabled' : ''}>${t('Run')}</button></div>`;
  }

  function draw(): void {
    root.innerHTML = `<section class="recipes" aria-label="${t('Workflow recipes')}"><div class="recipe-list"><ul>${recipes.map(rowFor).join('')}</ul><button type="button" class="secondary-button" data-action="recipe-new">${t('New recipe')}</button></div>
      <div class="recipe-detail">${detail()}<p class="recipe-message" role="status">${escape(message)}</p></div></section>`;
  }

  async function dryRun(recipe: Recipe): Promise<void> {
    selected = recipe; plan = null; editing = null; message = ''; draw();
    try {
      plan = await host.call<RecipePlan>('recipes_dry_run', { recipe, provider: host.provider, slash: await host.slashCommands() });
    } catch (error) { message = String(error); }
    draw();
  }

  async function reload(pick?: string): Promise<void> {
    recipes = await host.call<Recipe[]>('recipes_list', { projectId: host.projectId });
    const next = recipes.find(r => r.name === (pick ?? selected?.name));
    if (next) await dryRun(next); else { selected = null; plan = null; draw(); }
  }

  root.addEventListener('click', async event => {
    const target = event.target as HTMLElement;
    const pick = target.closest<HTMLElement>('[data-recipe]');
    if (pick) { const recipe = recipes.find(r => r.name === pick.dataset.recipe); if (recipe) await dryRun(recipe); return; }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'recipe-new') { editing = JSON.stringify(NEW_RECIPE, null, 2); selected = null; message = ''; draw(); }
      else if (action === 'recipe-edit' && selected) { editing = JSON.stringify({ name: selected.name, description: selected.description, steps: selected.steps }, null, 2); message = ''; draw(); }
      else if (action === 'recipe-cancel') { editing = null; draw(); }
      else if (action === 'recipe-save') {
        const recipe = JSON.parse(root.querySelector<HTMLTextAreaElement>('.recipe-json')!.value) as Recipe;
        await host.call('recipes_save', { projectId: host.projectId, scope: selected?.scope ?? 'project', recipe });
        editing = null; await reload(recipe.name); message = t('Saved.'); draw();
      } else if (action === 'recipe-delete' && selected) {
        await host.call('recipes_delete', { projectId: host.projectId, scope: selected.scope ?? 'project', name: selected.name });
        selected = null; message = t('Deleted.'); await reload(); message = t('Deleted.'); draw();
      } else if (action === 'recipe-run' && plan && !busy) {
        busy = true; draw();
        const messages = plan.messages;
        for (const text of messages) await host.enqueue(text);
        busy = false; message = messages.length === 1 ? t`Queued ${messages.length} message.` : t`Queued ${messages.length} messages.`; draw();
        host.done?.(messages.length);
      }
    } catch (error) { busy = false; message = error instanceof SyntaxError ? t`Not valid JSON: ${error.message}` : String(error); draw(); }
  });

  void reload().catch(error => { message = String(error); draw(); });
  draw();
}
