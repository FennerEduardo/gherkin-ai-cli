/* ==========================================================================
   gherkin-ai-cli - Angular frontend project (Angular 22 zoneless, @ngrx/signals, SignalR, Vitest)
   ========================================================================== */

import { DomainModel } from '../../kernel/domain-model';
import { FeFile, renderApiClient, renderApiClientTest } from './client';

export function renderAngularProject(m: DomainModel, root = 'frontend'): FeFile[] {
  const first = m.commands[0];
  const f = (p: string) => `${root}/${p}`;
  const name = `${m.kebab}-frontend`;
  return [
    {
      filename: f('package.json'),
      content: JSON.stringify({
        name, private: true, version: '0.1.0',
        scripts: { build: 'ng build --configuration production', test: 'ng test --watch=false' },
        dependencies: {
          '@angular/common': '^22.2.1', '@angular/compiler': '^22.2.1', '@angular/core': '^22.2.1',
          '@angular/platform-browser': '^22.2.1', '@microsoft/signalr': '^10.0.11', '@ngrx/signals': '^22.0.1',
          rxjs: '~7.8.2', tslib: '^2.8.1'
        },
        devDependencies: {
          '@angular/build': '^22.2.1', '@angular/cli': '^22.2.1', '@angular/compiler-cli': '^22.2.1',
          jsdom: '^30.1.1', typescript: '~6.0.0', vitest: '^5.0.3'
        }
      }, null, 2) + '\n'
    },
    {
      filename: f('angular.json'),
      content: JSON.stringify({
        $schema: './node_modules/@angular/cli/lib/config/schema.json',
        version: 1,
        newProjectRoot: 'projects',
        cli: { analytics: false },
        projects: {
          [name]: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular/build:application',
                options: {
                  outputPath: 'dist',
                  index: 'src/index.html',
                  browser: 'src/main.ts',
                  tsConfig: 'tsconfig.app.json'
                },
                configurations: {
                  production: { outputHashing: 'all', budgets: [{ type: 'initial', maximumWarning: '1mb', maximumError: '2mb' }] },
                  development: { optimization: false, sourceMap: true }
                },
                defaultConfiguration: 'production'
              },
              test: {
                builder: '@angular/build:unit-test',
                options: { tsConfig: 'tsconfig.spec.json', runner: 'vitest', buildTarget: `${name}:build:development` }
              }
            }
          }
        }
      }, null, 2) + '\n'
    },
    {
      filename: f('tsconfig.json'),
      content: JSON.stringify({
        compileOnSave: false,
        compilerOptions: {
          outDir: './dist/out-tsc', strict: true, noImplicitOverride: true, noPropertyAccessFromIndexSignature: false,
          noImplicitReturns: true, skipLibCheck: true, esModuleInterop: true, sourceMap: true, declaration: false,
          experimentalDecorators: true, moduleResolution: 'bundler', importHelpers: true, target: 'ES2022', module: 'ES2022',
          lib: ['ES2022', 'dom']
        },
        angularCompilerOptions: { strictInjectionParameters: true, strictInputAccessModifiers: true, strictTemplates: true }
      }, null, 2) + '\n'
    },
    {
      filename: f('tsconfig.app.json'),
      // Every non-test source is type-checked by `ng build`, not only what main.ts reaches.
      content: JSON.stringify({ extends: './tsconfig.json', compilerOptions: { outDir: './out-tsc/app', types: [] }, files: ['src/main.ts'], include: ['src/**/*.ts'], exclude: ['src/**/*.spec.ts'] }, null, 2) + '\n'
    },
    {
      filename: f('tsconfig.spec.json'),
      content: JSON.stringify({ extends: './tsconfig.json', compilerOptions: { outDir: './out-tsc/spec', types: ['vitest/globals'] }, include: ['src/**/*.spec.ts', 'src/**/*.d.ts'] }, null, 2) + '\n'
    },
    { filename: f('src/index.html'), content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>${m.feature}</title>\n    <base href="/" />\n  </head>\n  <body>\n    <app-root></app-root>\n  </body>\n</html>\n` },
    { filename: f(`src/app/api/${m.kebab}-client.ts`), content: renderApiClient(m) },
    { filename: f(`src/app/api/${m.kebab}-client.spec.ts`), content: renderApiClientTest(m, `./${m.kebab}-client`, 'vi') },
    {
      filename: f('src/app/api/client.token.ts'),
      content: `import { InjectionToken } from '@angular/core';
import { create${m.pascal}Client, ${m.pascal}Client } from './${m.kebab}-client';

/** Swap the API client per environment or in tests. */
export const ${m.snake.toUpperCase()}_CLIENT = new InjectionToken<${m.pascal}Client>('${m.pascal}Client', {
  providedIn: 'root',
  factory: () => create${m.pascal}Client()
});
`
    },
    {
      filename: f(`src/app/state/${m.kebab}.store.ts`),
      content: `import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { CommandName, CommandResult } from '../api/${m.kebab}-client';
import { ${m.snake.toUpperCase()}_CLIENT } from '../api/client.token';

interface ${m.pascal}StateModel {
  events: CommandResult[];
  loading: boolean;
  error: string | null;
}

const newKey = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

export const ${m.pascal}Store = signalStore(
  { providedIn: 'root' },
  withState<${m.pascal}StateModel>({ events: [], loading: false, error: null }),
  withMethods((store, client = inject(${m.snake.toUpperCase()}_CLIENT)) => ({
    async execute(id: string, command: CommandName, payload?: Record<string, unknown>): Promise<void> {
      patchState(store, { loading: true, error: null });
      try {
        const event = await client.execute(id, command, payload, { idempotencyKey: newKey() });
        patchState(store, { events: [...store.events(), event], loading: false });
      } catch (err) {
        patchState(store, { loading: false, error: err instanceof Error ? err.message : 'Request failed' });
      }
    },
    /** Applies an event pushed by the backend (SignalR). */
    receive(event: CommandResult): void {
      patchState(store, { events: [...store.events(), event] });
    }
  }))
);
`
    },
    {
      filename: f(`src/app/state/${m.kebab}.store.spec.ts`),
      content: `import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ${m.pascal}Store } from './${m.kebab}.store';
import { ${m.snake.toUpperCase()}_CLIENT } from '../api/client.token';

describe('${m.pascal}Store', () => {
  function setup(execute: Mock) {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), { provide: ${m.snake.toUpperCase()}_CLIENT, useValue: { execute } }] });
    return TestBed.inject(${m.pascal}Store);
  }

  it('records the event returned by the backend', async () => {
    const result = { type: '${first.event}', aggregateId: 'agg-1', version: 1 };
    const store = setup(vi.fn().mockResolvedValue(result));
    await store.execute('agg-1', '${first.snake}');
    expect(store.events()).toEqual([result]);
    expect(store.error()).toBeNull();
  });

  it('keeps the error message when the command fails', async () => {
    const store = setup(vi.fn().mockRejectedValue(new Error('Command id is required')));
    await store.execute('agg-1', '${first.snake}');
    expect(store.error()).toBe('Command id is required');
  });
});
`
    },
    {
      filename: f('src/app/realtime/realtime.service.ts'),
      content: `import { Injectable, inject, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import type { CommandResult } from '../api/${m.kebab}-client';
import { ${m.pascal}Store } from '../state/${m.kebab}.store';

/** Pushes backend domain events (SignalR hub) into the store. */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly store = inject(${m.pascal}Store);
  private connection?: signalR.HubConnection;
  readonly connected = signal(false);

  async start(hubUrl = '/hubs/domain-events'): Promise<void> {
    this.connection = new signalR.HubConnectionBuilder().withUrl(hubUrl).withAutomaticReconnect().build();
    this.connection.on('ReceiveDomainEvent', (event: CommandResult) => this.store.receive(event));
    await this.connection.start();
    this.connected.set(true);
  }

  async stop(): Promise<void> {
    await this.connection?.stop();
    this.connected.set(false);
  }
}
`
    },
    {
      filename: f(`src/app/${m.kebab}-panel.component.ts`),
      content: `import { Component, inject, signal } from '@angular/core';
import { COMMANDS } from './api/${m.kebab}-client';
import { ${m.pascal}Store } from './state/${m.kebab}.store';

@Component({
  selector: 'app-root',
  standalone: true,
  template: \`
    <section aria-label="${m.feature}">
      <h1>${m.feature}</h1>
      <label>
        Aggregate id
        <input data-test="aggregate-id" [value]="aggregateId()" (input)="aggregateId.set($any($event.target).value)" />
      </label>
      @for (command of commands; track command) {
        <button [attr.data-test]="command" [disabled]="!aggregateId() || store.loading()" (click)="store.execute(aggregateId(), command)">{{ command }}</button>
      }
      @if (store.error()) {
        <p role="alert">{{ store.error() }}</p>
      }
      <ul aria-label="events">
        @for (e of store.events(); track e.aggregateId + '-' + e.version) {
          <li>{{ e.type }} v{{ e.version }}</li>
        }
      </ul>
    </section>
  \`
})
export class ${m.pascal}PanelComponent {
  readonly store = inject(${m.pascal}Store);
  readonly commands = COMMANDS;
  readonly aggregateId = signal('');
}
`
    },
    {
      filename: f(`src/app/${m.kebab}-panel.component.spec.ts`),
      content: `import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ${m.pascal}PanelComponent } from './${m.kebab}-panel.component';
import { ${m.snake.toUpperCase()}_CLIENT } from './api/client.token';

describe('${m.pascal}PanelComponent', () => {
  it('executes a command and lists the resulting event', async () => {
    const execute = vi.fn().mockResolvedValue({ type: '${first.event}', aggregateId: 'agg-1', version: 1 });
    TestBed.configureTestingModule({ imports: [${m.pascal}PanelComponent], providers: [provideZonelessChangeDetection(), { provide: ${m.snake.toUpperCase()}_CLIENT, useValue: { execute } }] });
    const fixture = TestBed.createComponent(${m.pascal}PanelComponent);
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('[data-test="aggregate-id"]');
    input.value = 'agg-1';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-test="${first.snake}"]').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('${first.event} v1');
    expect(execute).toHaveBeenCalledWith('agg-1', '${first.snake}', undefined, expect.objectContaining({ idempotencyKey: expect.any(String) }));
  });

  it('disables commands until an aggregate id is entered', () => {
    TestBed.configureTestingModule({ imports: [${m.pascal}PanelComponent], providers: [provideZonelessChangeDetection(), { provide: ${m.snake.toUpperCase()}_CLIENT, useValue: { execute: vi.fn() } }] });
    const fixture = TestBed.createComponent(${m.pascal}PanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="${first.snake}"]').disabled).toBe(true);
  });
});
`
    },
    {
      filename: f('src/main.ts'),
      content: `import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { ${m.pascal}PanelComponent } from './app/${m.kebab}-panel.component';

bootstrapApplication(${m.pascal}PanelComponent, { providers: [provideZonelessChangeDetection()] }).catch(err => console.error(err));
`
    }
  ];
}
