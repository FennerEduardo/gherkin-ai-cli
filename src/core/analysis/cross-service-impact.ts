/* ==========================================================================
   gherkin-ai-cli - Cross-Service Impact & Blast Radius Analyzer
   ========================================================================== */

import { SpecificationIR } from '../semantic-ir';

export type ImpactRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AffectedComponent {
  type: 'OPENAPI_ENDPOINT' | 'ASYNCAPI_EVENT' | 'DTO_CONTRACT' | 'DB_SCHEMA';
  name: string;
  detail: string;
}

export interface ImpactAnalysisResult {
  riskLevel: ImpactRiskLevel;
  affectedComponents: AffectedComponent[];
  requiresHumanApproval: boolean;
  summary: string;
}

export class CrossServiceImpactAnalyzer {
  /**
   * Analyzes potential cross-service impact and blast radius from a Specification IR or proposed file changes
   */
  public analyzeImpact(ir: SpecificationIR, changedFiles: string[] = []): ImpactAnalysisResult {
    const affected: AffectedComponent[] = [];
    let isCritical = false;
    let isHigh = false;

    // 1. Analyze Contracts in Specification IR
    if (ir.contracts) {
      for (const contract of ir.contracts) {
        if (contract.type === 'REST') {
          affected.push({
            type: 'OPENAPI_ENDPOINT',
            name: `${contract.method || 'POST'} ${contract.endpoint || '/' + contract.entity.toLowerCase()}`,
            detail: `REST Endpoint contract for entity ${contract.entity}`
          });
        } else if (contract.type === 'EVENT') {
          affected.push({
            type: 'ASYNCAPI_EVENT',
            name: contract.endpoint || `${contract.entity.toLowerCase()}.event`,
            detail: `AsyncAPI event channel contract for entity ${contract.entity}`
          });
          isHigh = true; // Event contracts affect external subscriber services
        }
      }
    }

    // 2. Check for database or core contract file modifications
    for (const file of changedFiles) {
      const normalized = file.toLowerCase();
      if (normalized.includes('schema.prisma') || normalized.includes('migration') || normalized.includes('.sql')) {
        affected.push({
          type: 'DB_SCHEMA',
          name: file,
          detail: 'Database schema migration or structural change'
        });
        isCritical = true;
      }
      if (normalized.includes('openapi') || normalized.includes('asyncapi')) {
        affected.push({
          type: 'DTO_CONTRACT',
          name: file,
          detail: 'Public API contract specification modified'
        });
        isHigh = true;
      }
    }

    let riskLevel: ImpactRiskLevel = 'LOW';
    if (isCritical || affected.length > 5) {
      riskLevel = 'CRITICAL';
    } else if (isHigh || affected.length > 2) {
      riskLevel = 'HIGH';
    } else if (affected.length > 0) {
      riskLevel = 'MEDIUM';
    }

    const requiresHumanApproval = riskLevel === 'CRITICAL' || riskLevel === 'HIGH';

    return {
      riskLevel,
      affectedComponents: affected,
      requiresHumanApproval,
      summary: `Impact Analysis: Risk level [${riskLevel}]. ${affected.length} affected contract/service component(s).`
    };
  }
}
