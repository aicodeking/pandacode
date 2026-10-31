// The Live Activity's SwiftUI layout (Lock Screen banner and Dynamic Island), in Expo UI components.
// The 'widget' directive turns this function into source that runs inside the widget extension, so
// it may use only its props, `environment`, Expo UI and what it declares itself: no imports of our
// own, no module constants, no hooks. Props are a LiveSummary (summary.ts).
import { Circle, HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { activityBackgroundTint, font, foregroundStyle, frame, lineLimit, monospacedDigit, padding, resizable, widgetURL } from '@expo/ui/swift-ui/modifiers';
import type { LiveActivityComponent } from 'expo-widgets';
import type { LiveSummary } from './summary.ts';

export const PandaActivity: LiveActivityComponent<LiveSummary> = (props, environment) => {
  'widget';
  const STATUS = {
    approval: { label: 'Approval', color: '#FFD60A' },
    input: { label: 'Input', color: '#BF5AF2' },
    working: { label: 'Working', color: '#0A84FF' },
    done: { label: 'Done', color: '#30D158' },
    failed: { label: 'Failed', color: '#FF453A' },
  };
  const dim = 'rgba(255,255,255,0.6)';
  const stale = !!environment.isStale;
  const footer = stale ? `Open PandaCode to refresh · ${props.updated}` : null;
  const mark = (size: number) =>
    props.mark
      ? <Image uiImage={props.mark} modifiers={[resizable(), frame({ width: size, height: size })]} />
      : <Image systemName="pawprint.fill" size={size * 0.8} color="#FFFFFF" />;
  const row = (r: LiveSummary['rows'][number], compact: boolean) => (
    <HStack key={r.key} spacing={8}>
      <VStack alignment="leading" spacing={1}>
        <Text modifiers={[font({ size: compact ? 13 : 15, weight: 'semibold' }), foregroundStyle('#FFFFFF'), lineLimit(1)]}>{r.title}</Text>
        {!compact && <Text modifiers={[font({ size: 12 }), foregroundStyle(dim), lineLimit(1)]}>{r.project}</Text>}
      </VStack>
      <Spacer />
      <Text modifiers={[font({ size: compact ? 12 : 13, weight: 'semibold' }), foregroundStyle(stale ? dim : STATUS[r.status].color)]}>{STATUS[r.status].label}</Text>
    </HStack>
  );
  // Compact and minimal: a 'needs you' dot while anything waits, else the running count.
  const count = props.attention
    ? <Circle modifiers={[frame({ width: 10, height: 10 }), foregroundStyle(STATUS.approval.color)]} />
    : <Text modifiers={[font({ size: 14, weight: 'semibold' }), monospacedDigit(), foregroundStyle(STATUS.working.color)]}>{String(props.active)}</Text>;

  return {
    banner: (
      <VStack alignment="leading" spacing={10} modifiers={[padding({ all: 16 }), activityBackgroundTint('#141414'), widgetURL(props.url)]}>
        <HStack spacing={8}>
          {mark(22)}
          <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle('#FFFFFF')]}>PandaCode</Text>
          <Spacer />
          <Text modifiers={[font({ size: 13 }), foregroundStyle(dim), lineLimit(1)]}>{props.headline}</Text>
        </HStack>
        {props.rows.map(r => row(r, false))}
        {footer && <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{footer}</Text>}
      </VStack>
    ),
    compactLeading: <HStack modifiers={[widgetURL(props.url)]}>{mark(20)}</HStack>,
    compactTrailing: count,
    minimal: props.attention ? count : mark(18),
    expandedLeading: (
      <HStack spacing={6} modifiers={[padding({ leading: 4 })]}>
        {mark(22)}
        <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle('#FFFFFF')]}>PandaCode</Text>
      </HStack>
    ),
    expandedTrailing: <Text modifiers={[font({ size: 13 }), foregroundStyle(props.attention ? STATUS.approval.color : dim), padding({ trailing: 4 })]}>{props.attention ? `${props.attention} need you` : `${props.active} active`}</Text>,
    expandedBottom: (
      <VStack alignment="leading" spacing={6} modifiers={[padding({ horizontal: 4, top: 4 })]}>
        {props.rows.slice(0, 3).map(r => row(r, true))}
        {footer && <Text modifiers={[font({ size: 11 }), foregroundStyle(dim)]}>{footer}</Text>}
      </VStack>
    ),
  };
};
