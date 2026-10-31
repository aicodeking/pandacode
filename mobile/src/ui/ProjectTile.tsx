// A project's tile: its icon from the computer (`projects.icons`, cached) or, without one, the
// coloured initial. Decorative; the row around it names the project.
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { useProjectIcon } from '../store/icons.ts';
import { projectColor } from './theme.ts';

export function ProjectTile({ deviceId, projectId, name, size = 18 }: { deviceId?: string; projectId?: string; name: string; size?: number }) {
  const url = useProjectIcon(deviceId, projectId);
  const box = { width: size, height: size, borderRadius: size * 0.28 };
  if (url) return <Image source={{ uri: url }} style={[styles.tile, box]} contentFit="cover" accessible={false} />;
  return (
    <View style={[styles.tile, box, { backgroundColor: projectColor(name) }]} accessible={false}>
      <Text style={[styles.text, { fontSize: size * 0.6 }]}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous', overflow: 'hidden' },
  text: { color: '#ffffff', fontWeight: '700' },
});
