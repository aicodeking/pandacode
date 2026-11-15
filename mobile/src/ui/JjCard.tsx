// A task checkout's jj working-copy change (settings.jj), read only: its description, change id,
// bookmarks, file count and conflicts. Nothing when the host lacks settings.jj or the checkout
// isn't a jj repo. Shown on Changes.
import { useCallback } from 'react';
import { useHostAllows } from '../connect/api/capabilities.ts';
import { settingsJj } from '../connect/api/settings.ts';
import { Card, InnerCard, Row } from './ds/index.ts';
import { useLoad } from './hub/common.tsx';
import { Icon } from './Icon.tsx';
import { jjSummary } from './jj-summary.ts';
import { useColors } from './theme.ts';
import { useIconSize } from './usePagePadding.ts';

export function JjCard({ device, session }: { device: string; session: string }) {
  const colors = useColors();
  const iconSize = useIconSize(20);
  const allowed = useHostAllows(device, 'settings.jj');
  const load = useCallback(() => settingsJj(device, { sessionId: session }), [device, session]);
  const { value } = useLoad(allowed && session ? load : null, `${device}/${session}`);
  const summary = jjSummary(value);
  if (!summary) return null;
  return (
    <Card>
      <InnerCard accessible accessibilityLabel={`jj change: ${summary.title}, ${summary.subtitle}`}>
        <Row title={summary.title} subtitle={summary.subtitle}
          leading={<Icon ios={summary.conflict ? 'exclamationmark.triangle' : 'point.3.connected.trianglepath.dotted'} android={summary.conflict ? 'warning' : 'commit'}
            size={iconSize} color={summary.conflict ? colors.danger : colors.muted} />} />
      </InnerCard>
    </Card>
  );
}
