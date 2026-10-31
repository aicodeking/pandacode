// A native menu picker (SwiftUI Picker on iOS, Compose on Android) via @expo/ui.
import { Host, Picker } from '@expo/ui';
import { memo } from 'react';
import { useColorScheme } from 'react-native';

export interface Option { value: string; label: string }

export const Choice = memo(function Choice({ value, options, onChange, enabled = true }: { value: string; options: Option[]; onChange: (value: string) => void; enabled?: boolean }) {
  const scheme = useColorScheme();
  const items = options.some(o => o.value === value) ? options : [{ value, label: value || '—' }, ...options];
  return (
    <Host matchContents colorScheme={scheme ?? undefined}>
      <Picker appearance="menu" selectedValue={value} onValueChange={v => onChange(String(v))} enabled={enabled}>
        {items.map(o => <Picker.Item key={o.value} label={o.label} value={o.value} />)}
      </Picker>
    </Host>
  );
});
