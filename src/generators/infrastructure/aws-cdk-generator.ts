export function generateAwsCdkInfrastructure(projectName: string): string {
  const camelName = projectName.charAt(0).toUpperCase() + projectName.slice(1);
  return `// --------------------------------------------------------------------------
// AWS CDK: Infraestructura Base para Microservicios
// --------------------------------------------------------------------------
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class ${camelName}InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Mensajería: SNS Topic FIFO para Domain Events
    // ---------------------------------------------------------
    const domainEventsTopic = new sns.Topic(this, 'DomainEventsTopic', {
      topicName: \`\${id}-domain-events.fifo\`,
      displayName: 'Global Domain Events Exchange',
      fifo: true,
      contentBasedDeduplication: true,
    });

    // 2. Dead Letter Queue FIFO
    // ---------------------------------------------------------
    const dlq = new sqs.Queue(this, 'MainDeadLetterQueue', {
      queueName: \`\${id}-dlq.fifo\`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // 3. Cola SQS FIFO para Consumidor (con Retry / DLQ)
    // ---------------------------------------------------------
    const consumerQueue = new sqs.Queue(this, 'ServiceConsumerQueue', {
      queueName: \`\${id}-service-queue.fifo\`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: dlq,
      },
    });

    // Suscripción SNS FIFO -> SQS FIFO con rawMessageDelivery habilitado
    domainEventsTopic.addSubscription(new subscriptions.SqsSubscription(consumerQueue, {
      rawMessageDelivery: true,
    }));

    // 4. Base de Datos DynamoDB (Read Models / Proyecciones)
    // ---------------------------------------------------------
    const readModelTable = new dynamodb.Table(this, 'ReadModelTable', {
      tableName: \`\${id}-read-models\`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Para entornos de producción
    });

    // 5. Clúster EKS Básico (Infraestructura de Cómputo)
    // ---------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'EksVpc', { maxAzs: 2 });
    const cluster = new eks.Cluster(this, 'ServiceCluster', {
      clusterName: \`\${id}-cluster\`,
      vpc,
      defaultCapacity: 2,
      version: eks.KubernetesVersion.V1_29,
    });
  }
}
`;
}

