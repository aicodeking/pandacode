// Settings → Wallpaper: the desktop's controls (docs/wallpapers.md). On/off, Automatic or one
// day's set, a pinned scene from the thumbnail strip, and visibility and blur sliders.
import { Host, Slider } from '@expo/ui';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, useColorScheme, View, type ColorValue } from 'react-native';
import { setWallpaper, THUMBNAILS, useBackdrop, useWallpaper } from './Backdrop.tsx';
import { Icon } from './Icon.tsx';
import { PHONE_DEFAULTS, sceneIds, wallpaperAt, wallpaperPeriods, wallpaperSets } from './wallpaper.ts';

const SETS = [{ id: 'automatic', label: 'Automatic' }, ...wallpaperSets] as const;
const label = (id: string) => {
  const [day, period] = id.split('-');
  return `${wallpaperSets.find(d => d.id === day)?.label.slice(0, 3)} ${wallpaperPeriods.find(p => p.id === period)?.label.toLowerCase()}`;
};

export function WallpaperSettings() {
  const colors = useBackdrop();
  const { preferences, reduceTransparency } = useWallpaper();
  const on = preferences.enabled && preferences.visibility > 0;
  const current = wallpaperAt(new Date(), preferences);
  return (
    <>
      <View style={styles.row}>
        <Text style={[styles.value, { color: colors.text }]}>Daily wallpaper</Text>
        <Switch value={on} onValueChange={enabled => setWallpaper({ enabled, visibility: preferences.visibility || PHONE_DEFAULTS.visibility })} />
      </View>
      {reduceTransparency && <Text style={[styles.small, { color: colors.secondary }]}>Hidden while Reduce Transparency is on.</Text>}
      {on && <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {SETS.map(set => {
            const selected = preferences.set === set.id && !preferences.pinned;
            return (
              <Pressable key={set.id} onPress={() => setWallpaper({ set: set.id, pinned: null })} accessibilityRole="button" accessibilityState={{ selected }}
                style={[styles.chip, { backgroundColor: selected ? colors.tint : colors.fill }]}>
                <Text style={[styles.chipText, { color: selected ? colors.onTint : colors.text }]}>{set.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
          {sceneIds.map(id => {
            const pinned = preferences.pinned === id;
            return (
              <Pressable key={id} onPress={() => setWallpaper({ pinned: pinned ? null : id })} accessibilityRole="button"
                accessibilityLabel={label(id)} accessibilityHint={pinned ? 'Resumes the rotation' : 'Keeps this scene'} accessibilityState={{ selected: pinned }} style={styles.scene}>
                <Image source={THUMBNAILS[id]} style={[styles.thumb, { borderColor: id === current ? colors.tint : 'transparent' }]} contentFit="cover" />
                <View style={styles.caption}>
                  {pinned && <Icon ios="pin.fill" android="push_pin" size={10} color={colors.tint} />}
                  <Text style={[styles.small, { color: id === current ? colors.text : colors.secondary }]}>{label(id)}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        <Labeled title="Visibility" value={`${preferences.visibility}%`} color={colors.text} muted={colors.secondary}>
          <NativeSlider value={preferences.visibility} max={100} onChange={visibility => setWallpaper({ visibility })} />
        </Labeled>
        <Labeled title="Blur" value={`${preferences.blur} px`} color={colors.text} muted={colors.secondary}>
          <NativeSlider value={preferences.blur} max={24} onChange={blur => setWallpaper({ blur })} />
        </Labeled>
      </>}
    </>
  );
}

function Labeled({ title, value, color, muted, children }: { title: string; value: string; color: ColorValue; muted: ColorValue; children: ReactNode }) {
  return (
    <View style={styles.slider}>
      <View style={styles.row}>
        <Text style={[styles.value, { color }]}>{title}</Text>
        <Text style={[styles.value, { color: muted }]}>{value}</Text>
      </View>
      {children}
    </View>
  );
}

function NativeSlider({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  const scheme = useColorScheme();
  return (
    <Host matchContents={{ vertical: true }} colorScheme={scheme ?? undefined} style={styles.host}>
      <Slider value={value} min={0} max={max} step={1} onValueChange={v => onChange(Math.round(v))} />
    </Host>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  value: { fontSize: 17 },
  small: { fontSize: 12 },
  strip: { gap: 8 },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 14, fontWeight: '500' },
  scene: { gap: 4, alignItems: 'center' },
  thumb: { width: 96, height: 60, borderRadius: 10, borderWidth: 2 },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  slider: { gap: 4 },
  host: { width: '100%' },
});
