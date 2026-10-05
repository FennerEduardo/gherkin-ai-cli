/* ==========================================================================
   gherkin-ai-cli - Next.js frontend project (Next 16 App Router, Vitest, RTL)
   ========================================================================== */

import { DomainModel } from '../../kernel/domain-model';
import { FeFile, renderApiClient, renderApiClientTest } from './client';

export function renderNextProject(m: DomainModel, root = 'frontend'): FeFile[] {
  const first = m.commands[0];
  const f = (p: string) => `${root}/${p}`;
  return [
    {
      filename: f('package.json'),
      content: JSON.stringify({
        name: `${m.kebab}-frontend`, private: true, version: '0.1.0',
        scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'vitest run' },
        dependencies: { next: '^16.3.8', react: '^19.3.0', 'react-dom': '^19.3.0' },
        devDependencies: {
          '@testing-library/dom': '^10.4.2', '@testing-library/jest-dom': '^7.0.1', '@testing-library/react': '^16.3.3',
          '@testing-library/user-event': '^14.6.7', '@types/node': '^24.0.0', '@types/react': '^19.3.0', '@types/react-dom': '^19.3.0',
          '@vitejs/plugin-react': '^6.1.1', jsdom: '^30.1.1', typescript: '~6.0.0', vitest: '^5.0.3'
        }
      }, null, 2) + '\n'
    },
    {
      filename: f('tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2022', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: false, skipLibCheck: true, strict: true, noEmit: true,
          esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true,
          jsx: 'preserve', incremental: true, plugins: [{ name: 'next' }], types: ['vitest/globals']
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules']
      }, null, 2) + '\n'
    },
    {
      filename: f('next.config.mjs'),
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy API calls to the backend in development (set API_URL in other environments).
  async rewrites() {
    return [{ source: '/api/:path*', destination: \`\${process.env.API_URL ?? 'http://localhost:3000'}/api/:path*\` }];
  }
};

export default nextConfig;
`
    },
    {
      filename: f('vitest.config.mts'),
      content: `import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['./vitest.setup.ts'] }
});
`
    },
    { filename: f('vitest.setup.ts'), content: `import '@testing-library/jest-dom/vitest';\n` },
    { filename: f(`lib/${m.kebab}-client.ts`), content: renderApiClient(m) },
    { filename: f(`lib/${m.kebab}-client.test.ts`), content: renderApiClientTest(m, `./${m.kebab}-client`, 'vi') },
    {
      filename: f('app/layout.tsx'),
      content: `import type { ReactNode } from 'react';

export const metadata = { title: ${JSON.stringify(m.feature)} };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`
    },
    {
      filename: f('app/page.tsx'),
      content: `import { ${m.pascal}Panel } from '../components/${m.pascal}Panel';

export default function Page() {
  return <${m.pascal}Panel />;
}
`
    },
    {
      filename: f(`components/${m.pascal}Panel.tsx`),
      content: `'use client';

import { useMemo, useState } from 'react';
import { COMMANDS, CommandName, CommandResult, create${m.pascal}Client, ${m.pascal}Client } from '../lib/${m.kebab}-client';

export function ${m.pascal}Panel({ client }: { client?: ${m.pascal}Client }) {
  const api = useMemo(() => client ?? create${m.pascal}Client(), [client]);
  const [aggregateId, setAggregateId] = useState('');
  const [events, setEvents] = useState<CommandResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(command: CommandName) {
    setLoading(true);
    setError(null);
    try {
      const event = await api.execute(aggregateId, command, undefined, { idempotencyKey: crypto.randomUUID() });
      setEvents(prev => [...prev, event]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label=${JSON.stringify(m.feature)}>
      <h1>${m.feature}</h1>
      <label>
        Aggregate id
        <input value={aggregateId} onChange={e => setAggregateId(e.target.value)} />
      </label>
      {COMMANDS.map(command => (
        <button key={command} disabled={!aggregateId || loading} onClick={() => run(command)}>
          {command}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
      <ul aria-label="events">
        {events.map(e => (
          <li key={\`\${e.aggregateId}-\${e.version}\`}>
            {e.type} v{e.version}
          </li>
        ))}
      </ul>
    </section>
  );
}
`
    },
    {
      filename: f(`components/${m.pascal}Panel.test.tsx`),
      content: `import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ${m.pascal}Panel } from './${m.pascal}Panel';
import type { ${m.pascal}Client } from '../lib/${m.kebab}-client';

describe('${m.pascal}Panel', () => {
  it('executes a command and lists the resulting event', async () => {
    const execute = vi.fn().mockResolvedValue({ type: '${first.event}', aggregateId: 'agg-1', version: 1 });
    render(<${m.pascal}Panel client={{ execute } as unknown as ${m.pascal}Client} />);

    await userEvent.type(screen.getByLabelText('Aggregate id'), 'agg-1');
    await userEvent.click(screen.getByRole('button', { name: '${first.snake}' }));

    expect(await screen.findByText('${first.event} v1')).toBeInTheDocument();
  });

  it('shows the backend error', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('Command id is required'));
    render(<${m.pascal}Panel client={{ execute } as unknown as ${m.pascal}Client} />);

    await userEvent.type(screen.getByLabelText('Aggregate id'), 'agg-1');
    await userEvent.click(screen.getByRole('button', { name: '${first.snake}' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Command id is required');
  });
});
`
    }
  ];
}
