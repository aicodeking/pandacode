// Native Markdown (react-native-enriched-markdown, md4c) for replies and generative UI bodies.
// Images never reach the native renderer (it would fetch remote ones): workspace paths draw as
// ReplyImage thumbnails, anything with a scheme becomes a link (replyParts in src/store/attachments.ts).
import { memo, useMemo } from 'react';
import { Linking, Platform, useColorScheme } from 'react-native';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { replyParts } from '../../store/attachments.ts';
import { ReplyImage } from '../Attachments.tsx';
import { mono } from '../theme.ts';

const open = ({ url }: { url: string }) => { if (/^https?:\/\//i.test(url)) void Linking.openURL(url); };

function useStyle(): MarkdownStyle {
  const dark = useColorScheme() === 'dark';
  return useMemo(() => {
    const ios = Platform.OS === 'ios';
    const text = ios ? (dark ? '#ffffff' : '#000000') : dark ? '#e6e0e9' : '#1d1b20';
    const codeBg = dark ? '#2a2a2e' : '#f1f1f4';
    return {
      paragraph: { fontSize: 16, lineHeight: 22, color: text, marginBottom: 8 },
      h1: { fontSize: 22, fontWeight: '700', color: text }, h2: { fontSize: 19, fontWeight: '700', color: text }, h3: { fontSize: 17, fontWeight: '600', color: text },
      list: { fontSize: 16, lineHeight: 22, color: text },
      code: { fontFamily: mono, fontSize: 14, backgroundColor: codeBg },
      codeBlock: { fontFamily: mono, fontSize: 13, lineHeight: 18, backgroundColor: codeBg, borderRadius: 10, padding: 10, color: text },
      link: { color: ios ? (dark ? '#0a84ff' : '#007aff') : dark ? '#d0bcff' : '#6750a4', underline: false },
    };
  }, [dark]);
}

/** Markdown text with its workspace images drawn as thumbnails. */
export const Body = memo(function Body({ text, streaming }: { text: string; streaming?: boolean }) {
  const style = useStyle();
  const parts = useMemo(() => replyParts(text), [text]);
  const body = (markdown: string, key?: number) => <EnrichedMarkdownText key={key} markdown={markdown} markdownStyle={style} flavor="github" onLinkPress={open} selectable streamingAnimation={streaming} />;
  if (parts.length === 1 && parts[0].kind === 'text') return body(parts[0].text);
  return <>{parts.map((part, i) => (part.kind === 'text' ? body(part.text, i) : <ReplyImage key={i} alt={part.alt} path={part.path} />))}</>;
});
