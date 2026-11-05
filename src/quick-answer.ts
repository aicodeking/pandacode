import { escape } from './dom.ts';

/** Only explicit binary questions get a fallback; structured questions keep their own controls. */
export function quickAnswerHtml(text: string, messageId: number): string {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/\*\*/g, '');
  if (!/\byes\s*(?:or|\/)\s*no\b\s*\?/i.test(plain)) return '';
  return `<form class="quick-answer" data-answer-message="${messageId}" aria-label="Choose your answer"><fieldset><legend>Choose your answer</legend>${['Yes', 'No'].map(answer => `<label><input type="radio" name="answer-${messageId}" value="${escape(answer)}" required><span>${answer}</span></label>`).join('')}</fieldset><button type="submit" class="secondary-button">Send answer</button></form>`;
}
