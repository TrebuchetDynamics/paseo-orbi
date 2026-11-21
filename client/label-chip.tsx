import { Text, View } from 'react-native';
import { labelForeground, type LabelPresentation } from '../shared/issues';

// GitHub-style label chips: wrapping pills with the repository's literal label
// name over its validated color. The name always carries the meaning; color is
// presentation only, and the foreground is contrast-derived from the fill.
export function LabelChips({ labels }: { labels: LabelPresentation[] | undefined }) {
  if (!labels?.length) return null;
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
    {labels.map(label => <View key={label.name} testID="orbi-label-chip"
      style={{ backgroundColor: label.color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: labelForeground(label.color), fontSize: 12 }}>{label.name}</Text>
    </View>)}
  </View>;
}
