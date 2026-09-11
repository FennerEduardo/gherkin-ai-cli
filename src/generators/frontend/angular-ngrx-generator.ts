// --------------------------------------------------------------------------
// Generador Frontend Angular 17+ (NgRx Signal Store & NgRx Classic)
// --------------------------------------------------------------------------

export function generateAngularStoreInfrastructure(featureName: string, mode: 'signals' | 'classic' = 'signals'): string {
  const camelName = featureName.charAt(0).toLowerCase() + featureName.slice(1);
  const pascalName = featureName.charAt(0).toUpperCase() + featureName.slice(1);

  if (mode === 'signals') {
    return `// Angular 17+ NgRx Signal Store Generator (Modern Signals Default)
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { inject, computed } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { pipe, switchMap, tap } from 'rxjs';

export interface ${pascalName}Item {
  id: string;
  name: string;
  status: string;
}

export interface ${pascalName}State {
  items: ${pascalName}Item[];
  loading: boolean;
  error: string | null;
  tenantId: string | null;
}

const initialState: ${pascalName}State = {
  items: [],
  loading: false,
  error: null,
  tenantId: null
};

export const ${pascalName}SignalStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    activeCount: computed(() => store.items().length),
    isLoading: computed(() => store.loading()),
    hasError: computed(() => store.error() !== null)
  })),
  withMethods((store, http = inject(HttpClient)) => ({
    loadItems: rxMethod<void>(
      pipe(
        tap(() => patchState(store, { loading: true, error: null })),
        switchMap(() => {
          const tenant = store.tenantId();
          const headers = tenant ? new HttpHeaders().set('X-Tenant-ID', tenant) : undefined;
          return http.get<${pascalName}Item[]>(\`/api/v1/${camelName}\`, { headers }).pipe(
            tap({
              next: (items) => patchState(store, { items, loading: false }),
              error: (err) => patchState(store, { error: err.message, loading: false })
            })
          );
        })
      )
    ),
    executeCommand(commandData: any, idempotencyKey?: string) {
      patchState(store, { loading: true });
      let headers = new HttpHeaders();
      if (idempotencyKey) {
        headers = headers.set('X-Idempotency-Key', idempotencyKey);
      }
      return http.post(\`/api/v1/${camelName}/commands\`, commandData, { headers }).subscribe({
        next: (res: any) => patchState(store, { loading: false }),
        error: (err) => patchState(store, { error: err.message, loading: false })
      });
    },
    onRealtimeEvent(eventPayload: ${pascalName}Item) {
      patchState(store, { items: [eventPayload, ...store.items()] });
    }
  }))
);
`;
  }

  // Classic NgRx Store (Actions, Reducer, Effects, Selectors)
  return `// Angular Classic NgRx Store (Actions, Reducer, Effects, Selectors)
import { createAction, props, createReducer, on, createFeatureSelector, createSelector } from '@ngrx/store';
import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { map, mergeMap, catchError } from 'rxjs/operators';

// 1. Actions
export const load${pascalName} = createAction('[${pascalName}] Load');
export const load${pascalName}Success = createAction('[${pascalName}] Load Success', props<{ items: any[] }>());
export const load${pascalName}Failure = createAction('[${pascalName}] Load Failure', props<{ error: string }>());

// 2. State & Reducer
export interface ${pascalName}State {
  items: any[];
  loading: boolean;
  error: string | null;
}

export const initialState: ${pascalName}State = {
  items: [],
  loading: false,
  error: null
};

export const ${camelName}Reducer = createReducer(
  initialState,
  on(load${pascalName}, state => ({ ...state, loading: true })),
  on(load${pascalName}Success, (state, { items }) => ({ ...state, items, loading: false })),
  on(load${pascalName}Failure, (state, { error }) => ({ ...state, error, loading: false }))
);

// 3. Effects
@Injectable()
export class ${pascalName}Effects {
  private actions$ = inject(Actions);
  private http = inject(HttpClient);

  loadItems$ = createEffect(() => this.actions$.pipe(
    ofType(load${pascalName}),
    mergeMap(() => this.http.get<any[]>(\`/api/v1/${camelName}\`).pipe(
      map(items => load${pascalName}Success({ items })),
      catchError(error => of(load${pascalName}Failure({ error: error.message })))
    ))
  ));
}

// 4. Selectors
export const select${pascalName}Feature = createFeatureSelector<${pascalName}State>('${camelName}');
export const select${pascalName}Items = createSelector(select${pascalName}Feature, s => s.items);
export const select${pascalName}Loading = createSelector(select${pascalName}Feature, s => s.loading);
`;
}
