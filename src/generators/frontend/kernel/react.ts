/* ==========================================================================
   gherkin-ai-cli - React frontend project (Vite, Redux Toolkit, Vitest, RTL)
   ========================================================================== */

import { DomainModel } from '../../kernel/domain-model';
import { FeFile, renderApiClient, renderApiClientTest } from './client';

const pkg = (name: string, extra: Record<string, unknown>) => JSON.stringify({ name, private: true, version: '0.1.0', type: 'module', ...extra }, null, 2) + '\n';

export function renderReactProject(m: DomainModel, root = 'frontend'): FeFile[] {
  const first = m.commands[0];
  const f = (p: string) => `${root}/${p}`;
  return [
    {
      filename: f('package.json'),
      content: pkg(`${m.kebab}-frontend`, {
        scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', test: 'vitest run' },
        dependencies: { '@reduxjs/toolkit': '^2.13.0', react: '^19.3.0', 'react-dom': '^19.3.0', 'react-redux': '^9.3.0' },
        devDependencies: {
          '@testing-library/dom': '^10.4.2', '@testing-library/jest-dom': '^7.0.1', '@testing-library/react': '^16.3.3',
          '@testing-library/user-event': '^14.6.7', '@types/react': '^19.3.0', '@types/react-dom': '^19.3.0',
          '@vitejs/plugin-react': '^6.1.1', jsdom: '^30.1.1', typescript: '~6.0.0', vite: '^8.3.2', vitest: '^5.0.3'
        }
      })
    },
    {
      filename: f('tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler',
          jsx: 'react-jsx', strict: true, skipLibCheck: true, isolatedModules: true, noEmit: true,
          types: ['vitest/globals', '@testing-library/jest-dom']
        },
        include: ['src']
      }, null, 2) + '\n'
    },
    {
      filename: f('vite.config.ts'),
      content: `/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.VITE_API_URL ?? 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/setupTests.ts'] }
});
`
    },
    { filename: f('index.html'), content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${m.feature}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n` },
    { filename: f('src/setupTests.ts'), content: `import '@testing-library/jest-dom/vitest';\n` },
    { filename: f(`src/api/${m.kebab}-client.ts`), content: renderApiClient(m) },
    { filename: f(`src/api/${m.kebab}-client.test.ts`), content: renderApiClientTest(m, `./${m.kebab}-client`, 'vi') },
    {
      filename: f(`src/store/${m.camel}Slice.ts`),
      content: `import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { CommandName, CommandResult, create${m.pascal}Client, ${m.pascal}Client } from '../api/${m.kebab}-client';

export interface ${m.pascal}State {
  events: CommandResult[];
  status: 'idle' | 'loading' | 'failed';
  error: string | null;
}

const initialState: ${m.pascal}State = { events: [], status: 'idle', error: null };

export interface ExecuteArgs {
  id: string;
  command: CommandName;
  payload?: Record<string, unknown>;
}

export const executeCommand = createAsyncThunk<CommandResult, ExecuteArgs, { extra: { client: ${m.pascal}Client } }>(
  '${m.camel}/execute',
  ({ id, command, payload }, { extra }) => extra.client.execute(id, command, payload, { idempotencyKey: crypto.randomUUID() })
);

const ${m.camel}Slice = createSlice({
  name: '${m.camel}',
  initialState,
  reducers: {},
  extraReducers: builder => {
    builder
      .addCase(executeCommand.pending, state => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(executeCommand.fulfilled, (state, action) => {
        state.status = 'idle';
        state.events.push(action.payload);
      })
      .addCase(executeCommand.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.error.message ?? 'Request failed';
      });
  }
});

export const ${m.camel}Reducer = ${m.camel}Slice.reducer;
export const defaultClient = () => create${m.pascal}Client({ baseUrl: import.meta.env.VITE_API_URL ?? '' });
`
    },
    {
      filename: f('src/store/store.ts'),
      content: `import { configureStore } from '@reduxjs/toolkit';
import { ${m.pascal}Client } from '../api/${m.kebab}-client';
import { defaultClient, ${m.camel}Reducer } from './${m.camel}Slice';

export function createAppStore(client: ${m.pascal}Client = defaultClient()) {
  return configureStore({
    reducer: { ${m.camel}: ${m.camel}Reducer },
    middleware: getDefault => getDefault({ thunk: { extraArgument: { client } } })
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
`
    },
    {
      filename: f(`src/store/${m.camel}Slice.test.ts`),
      content: `import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from './store';
import { executeCommand } from './${m.camel}Slice';
import type { ${m.pascal}Client } from '../api/${m.kebab}-client';

describe('${m.camel} slice', () => {
  it('records the event returned by the backend', async () => {
    const result = { type: '${first.event}', aggregateId: 'agg-1', version: 1 };
    const client = { execute: vi.fn().mockResolvedValue(result) } as unknown as ${m.pascal}Client;
    const store = createAppStore(client);

    await store.dispatch(executeCommand({ id: 'agg-1', command: '${first.snake}' }));

    expect(store.getState().${m.camel}).toEqual({ events: [result], status: 'idle', error: null });
  });

  it('keeps the error message when the command fails', async () => {
    const client = { execute: vi.fn().mockRejectedValue(new Error('Command id is required')) } as unknown as ${m.pascal}Client;
    const store = createAppStore(client);

    await store.dispatch(executeCommand({ id: 'agg-1', command: '${first.snake}' }));

    expect(store.getState().${m.camel}.status).toBe('failed');
    expect(store.getState().${m.camel}.error).toBe('Command id is required');
  });
});
`
    },
    {
      filename: f(`src/components/${m.pascal}Panel.tsx`),
      content: `import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { COMMANDS } from '../api/${m.kebab}-client';
import type { AppDispatch, RootState } from '../store/store';
import { executeCommand } from '../store/${m.camel}Slice';

export function ${m.pascal}Panel() {
  const dispatch = useDispatch<AppDispatch>();
  const { events, status, error } = useSelector((s: RootState) => s.${m.camel});
  const [aggregateId, setAggregateId] = useState('');

  return (
    <section aria-label="${m.feature}">
      <h1>${m.feature}</h1>
      <label>
        Aggregate id
        <input value={aggregateId} onChange={e => setAggregateId(e.target.value)} />
      </label>
      {COMMANDS.map(command => (
        <button key={command} disabled={!aggregateId || status === 'loading'} onClick={() => dispatch(executeCommand({ id: aggregateId, command }))}>
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
      filename: f(`src/components/${m.pascal}Panel.test.tsx`),
      content: `import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { createAppStore } from '../store/store';
import { ${m.pascal}Panel } from './${m.pascal}Panel';
import type { ${m.pascal}Client } from '../api/${m.kebab}-client';

describe('${m.pascal}Panel', () => {
  it('executes a command and lists the resulting event', async () => {
    const client = { execute: vi.fn().mockResolvedValue({ type: '${first.event}', aggregateId: 'agg-1', version: 1 }) } as unknown as ${m.pascal}Client;
    render(
      <Provider store={createAppStore(client)}>
        <${m.pascal}Panel />
      </Provider>
    );

    await userEvent.type(screen.getByLabelText('Aggregate id'), 'agg-1');
    await userEvent.click(screen.getByRole('button', { name: '${first.snake}' }));

    expect(await screen.findByText('${first.event} v1')).toBeInTheDocument();
    expect(client.execute).toHaveBeenCalledWith('agg-1', '${first.snake}', undefined, expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it('disables commands until an aggregate id is entered', () => {
    render(
      <Provider store={createAppStore({ execute: vi.fn() } as unknown as ${m.pascal}Client)}>
        <${m.pascal}Panel />
      </Provider>
    );
    expect(screen.getByRole('button', { name: '${first.snake}' })).toBeDisabled();
  });
});
`
    },
    {
      filename: f('src/main.tsx'),
      content: `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { ${m.pascal}Panel } from './components/${m.pascal}Panel';
import { createAppStore } from './store/store';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={createAppStore()}>
      <${m.pascal}Panel />
    </Provider>
  </StrictMode>
);
`
    },
    { filename: f('src/vite-env.d.ts'), content: `/// <reference types="vite/client" />\n` }
  ];
}
