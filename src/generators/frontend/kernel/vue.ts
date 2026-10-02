/* ==========================================================================
   gherkin-ai-cli - Vue 3 frontend project (Vite, Pinia, Vitest, Vue Test Utils)
   ========================================================================== */

import { DomainModel } from '../../kernel/domain-model';
import { FeFile, renderApiClient, renderApiClientTest } from './client';

export function renderVueProject(m: DomainModel, root = 'frontend'): FeFile[] {
  const first = m.commands[0];
  const f = (p: string) => `${root}/${p}`;
  return [
    {
      filename: f('package.json'),
      content: JSON.stringify({
        name: `${m.kebab}-frontend`, private: true, version: '0.1.0', type: 'module',
        scripts: { dev: 'vite', build: 'vue-tsc --noEmit && vite build', test: 'vitest run' },
        dependencies: { pinia: '^4.0.3', vue: '^3.5.43' },
        devDependencies: {
          '@vitejs/plugin-vue': '^6.0.9', '@vue/test-utils': '^2.5.1', jsdom: '^30.1.1',
          typescript: '~6.0.0', vite: '^8.3.2', vitest: '^5.0.3', 'vue-tsc': '^3.3.12'
        }
      }, null, 2) + '\n'
    },
    {
      filename: f('tsconfig.json'),
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler',
          strict: true, skipLibCheck: true, isolatedModules: true, noEmit: true, jsx: 'preserve', types: ['vitest/globals']
        },
        include: ['src/**/*.ts', 'src/**/*.vue']
      }, null, 2) + '\n'
    },
    {
      filename: f('vite.config.ts'),
      content: `/// <reference types="vitest" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { '/api': process.env.VITE_API_URL ?? 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true }
});
`
    },
    { filename: f('index.html'), content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${m.feature}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n` },
    { filename: f('src/env.d.ts'), content: `/// <reference types="vite/client" />\ndeclare module '*.vue' {\n  import type { DefineComponent } from 'vue';\n  const component: DefineComponent<object, object, unknown>;\n  export default component;\n}\n` },
    { filename: f(`src/api/${m.kebab}-client.ts`), content: renderApiClient(m) },
    { filename: f(`src/api/${m.kebab}-client.test.ts`), content: renderApiClientTest(m, `./${m.kebab}-client`, 'vi') },
    {
      filename: f(`src/stores/${m.kebab}.store.ts`),
      content: `import { defineStore } from 'pinia';
import { ref } from 'vue';
import { CommandName, CommandResult, create${m.pascal}Client, ${m.pascal}Client } from '../api/${m.kebab}-client';

let client: ${m.pascal}Client = create${m.pascal}Client({ baseUrl: import.meta.env.VITE_API_URL ?? '' });

/** Test/composition hook: swap the API client (e.g. a fake in unit tests). */
export function set${m.pascal}Client(next: ${m.pascal}Client): void {
  client = next;
}

export const use${m.pascal}Store = defineStore('${m.camel}', () => {
  const events = ref<CommandResult[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function execute(id: string, command: CommandName, payload?: Record<string, unknown>): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      events.value.push(await client.execute(id, command, payload, { idempotencyKey: crypto.randomUUID() }));
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Request failed';
    } finally {
      loading.value = false;
    }
  }

  return { events, loading, error, execute };
});
`
    },
    {
      filename: f(`src/stores/${m.kebab}.store.test.ts`),
      content: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { set${m.pascal}Client, use${m.pascal}Store } from './${m.kebab}.store';
import type { ${m.pascal}Client } from '../api/${m.kebab}-client';

describe('${m.camel} store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('records the event returned by the backend', async () => {
    const result = { type: '${first.event}', aggregateId: 'agg-1', version: 1 };
    set${m.pascal}Client({ execute: vi.fn().mockResolvedValue(result) } as unknown as ${m.pascal}Client);
    const store = use${m.pascal}Store();

    await store.execute('agg-1', '${first.snake}');

    expect(store.events).toEqual([result]);
    expect(store.error).toBeNull();
  });

  it('keeps the error message when the command fails', async () => {
    set${m.pascal}Client({ execute: vi.fn().mockRejectedValue(new Error('Command id is required')) } as unknown as ${m.pascal}Client);
    const store = use${m.pascal}Store();

    await store.execute('agg-1', '${first.snake}');

    expect(store.error).toBe('Command id is required');
  });
});
`
    },
    {
      filename: f(`src/components/${m.pascal}Panel.vue`),
      content: `<script setup lang="ts">
import { ref } from 'vue';
import { COMMANDS } from '../api/${m.kebab}-client';
import { use${m.pascal}Store } from '../stores/${m.kebab}.store';

const store = use${m.pascal}Store();
const aggregateId = ref('');
</script>

<template>
  <section aria-label="${m.feature}">
    <h1>${m.feature}</h1>
    <label>
      Aggregate id
      <input v-model="aggregateId" data-test="aggregate-id" />
    </label>
    <button
      v-for="command in COMMANDS"
      :key="command"
      :data-test="command"
      :disabled="!aggregateId || store.loading"
      @click="store.execute(aggregateId, command)"
    >
      {{ command }}
    </button>
    <p v-if="store.error" role="alert">{{ store.error }}</p>
    <ul aria-label="events">
      <li v-for="e in store.events" :key="e.aggregateId + '-' + e.version">{{ e.type }} v{{ e.version }}</li>
    </ul>
  </section>
</template>
`
    },
    {
      filename: f(`src/components/${m.pascal}Panel.test.ts`),
      content: `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ${m.pascal}Panel from './${m.pascal}Panel.vue';
import { set${m.pascal}Client } from '../stores/${m.kebab}.store';
import type { ${m.pascal}Client } from '../api/${m.kebab}-client';

describe('${m.pascal}Panel', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('executes a command and lists the resulting event', async () => {
    const execute = vi.fn().mockResolvedValue({ type: '${first.event}', aggregateId: 'agg-1', version: 1 });
    set${m.pascal}Client({ execute } as unknown as ${m.pascal}Client);
    const wrapper = mount(${m.pascal}Panel);

    await wrapper.get('[data-test="aggregate-id"]').setValue('agg-1');
    await wrapper.get('[data-test="${first.snake}"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('${first.event} v1');
    expect(execute).toHaveBeenCalledWith('agg-1', '${first.snake}', undefined, expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it('disables commands until an aggregate id is entered', () => {
    const wrapper = mount(${m.pascal}Panel);
    expect(wrapper.get('[data-test="${first.snake}"]').attributes('disabled')).toBeDefined();
  });
});
`
    },
    {
      filename: f('src/main.ts'),
      content: `import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ${m.pascal}Panel from './components/${m.pascal}Panel.vue';

createApp(${m.pascal}Panel).use(createPinia()).mount('#app');
`
    }
  ];
}
