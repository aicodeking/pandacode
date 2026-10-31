// An agent reply: Markdown (generative/MarkdownText.tsx) with PandaCode's generative UI drawn
// natively: ```ui/```chart/```svg/```html/```mermaid fences and followup chips
// (generativeParts in src/store/generative.ts). Memoized by source, so a row only re-splits
// when its text changes.
import { memo, useMemo } from 'react';
import { generativeParts } from '../store/generative.ts';
import { GenerativeBlock } from './generative/Block.tsx';
import { Chips } from './generative/common.tsx';
import { Body } from './generative/MarkdownText.tsx';

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const parts = useMemo(() => generativeParts(text), [text]);
  if (parts.length === 1 && parts[0].kind === 'text') return <Body text={parts[0].text} streaming={streaming} />;
  return <>{parts.map((part, i) => (
    part.kind === 'text' ? <Body key={i} text={part.text} streaming={streaming} />
      : part.kind === 'chips' ? <Chips key={i} options={part.options} />
        : <GenerativeBlock key={i} lang={part.lang} source={part.source} pending={part.pending} />
  ))}</>;
});
