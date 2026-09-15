import { describe, it, expect } from 'vitest';
import { validateDotNetCqrs } from '../../../src/core/validators/dotnet-cqrs-validator';

describe('validateDotNetCqrs', () => {
  it('should ignore files if strictLayerBoundaries is not in rules', () => {
    const result = validateDotNetCqrs({
      rules: [],
      files: [
        { path: 'src/Domain/Entity.cs', content: 'using Microsoft.EntityFrameworkCore;' }
      ]
    });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should detect infrastructure imports in Domain layer', () => {
    const result = validateDotNetCqrs({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/Domain/Entity.cs', content: 'using Microsoft.EntityFrameworkCore;' },
        { path: 'src/Domain/User.cs', content: 'using System.Data.SqlClient;' }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]).toContain('Layer violation');
  });

  it('should detect Web API imports in Application layer', () => {
    const result = validateDotNetCqrs({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/Application/Service.cs', content: 'using Microsoft.AspNetCore.Mvc;' }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('AspNetCore');
  });

  it('should warn when Commands return IQueryable', () => {
    const result = validateDotNetCqrs({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/Application/Commands/CreateUserCommand.cs', content: 'public IQueryable<User> Handle()' }
      ]
    });
    expect(result.valid).toBe(true); // It's a warning
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('CQRS Warning');
  });

  it('should error when Queries modify state', () => {
    const result = validateDotNetCqrs({
      rules: ['strictLayerBoundaries'],
      files: [
        { path: 'src/Application/Queries/GetUserQuery.cs', content: 'DbContext.SaveChanges();' }
      ]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('CQRS Violation');
  });
});
