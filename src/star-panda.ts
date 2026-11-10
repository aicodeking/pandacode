import { PROJECT_LINKS } from './about-settings';
import './star-panda.css';

const description = 'I am sad because people are not starring my repo.. If you like it can you star it, please?';

// CSS gestures must stop even when a focused button survives in a hidden window.
const syncVisibility = () => document.documentElement.toggleAttribute('data-star-panda-hidden', document.hidden);
syncVisibility();
document.addEventListener('visibilitychange', syncVisibility);

let clipId = 0;
/** The brand panda (brand-mark.ts, mobile Panda), downcast and offering a star. Animated groups carry no transform attribute. */
export function starPanda(): string {
  const clip = `star-panda-head-${++clipId}`;
  return `<button type="button" class="star-panda" data-action="open-url" data-url="${PROJECT_LINKS.repository}" aria-label="Star PandaCode on GitHub" data-tip="${description}" aria-description="${description}">
    <svg class="star-panda-art" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <defs><clipPath id="${clip}"><rect x=".5" y="2" width="21" height="15.5" rx="7.75"/></clipPath></defs>
      <rect class="star-panda-belly" x="4" y="13" width="14" height="8" rx="4"/>
      <g class="star-panda-ink">
        <rect x="5.4" y="18.4" width="5" height="3.6" rx="1.8"/>
        <rect x="11.6" y="18.4" width="5" height="3.6" rx="1.8"/>
      </g>
      <g class="star-panda-head">
        <g class="star-panda-ear star-panda-ear-left"><circle class="star-panda-ear-rim" cx="4.6" cy="4.3" r="3.5"/><circle class="star-panda-ink" cx="4.6" cy="4.3" r="3"/></g>
        <g class="star-panda-ear star-panda-ear-right"><circle class="star-panda-ear-rim" cx="17.4" cy="4.3" r="3.5"/><circle class="star-panda-ink" cx="17.4" cy="4.3" r="3"/></g>
        <rect class="star-panda-rim" x="-.1" y="1.4" width="22.2" height="16.7" rx="8.35"/>
        <g clip-path="url(#${clip})">
          <rect class="star-panda-shade" x=".5" y="2" width="21" height="15.5" rx="7.75"/>
          <circle class="star-panda-fur" cx="8.5" cy="7.5" r="11"/>
          <g class="star-panda-eyes">
            <rect class="star-panda-ink" x="3.5" y="6.8" width="5.6" height="7" rx="2.8" transform="rotate(30 6.3 10.3)"/>
            <rect class="star-panda-ink" x="12.9" y="6.8" width="5.6" height="7" rx="2.8" transform="rotate(-30 15.7 10.3)"/>
            <path class="star-panda-lids" d="M3.5 8.7Q6 8.6 8.4 7.1M13.6 7.1q2.4 1.5 4.9 1.6"/>
            <circle class="star-panda-pupil" cx="7.1" cy="11.3" r="1.05"/>
            <circle class="star-panda-pupil" cx="14.9" cy="11.3" r="1.05"/>
            <circle class="star-panda-fur" cx="6.7" cy="10.9" r=".45"/>
            <circle class="star-panda-fur" cx="14.5" cy="10.9" r=".45"/>
          </g>
          <ellipse class="star-panda-blush" cx="3.3" cy="13.8" rx="1.8" ry="1"/>
          <ellipse class="star-panda-blush" cx="18.7" cy="13.8" rx="1.8" ry="1"/>
          <rect class="star-panda-ink" x="9.3" y="12.2" width="3.4" height="1.9" rx=".95"/>
          <path class="star-panda-frown" d="M9.5 15.4q1.5-1.1 3 0"/>
        </g>
      </g>
      <g class="star-panda-offer">
        <path class="star-panda-star" d="M11 15.6l.79 2.11 2.25.1-1.76 1.41.6 2.17L11 20.15l-1.88 1.24.6-2.17-1.76-1.41 2.25-.1Z"/>
        <g class="star-panda-ink">
          <rect x="5.6" y="16.6" width="3.6" height="3.6" rx="1.8"/>
          <rect x="12.8" y="16.6" width="3.6" height="3.6" rx="1.8"/>
        </g>
        <path class="star-panda-glint" d="M11.6 17.5v1.5m-.75-.75h1.5"/>
      </g>
    </svg>
  </button>`;
}
