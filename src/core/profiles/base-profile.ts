export interface DomainEvent {
  name: string;
  description: string;
  payloadSchema: Record<string, any>;
}

export interface DomainCommand {
  name: string;
  description: string;
  payloadSchema: Record<string, any>;
}

export interface StateMachineState {
  name: string;
  transitions: string[];
}

export interface RetryPolicy {
  maxRetries: number;
  backoff: 'exponential' | 'fixed';
  dlq: boolean;
  compensation?: string;
}

export interface DomainProfile {
  id: string;
  name: string;
  description: string;
  commonEvents: DomainEvent[];
  commonCommands: DomainCommand[];
  stateMachines?: Record<string, StateMachineState[]>;
  retryPolicies?: Record<string, RetryPolicy>;
  getStandardRules(): string[];
}

export abstract class BaseProfile implements DomainProfile {
  abstract id: string;
  abstract name: string;
  abstract description: string;
  abstract commonEvents: DomainEvent[];
  abstract commonCommands: DomainCommand[];
  abstract stateMachines?: Record<string, StateMachineState[]>;
  abstract retryPolicies?: Record<string, RetryPolicy>;

  getStandardRules(): string[] {
    return [];
  }
}
