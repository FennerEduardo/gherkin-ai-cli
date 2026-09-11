import { BaseProfile, DomainEvent, DomainCommand, StateMachineState, RetryPolicy } from './base-profile';

export class PaymentProfile extends BaseProfile {
  id = 'payments';
  name = 'Payment Platform Profile';
  description = 'Ecosistema de microservicios distribuido y orientado a eventos para procesar transacciones de pago con arquitectura CQRS.';

  commonEvents: DomainEvent[] = [
    {
      name: 'PaymentInitiated',
      description: 'El pago ha sido iniciado y está pendiente de autorización.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' } } }
    },
    {
      name: 'PaymentAuthorized',
      description: 'El pago ha sido autorizado por el proveedor.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, authorizationCode: { type: 'string' } } }
    },
    {
      name: 'PaymentCompleted',
      description: 'El pago ha sido capturado y liquidado exitosamente.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, settlementId: { type: 'string' } } }
    },
    {
      name: 'PaymentFailed',
      description: 'El pago falló en alguna etapa del ciclo de vida.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' }, reason: { type: 'string' }, errorCode: { type: 'string' } } }
    }
  ];

  commonCommands: DomainCommand[] = [
    {
      name: 'InitiatePayment',
      description: 'Inicia el proceso de pago.',
      payloadSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, source: { type: 'string' }, destination: { type: 'string' } } }
    },
    {
      name: 'AuthorizePayment',
      description: 'Autoriza el pago contra el proveedor externo.',
      payloadSchema: { type: 'object', properties: { paymentId: { type: 'string' } } }
    },
    {
      name: 'CapturePayment',
      description: 'Captura los fondos autorizados previamente.',
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
