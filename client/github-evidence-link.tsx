import { useState } from 'react';
import { ExternalLink } from '@getpaseo/plugin/client/ui';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';

// Match the config identity policy without importing server code or URL/DOM APIs.
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
export function GitHubEvidenceLink({ repo, kind, number, url, theme }: {
  repo: string; kind: 'issues' | 'pull'; number: number; url: string; theme: PluginScreenProps['theme'];
}) {
  const [failed, setFailed] = useState(false);
  if (repoPattern.exec(repo)?.[0] !== repo || ['.', '..'].includes(repo.split('/')[1])
    || !Number.isSafeInteger(number) || number <= 0
    || url !== `https://github.com/${repo}/${kind}/${number}`) return null;
  const text = { color: theme.colors.foreground };
  return <View>
    <ExternalLink href={url} accessibilityLabel={`Open ${repo} ${kind === 'issues' ? 'issue' : 'pull request'} ${number} on GitHub`} onError={() => setFailed(true)}>
      <Text style={text}>Open on GitHub</Text>
    </ExternalLink>
    {failed && <Text style={text}>Could not open GitHub. Try again using the link.</Text>}
  </View>;
}
