import fs from 'fs';
import yaml from 'yaml';
import { SpecificationIR } from './semantic-ir';

export interface OpenAPIValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  specVersion: string;
}

export function validateOpenAPISpec(specPath: string): OpenAPIValidationResult {
  const result: OpenAPIValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    specVersion: ''
  };

  try {
    const content = fs.readFileSync(specPath, 'utf8');
    let doc: any;
    
    if (specPath.endsWith('.json')) {
      doc = JSON.parse(content);
    } else {
      doc = yaml.parse(content);
    }

    if (!doc) {
      result.errors.push({ path: '$', message: 'Empty or invalid OpenAPI document' });
      return result;
    }

    // Basic OpenAPI structural validation
    result.specVersion = doc.openapi || doc.swagger || 'unknown';
    if (result.specVersion === 'unknown') {
      result.errors.push({ path: '$', message: 'Missing "openapi" or "swagger" version field' });
    }

    if (!doc.info || !doc.info.title || !doc.info.version) {
      result.errors.push({ path: '$.info', message: 'Missing required "info.title" or "info.version"' });
    }

    if (!doc.paths) {
      result.errors.push({ path: '$.paths', message: 'Missing required "paths" object' });
    }

    result.valid = result.errors.length === 0;
    return result;
  } catch (e: any) {
    result.errors.push({ path: '$', message: `Parse error: ${e.message}` });
    return result;
  }
}

export function validateOpenAPIAgainstIR(specPath: string, ir: SpecificationIR): OpenAPIValidationResult {
  const baseResult = validateOpenAPISpec(specPath);
  if (!baseResult.valid) {
    return baseResult;
  }

  const content = fs.readFileSync(specPath, 'utf8');
  const doc = specPath.endsWith('.json') ? JSON.parse(content) : yaml.parse(content);
  
  // 1. Verify endpoints from IR exist in OpenAPI
  for (const endpoint of ir.apiEndpoints) {
    const method = endpoint.method.toLowerCase();
    const path = endpoint.path;

    const oaPath = doc.paths?.[path] || findMatchingPath(doc.paths, path);
    if (!oaPath) {
      baseResult.errors.push({ 
        path: `$.paths['${path}']`, 
        message: `Endpoint ${endpoint.method} ${path} defined in IR is missing from OpenAPI` 
      });
      continue;
    }

    const oaOperation = oaPath[method];
    if (!oaOperation) {
      baseResult.errors.push({ 
        path: `$.paths['${path}'].${method}`, 
        message: `Method ${endpoint.method} for ${path} defined in IR is missing from OpenAPI` 
      });
      continue;
    }

    // 2. Verify HTTP Codes
    if (endpoint.httpCodes && endpoint.httpCodes.length > 0) {
      for (const codeObj of endpoint.httpCodes) {
        if (!oaOperation.responses || !oaOperation.responses[codeObj.code]) {
          baseResult.errors.push({
            path: `$.paths['${path}'].${method}.responses['${codeObj.code}']`,
            message: `IR defines HTTP ${codeObj.code} (${codeObj.description}), but it is missing in OpenAPI`
          });
        }
      }
    }

    // 3. Verify Request Fields (if any)
    if (endpoint.requestFields && endpoint.requestFields.length > 0 && ['post', 'put', 'patch'].includes(method)) {
      const requestBody = oaOperation.requestBody;
      if (!requestBody) {
        baseResult.warnings.push({
          path: `$.paths['${path}'].${method}.requestBody`,
          message: `IR defines request fields but OpenAPI is missing a requestBody`
        });
      }
    }
  }

  // 4. Verify that auth requirements match
  for (const endpoint of ir.apiEndpoints) {
    if (endpoint.authRequired) {
      const method = endpoint.method.toLowerCase();
      const path = endpoint.path;
      const oaPath = doc.paths?.[path] || findMatchingPath(doc.paths, path);
      if (oaPath && oaPath[method]) {
        const security = oaPath[method].security || doc.security;
        if (!security || security.length === 0) {
          baseResult.warnings.push({
            path: `$.paths['${path}'].${method}.security`,
            message: `Endpoint ${endpoint.method} ${path} requires auth in IR, but no security scheme is applied in OpenAPI`
          });
        }
      }
    }
  }

  baseResult.valid = baseResult.errors.length === 0;
  return baseResult;
}

// Helper to handle path parameter differences (e.g., /users/{id} vs /users/:id)
function findMatchingPath(pathsObj: any, searchPath: string): any | undefined {
  if (!pathsObj) return undefined;
  
  // Normalize parameters
  const normalizedSearch = searchPath.replace(/\{[^}]+\}/g, '{}').replace(/:[^/]+/g, '{}');
  
  for (const p of Object.keys(pathsObj)) {
    const normalizedP = p.replace(/\{[^}]+\}/g, '{}').replace(/:[^/]+/g, '{}');
    if (normalizedP === normalizedSearch) {
      return pathsObj[p];
    }
  }
  
  return undefined;
}
