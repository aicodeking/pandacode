// Charts from plain Views (the app ships no SVG renderer): bars are columns, lines are rotated
// hairline segments with point dots, area adds faint columns under the line, a pie is a 100 %
// stacked bar with a percentage legend. Colours match the desktop's palette after the tint.
import { useState } from 'react';
import { StyleSheet, Text, View, type ColorValue, type LayoutChangeEvent } from 'react-native';
import type { View as Spec } from '../../store/generative.ts';
import { useColors } from '../theme.ts';

type ChartSpec = Extract<Spec, { type: 'chart' }>;
const PALETTE = ['#5ad19a', '#6aa8ff', '#f0679b', '#ff8a3d', '#a86cf0'];
const HEIGHT = 150;

export function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, e => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/** A polyline as rotated Views inside a box of `width` × `height`. */
export function Line({ values, width, height, color, min, max, dots }: { values: number[]; width: number; height: number; color: ColorValue; min: number; max: number; dots?: boolean }) {
  if (!width || values.length < 2) return null;
  const span = max - min || 1;
  const points = values.map((v, i) => ({ x: (i / (values.length - 1)) * width, y: height - 2 - ((v - min) / span) * (height - 4) }));
  return <>
    {points.slice(1).map((b, i) => {
      const a = points[i], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      return <View key={i} style={[styles.segment, { backgroundColor: color, width: length, left: (a.x + b.x) / 2 - length / 2, top: (a.y + b.y) / 2 - 1, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }]} />;
    })}
    {dots && points.map((p, i) => <View key={`d${i}`} style={[styles.dot, { backgroundColor: color, left: p.x - 3, top: p.y - 3 }]} />)}
  </>;
}

export function Spark({ values, height = 28 }: { values: number[]; height?: number }) {
  const colors = useColors();
  const [width, onLayout] = useWidth();
  return <View onLayout={onLayout} style={{ height }} accessible accessibilityLabel={`Trend from ${values[0]} to ${values[values.length - 1]}`}>
    <Line values={values} width={width} height={height} color={colors.tint} min={Math.min(...values)} max={Math.max(...values)} />
  </View>;
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const colors = useColors();
  const [width, onLayout] = useWidth();
  const color = (s: number) => (s === 0 ? colors.tint : PALETTE[(s - 1) % PALETTE.length]);
  const { labels, series } = spec;
  const label = spec.title ?? `${spec.chart} chart`;
  if (spec.chart === 'sparkline') return <View style={styles.box}>{!!spec.title && <Text style={[styles.title, { color: colors.secondary }]}>{spec.title}</Text>}<Spark values={series[0].values} height={48} /></View>;
  if (spec.chart === 'pie') {
    const values = series[0].values.map(v => Math.max(0, v)), total = values.reduce((a, b) => a + b, 0) || 1;
    return (
      <View style={styles.box} accessible accessibilityLabel={label}>
        {!!spec.title && <Text style={[styles.title, { color: colors.secondary }]}>{spec.title}</Text>}
        <View style={styles.stacked}>{values.map((v, i) => <View key={i} style={{ flex: v, backgroundColor: color(i) }} />)}</View>
        <View style={styles.legend}>{values.map((v, i) => <Key key={i} color={color(i)} text={`${labels[i] ?? ''} · ${Math.round((v / total) * 100)}%`} />)}</View>
      </View>
    );
  }
  const all = series.flatMap(entry => entry.values), max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
  const step = width / labels.length;
  const y = (v: number) => HEIGHT - ((v - min) / span) * HEIGHT;
  const every = Math.ceil(labels.length / 6);
  return (
    <View style={styles.box} accessible accessibilityLabel={label}>
      {!!spec.title && <Text style={[styles.title, { color: colors.secondary }]}>{spec.title}</Text>}
      <View style={styles.row}>
        <View style={[styles.axis, { height: HEIGHT }]}>
          <Text style={[styles.tick, { color: colors.tertiary }]}>{Number(max.toFixed(2)).toLocaleString()}</Text>
          <Text style={[styles.tick, { color: colors.tertiary }]}>{Number(min.toFixed(2)).toLocaleString()}</Text>
        </View>
        <View style={styles.flex}>
          <View onLayout={onLayout} style={[styles.plot, { height: HEIGHT, borderColor: colors.separator }]}>
            {!!width && series.map((entry, s) => {
              if (spec.chart === 'bar') {
                const group = step * 0.72, bar = group / series.length;
                return entry.values.map((v, i) => {
                  const top = y(Math.max(0, v)), bottom = y(Math.min(0, v));
                  return <View key={`${s}-${i}`} style={[styles.bar, { backgroundColor: color(s), left: step * i + (step - group) / 2 + bar * s, width: Math.max(1, bar - 2), top, height: Math.max(1, bottom - top) }]} />;
                });
              }
              const inner = step * (entry.values.length - 1);
              return (
                <View key={s} style={[StyleSheet.absoluteFill, { left: step / 2 }]}>
                  {spec.chart === 'area' && entry.values.map((v, i) => <View key={i} style={[styles.bar, { backgroundColor: color(s), opacity: 0.16, left: step * i - step / 2, width: step, top: y(v), height: HEIGHT - y(v) }]} />)}
                  <Line values={entry.values} width={inner} height={HEIGHT} color={color(s)} min={min} max={max} dots />
                </View>
              );
            })}
          </View>
          <View style={styles.labels}>{labels.map((text, i) => <Text key={i} numberOfLines={1} style={[styles.tick, styles.label, { color: colors.tertiary }]}>{i % every ? '' : text}</Text>)}</View>
        </View>
      </View>
      {series.some(entry => entry.name) && <View style={styles.legend}>{series.map((entry, s) => (entry.name ? <Key key={s} color={color(s)} text={entry.name} /> : null))}</View>}
    </View>
  );
}

function Key({ color, text }: { color: ColorValue; text: string }) {
  const colors = useColors();
  return <View style={styles.key}><View style={[styles.swatch, { backgroundColor: color }]} /><Text style={[styles.tick, { color: colors.secondary }]}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  box: { gap: 6 },
  title: { fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 6 },
  flex: { flex: 1 },
  axis: { justifyContent: 'space-between' },
  plot: { borderBottomWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  bar: { position: 'absolute', borderRadius: 2 },
  segment: { position: 'absolute', height: 2, borderRadius: 1 },
  dot: { position: 'absolute', width: 6, height: 6, borderRadius: 3 },
  labels: { flexDirection: 'row', marginTop: 4 },
  label: { flex: 1, textAlign: 'center' },
  tick: { fontSize: 11 },
  stacked: { flexDirection: 'row', height: 18, borderRadius: 9, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
});
