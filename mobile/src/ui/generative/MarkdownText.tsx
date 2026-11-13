// Native Markdown (react-native-enriched-markdown, md4c) for replies and generative UI bodies.
// Images never reach the native renderer (it would fetch remote ones): workspace paths draw as
// ReplyImage thumbnails, anything with a scheme becomes a link (replyParts in src/store/attachments.ts).
import { createContext, memo, use, useMemo } from 'react';
import { Linking } from 'react-native';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { replyParts } from '../../store/attachments.ts';
import { ReplyImage } from '../Attachments.tsx';
import { type as textStyle } from '../ds/index.ts';
import { mono, useColors } from '../theme.ts';

const open = ({ url }: { url: string }) => { if (/^https?:\/\//i.test(url)) void Linking.openURL(url); };

function useStyle(): MarkdownStyle {
  const colors = useColors();
  return useMemo(() => {
    const text = colors.text;
    return {
      paragraph: { fontSize: textStyle.callout.fontSize, lineHeight: textStyle.callout.lineHeight, color: text, marginBottom: 8 },
      h1: { fontSize: textStyle.title3.fontSize, fontWeight: '600', color: text }, h2: { fontSize: textStyle.headline.fontSize, fontWeight: '600', color: text }, h3: { fontSize: textStyle.calloutMedium.fontSize, fontWeight: '500', color: text },
      list: { fontSize: textStyle.callout.fontSize, lineHeight: textStyle.callout.lineHeight, color: text },
      // Every field set: the renderer's defaults for inline code are a red label and outline.
      code: { fontFamily: mono, fontSize: textStyle.code.fontSize, color: text, backgroundColor: colors.fill, borderColor: colors.chipBorder },
      codeBlock: { fontFamily: mono, fontSize: textStyle.code.fontSize, lineHeight: textStyle.code.lineHeight, backgroundColor: colors.fill, borderColor: colors.chipBorder, borderRadius: 10, padding: 10, color: text },
      link: { color: colors.tint, underline: false },
    };
  }, [colors]);
}

/** A row's extra item for the selection menu of all Markdown inside it: the transcript's "Copy reply". */
export interface MarkdownMenuItem { text: string; icon?: string; onPress: () => void }
/** The selection menu's own item, plus any after it (a reply's Fork from here). */
export const MarkdownMenuContext = createContext<(MarkdownMenuItem & { more?: readonly MarkdownMenuItem[] }) | null>(null);

/** Markdown text with its workspace images drawn as thumbnails. */
export const Body = memo(function Body({ text, streaming }: { text: string; streaming?: boolean }) {
  const style = useStyle();
  const menu = use(MarkdownMenuContext);
  const menuItems = useMemo(() => (menu ? [menu, ...(menu.more ?? [])].map(item => ({ text: item.text, icon: item.icon, onPress: item.onPress })) : undefined), [menu]);
  const parts = useMemo(() => replyParts(text), [text]);
  const body = (markdown: string, key?: number) => <EnrichedMarkdownText key={key} markdown={markdown} markdownStyle={style} flavor="github" onLinkPress={open} selectable contextMenuItems={menuItems} streamingAnimation={streaming} />;
  if (parts.length === 1 && parts[0].kind === 'text') return body(parts[0].text);
  return <>{parts.map((part, i) => (part.kind === 'text' ? body(part.text, i) : <ReplyImage key={i} alt={part.alt} path={part.path} />))}</>;
});
