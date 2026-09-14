import { BaseProfile, DomainEvent, DomainCommand, StateMachineState, RetryPolicy } from './base-profile';

export class PaymentProfile extends BaseProfile {
  id = 'payments';
  name = 'Payment Platform Profile';
  description = 'Event-driven distributed microservices ecosystem for processing payment transactions with CQRS architecture.';

  commonEvents: DomainEvent[] = [
    {
      name: 'PaymentInitiated',
      description: 'Payment has been initiated and is pending authorization.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' } } }
    },
    {
      name: 'PaymentAuthorized',
      description: 'Payment has been authorized by the provider.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, authorizationCode: { type: 'string' } } }
    },
    {
      name: 'PaymentCompleted',
      description: 'Payment has been captured and settled successfully.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, settlementId: { type: 'string' } } }
    },
    {
      name: 'PaymentFailed',
      description: 'Payment failed at some stage of the lifecycle.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, reason: { type: 'string' }, errorCode: { type: 'string' } } }
    }
  ];

  commonCommands: DomainCommand[] = [
    {
      name: 'InitiatePayment',
      description: 'Initiates the payment process.',
      payloadSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, source: { type: 'string' }, destination: { type: 'string' } } }
    },
    {
      name: 'AuthorizePayment',
      description: 'Authorizes the payment against the external provider.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' } } }
    },
    {
      name: 'CapturePayment',
      description: 'Captures the previously authorized funds.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' } } }
    }
  ];

  stateMachines: Record<string, StateMachineState[]> = {
    PaymentLifecycle: [
      { name: 'Pending', transitions: ['Authorized', 'Failed'] },
      { name: 'Authorized', transitions: ['Completed', 'Failed', 'Refunded'] },
      { name: 'Completed', transitions: ['Refunded'] },
      { name: 'Failed', transitions: [] },
      { name: 'Refunded', transitions: [] }
    ]
  };

  retryPolicies: Record<string, RetryPolicy> = {
    Authorization: { maxRetries: 3, backoff: 'exponential', dlq: true, compensation: 'CancelAuthorization' },
    NotificationEmail: { maxRetries: 5, backoff: 'exponential', dlq: true, compensation: 'Reprocess' },
    WebhookB2B: { maxRetries: 8, backoff: 'exponential', dlq: true, compensation: 'ManualReplay' },
    Reconciliation: { maxRetries: 3, backoff: 'fixed', dlq: true, compensation: 'OperationalReview' }
  };

  getStandardRules(): string[] {
    return [
      'pci-dss-compliance',
      'idempotency-required',
      'transactional-outbox-mandatory',
      'saga-orchestration-mandatory'
    ];
  }
}
