/* ==========================================================================
   gherkin-ai-cli - React Native frontend project (Expo SDK 57, jest-expo, RNTL)
   ========================================================================== */

import { DomainModel } from '../../kernel/domain-model';
import { FeFile, renderApiClient, renderApiClientTest } from './client';

export function renderReactNativeProject(m: DomainModel, root = 'frontend'): FeFile[] {
  const first = m.commands[0];
  const f = (p: string) => `${root}/${p}`;
  return [
    {
      filename: f('package.json'),
      content: JSON.stringify({
        name: `${m.kebab}-mobile`, private: true, version: '0.1.0', main: 'index.ts',
        scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios', build: 'tsc --noEmit', test: 'jest --ci' },
        dependencies: { expo: '~57.0.26', react: '19.2.3', 'react-native': '0.86.3' },
        devDependencies: {
          '@babel/core': '^7.26.0', '@testing-library/react-native': '^13.3.3', 'babel-preset-expo': '~57.0.13', '@types/jest': '^29.5.14', '@types/react': '~19.2.18',
          jest: '~29.7.0', 'jest-expo': '~57.0.5', 'react-test-renderer': '19.2.3', typescript: '~6.0.0'
        },
        // The first test pays React Native's cold transform; keep a generous timeout for CI.
        jest: { preset: 'jest-expo', testTimeout: 60000 }
      }, null, 2) + '\n'
    },
    { filename: f('app.json'), content: JSON.stringify({ expo: { name: m.feature, slug: `${m.kebab}-mobile`, version: '0.1.0' } }, null, 2) + '\n' },
    { filename: f('babel.config.js'), content: `module.exports = function (api) {\n  api.cache(true);\n  return { presets: ['babel-preset-expo'] };\n};\n` },
    { filename: f('tsconfig.json'), content: JSON.stringify({ extends: 'expo/tsconfig.base', compilerOptions: { strict: true, types: ['jest'] } }, null, 2) + '\n' },
    { filename: f(`src/api/${m.kebab}-client.ts`), content: renderApiClient(m) },
    { filename: f(`src/api/${m.kebab}-client.test.ts`), content: renderApiClientTest(m, `./${m.kebab}-client`, 'jest') },
    {
      filename: f(`src/${m.pascal}Screen.tsx`),
      content: `import { useMemo, useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { COMMANDS, CommandName, CommandResult, create${m.pascal}Client, ${m.pascal}Client } from './api/${m.kebab}-client';

const newKey = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

export function ${m.pascal}Screen({ client, baseUrl }: { client?: ${m.pascal}Client; baseUrl?: string }) {
  const api = useMemo(() => client ?? create${m.pascal}Client({ baseUrl }), [client, baseUrl]);
  const [aggregateId, setAggregateId] = useState('');
  const [events, setEvents] = useState<CommandResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(command: CommandName) {
    setLoading(true);
    setError(null);
    try {
      const event = await api.execute(aggregateId, command, undefined, { idempotencyKey: newKey() });
      setEvents(prev => [...prev, event]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View accessibilityLabel=${JSON.stringify(m.feature)}>
      <Text accessibilityRole="header">${m.feature}</Text>
      <TextInput testID="aggregate-id" placeholder="Aggregate id" value={aggregateId} onChangeText={setAggregateId} />
      {COMMANDS.map(command => (
        <Button key={command} testID={command} title={command} disabled={!aggregateId || loading} onPress={() => run(command)} />
      ))}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {events.map(e => (
        <Text key={\`\${e.aggregateId}-\${e.version}\`}>
          {e.type} v{e.version}
        </Text>
      ))}
    </View>
  );
}
`
    },
    {
      filename: f(`src/${m.pascal}Screen.test.tsx`),
      content: `import { fireEvent, render, screen } from '@testing-library/react-native';
import { ${m.pascal}Screen } from './${m.pascal}Screen';
import type { ${m.pascal}Client } from './api/${m.kebab}-client';

describe('${m.pascal}Screen', () => {
  it('executes a command and lists the resulting event', async () => {
    const execute = jest.fn().mockResolvedValue({ type: '${first.event}', aggregateId: 'agg-1', version: 1 });
    render(<${m.pascal}Screen client={{ execute } as unknown as ${m.pascal}Client} />);

    fireEvent.changeText(screen.getByTestId('aggregate-id'), 'agg-1');
    fireEvent.press(screen.getByTestId('${first.snake}'));

    expect(await screen.findByText('${first.event} v1')).toBeTruthy();
    expect(execute).toHaveBeenCalledWith('agg-1', '${first.snake}', undefined, expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it('shows the backend error', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('Command id is required'));
    render(<${m.pascal}Screen client={{ execute } as unknown as ${m.pascal}Client} />);

    fireEvent.changeText(screen.getByTestId('aggregate-id'), 'agg-1');
    fireEvent.press(screen.getByTestId('${first.snake}'));

    expect(await screen.findByText('Command id is required')).toBeTruthy();
  });
});
`
    },
    {
      filename: f('App.tsx'),
      content: `import { ${m.pascal}Screen } from './src/${m.pascal}Screen';

export default function App() {
  return <${m.pascal}Screen baseUrl={process.env.EXPO_PUBLIC_API_URL} />;
}
`
    },
    { filename: f('index.ts'), content: `import { registerRootComponent } from 'expo';\nimport App from './App';\n\nregisterRootComponent(App);\n` }
  ];
}
