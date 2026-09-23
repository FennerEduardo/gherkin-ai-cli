// AWS CDK: Base Infrastructure for Microservices
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class TestInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Messaging: SNS FIFO Topic for Domain Events
    // ---------------------------------------------------------
    const domainEventsTopic = new sns.Topic(this, 'DomainEventsTopic', {
      topicName: `${id}-domain-events.fifo`,
      displayName: 'Global Domain Events Exchange',
      fifo: true,
      contentBasedDeduplication: true,
    });

    // 2. Dead Letter Queue FIFO
    // ---------------------------------------------------------
    const dlq = new sqs.Queue(this, 'MainDeadLetterQueue', {
      queueName: `${id}-dlq.fifo`,
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // 3. SQS FIFO Queue for Consumer (with Retry / DLQ)
    // ---------------------------------------------------------
    const consumerQueue = new sqs.Queue(this, 'ServiceConsumerQueue', {
      queueName: `${id}-service-queue.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: dlq,
      },
    });

    domainEventsTopic.addSubscription(new subscriptions.SqsSubscription(consumerQueue, {
      rawMessageDelivery: true,
    }));

    // 4. Base de Datos DynamoDB (Read Models / Proyecciones)
    // ---------------------------------------------------------
    const readModelTable = new dynamodb.Table(this, 'ReadModelTable', {
      tableName: `${id}-read-models`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 5. Secrets Manager: Database Credentials
    // ---------------------------------------------------------
    const dbCredentialsSecret = new secretsmanager.Secret(this, 'DbCredentialsSecret', {
      secretName: `${id}-db-credentials`,
      description: 'Database credentials for the microservice',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dbadmin' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\',
      },
    });

    // 6. Clúster EKS Básico con IAM Roles for Service Accounts (IRSA)
    // ---------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'EksVpc', { maxAzs: 2 });
    const cluster = new eks.Cluster(this, 'ServiceCluster', {
      clusterName: `${id}-cluster`,
      vpc,
      defaultCapacity: 2,
      version: eks.KubernetesVersion.V1_29,
    });

    // Define IAM Role for Kubernetes Service Account (IRSA)
    const serviceAccountRole = new iam.Role(this, 'MicroserviceExecutionRole', {
      assumedBy: new iam.WebIdentityPrincipal(
        cluster.openIdConnectProvider.openIdConnectProviderArn
      ).withConditions({
        StringEquals: new cdk.CfnJson(this, 'ConditionJson', {
          value: {
            [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
            [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: 'system:serviceaccount:default:microservice-sa',
          },
        }),
      }),
    });

    // Grant least-privilege permissions to the IRSA Role
    domainEventsTopic.grantPublish(serviceAccountRole);
    consumerQueue.grantConsumeMessages(serviceAccountRole);
    readModelTable.grantReadWriteData(serviceAccountRole);
    dbCredentialsSecret.grantRead(serviceAccountRole);
  }
}
