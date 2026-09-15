import { describe, it, expect } from 'vitest';
import { validateAngularNgRx } from '../../../src/core/validators/angular-ngrx-validator';

describe('validateAngularNgRx', () => {
  it('should allow valid Angular components', () => {
    const result = validateAngularNgRx({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/app/my.component.ts', content: 'export class MyComponent { constructor(private store: Store) { this.store.dispatch(action()); } }' }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should fail when component injects HttpClient directly', () => {
    const result = validateAngularNgRx({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/app/bad.component.ts', content: 'constructor(private http: HttpClient)' }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Architectural violation');
  });

  it('should warn when service has @Component decorator', () => {
    const result = validateAngularNgRx({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/app/my.service.ts', content: '@Component({ selector: "app-my" }) export class MyService {}' }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Unusual syntax');
  });
});
