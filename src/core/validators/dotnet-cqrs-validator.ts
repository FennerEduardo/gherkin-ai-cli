export interface ValidatorContext {
  files: { path: string; content: string }[];
  rules: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateDotNetCqrs(context: ValidatorContext): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };
  
  if (!context.rules.includes('strictLayerBoundaries')) {
    return result;
  }

  context.files.filter(f => f.path.endsWith('.cs')).forEach(file => {
    const isDomain = file.path.includes('Domain/');
    const isApplication = file.path.includes('Application/');
    const isInfrastructure = file.path.includes('Infrastructure/');
    const isApi = file.path.includes('Api/') || file.path.includes('Controllers/');

    if (isDomain) {
      if (file.content.includes('using Microsoft.EntityFrameworkCore;') || file.content.includes('using System.Data.SqlClient;')) {
        result.valid = false;
        result.errors.push(`Violación de capa / Layer violation: La capa de dominio (${file.path}) no debe depender de infraestructura o bases de datos / The domain layer must not depend on infrastructure or databases.`);
      }
    }

    if (isApplication) {
      if (file.content.includes('using Microsoft.AspNetCore.Mvc;')) {
        result.valid = false;
        result.errors.push(`Violación de capa / Layer violation: La capa de aplicación (${file.path}) no debe depender de la API Web (AspNetCore) / The application layer must not depend on Web API (AspNetCore).`);
      }
      
      const isCommand = file.path.includes('Commands/');
      const isQuery = file.path.includes('Queries/');
      
      if (isCommand && file.content.includes('IQueryable')) {
        result.warnings.push(`Advertencia CQRS / CQRS Warning: Un Command (${file.path}) no debería devolver consultas IQueryable directamente / A Command should not return IQueryable queries directly.`);
      }
      
      if (isQuery && file.content.includes('DbContext.SaveChanges') || (isQuery && file.content.includes('Update('))) {
        result.valid = false;
        result.errors.push(`Violación CQRS / CQRS Violation: Una Query (${file.path}) no debe modificar estado (SaveChanges/Update) / A Query must not modify state (SaveChanges/Update).`);
      }
    }
  });

  return result;
}
