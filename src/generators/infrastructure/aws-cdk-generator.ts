/* ==========================================================================
   gherkin-ai-cli - AWS CDK app (opt-in: infrastructure.awsCdk)

   A complete, synthesizable CDK v2 app in ./infrastructure:
     bin/app.ts, lib/<project>-stack.ts, cdk.json, tsconfig.json, package.json
     test/stack.test.ts (aws-cdk-lib/assertions, run with node --test)
   Resources: SNS FIFO domain-event topic -> SQS FIFO consumer queue with a
   DLQ (maxReceiveCount 3) and a CloudWatch alarm on DLQ depth, DynamoDB read
   models (PITR, retained), a Secrets Manager database secret, and an EKS
   cluster whose service account gets least-privilege access through IRSA.
   Verified by the aws-cdk golden build (npm test + cdk synth).
   ========================================================================== */

import { toKebab, toPascal } from '../../utils/naming';

export interface CdkFile {
  filename: string;
  content: string;
}

const KUBERNETES_MINOR = '35';
export const CDK_VERSIONS = {
  'aws-cdk-lib': '^2.272.0',
  'aws-cdk': '^2.1144.0',
  constructs: '^10.8.1',
  [`@aws-cdk/lambda-layer-kubectl-v${KUBERNETES_MINOR}`]: '^2.2.2'
};

export function generateAwsCdkInfrastructure(projectName: string): string {
  const stackClass = `${toPascal(projectName)}InfrastructureStack`;
  return `import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { KubectlV${KUBERNETES_MINOR}Layer } from '@aws-cdk/lambda-layer-kubectl-v${KUBERNETES_MINOR}';

export interface ${stackClass}Props extends cdk.StackProps {
  /** Kubernetes namespace of the service account. */
  readonly namespace?: string;
}

export class ${stackClass} extends cdk.Stack {
  readonly domainEventsTopic: sns.Topic;
  readonly consumerQueue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly readModelTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ${stackClass}Props = {}) {
    super(scope, id, props);

    // Domain events: SNS FIFO topic fanned out to an SQS FIFO consumer queue.
    this.domainEventsTopic = new sns.Topic(this, 'DomainEventsTopic', {
      fifo: true,
      contentBasedDeduplication: true,
      displayName: 'Domain events'
    });

    // Messages that fail three times land in the DLQ and raise an alarm.
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true
    });
    this.consumerQueue = new sqs.Queue(this, 'ConsumerQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      enforceSSL: true,
      deadLetterQueue: { maxReceiveCount: 3, queue: this.deadLetterQueue }
    });
    this.domainEventsTopic.addSubscription(new subscriptions.SqsSubscription(this.consumerQueue, { rawMessageDelivery: true }));

    new cloudwatch.Alarm(this, 'DeadLetterQueueAlarm', {
      alarmDescription: 'Messages are failing and accumulating in the dead-letter queue.',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Read models / projections.
    this.readModelTable = new dynamodb.Table(this, 'ReadModelTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const databaseSecret = new secretsmanager.Secret(this, 'DatabaseCredentials', {
      description: 'Database credentials for the service',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'app' }),
        generateStringKey: 'password',
        excludePunctuation: true
      }
    });

    // EKS cluster; the service account gets AWS permissions through IRSA (no node-wide credentials).
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });
    const cluster = new eks.Cluster(this, 'Cluster', {
      vpc,
      version: eks.KubernetesVersion.V1_${KUBERNETES_MINOR},
      kubectlLayer: new KubectlV${KUBERNETES_MINOR}Layer(this, 'KubectlLayer'),
      defaultCapacity: 2,
      defaultCapacityInstance: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)
    });
    const serviceAccount = cluster.addServiceAccount('ServiceAccount', {
      name: '${toKebab(projectName)}',
      namespace: props.namespace ?? 'default'
    });

    // Least privilege: publish events, consume the queue, read/write read models, read the DB secret.
    this.domainEventsTopic.grantPublish(serviceAccount);
    this.consumerQueue.grantConsumeMessages(serviceAccount);
    this.readModelTable.grantReadWriteData(serviceAccount);
    databaseSecret.grantRead(serviceAccount);

    new cdk.CfnOutput(this, 'DomainEventsTopicArn', { value: this.domainEventsTopic.topicArn });
    new cdk.CfnOutput(this, 'ConsumerQueueUrl', { value: this.consumerQueue.queueUrl });
    new cdk.CfnOutput(this, 'ServiceAccountRoleArn', { value: serviceAccount.role.roleArn });
  }
}
`;
}

/** Every file of the CDK app, relative to the project root. */
export function generateAwsCdkApp(projectName: string): CdkFile[] {
  const kebab = toKebab(projectName);
  const stackClass = `${toPascal(projectName)}InfrastructureStack`;
  const stackModule = `../lib/${kebab}-stack`;
  const pkg = {
    name: `${kebab}-infrastructure`,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'tsc --noEmit',
      test: 'node --import tsx --test test/*.test.ts',
      synth: 'cdk synth --quiet',
      diff: 'cdk diff',
      deploy: 'cdk deploy'
    },
    dependencies: {
      'aws-cdk-lib': CDK_VERSIONS['aws-cdk-lib'],
      constructs: CDK_VERSIONS.constructs,
      [`@aws-cdk/lambda-layer-kubectl-v${KUBERNETES_MINOR}`]: CDK_VERSIONS[`@aws-cdk/lambda-layer-kubectl-v${KUBERNETES_MINOR}`]
    },
    devDependencies: {
      'aws-cdk': CDK_VERSIONS['aws-cdk'],
      '@types/node': '^22.0.0',
      tsx: '^4.20.0',
      typescript: '~6.0.0'
    }
  };
  return [
    { filename: 'infrastructure/package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
    {
      filename: 'infrastructure/cdk.json',
      content: JSON.stringify({
        app: 'npx tsx bin/app.ts',
        context: { '@aws-cdk/core:newStyleStackSynthesis': true }
      }, null, 2) + '\n'
    },
    {
      filename: 'infrastructure/tsconfig.json',
      content: JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, skipLibCheck: true, types: ['node'], noEmit: true },
        include: ['bin/**/*.ts', 'lib/**/*.ts', 'test/**/*.ts']
      }, null, 2) + '\n'
    },
    {
      filename: 'infrastructure/bin/app.ts',
      content: `import * as cdk from 'aws-cdk-lib';
import { ${stackClass} } from '${stackModule}';

const app = new cdk.App();
// Environment-agnostic by default; set CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION (or a profile) to deploy.
new ${stackClass}(app, '${toPascal(projectName)}', {
  env: process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION } : undefined
});
`
    },
    { filename: `infrastructure/lib/${kebab}-stack.ts`, content: generateAwsCdkInfrastructure(projectName) },
    {
      filename: 'infrastructure/test/stack.test.ts',
      content: `import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ${stackClass} } from '${stackModule}';

const template = Template.fromStack(new ${stackClass}(new cdk.App(), 'Test'));

test('domain events fan out from an SNS FIFO topic to an SQS FIFO queue', () => {
  template.hasResourceProperties('AWS::SNS::Topic', { FifoTopic: true, ContentBasedDeduplication: true });
  template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'sqs', RawMessageDelivery: true });
});

test('failed messages go to a dead-letter queue after three attempts and raise an alarm', () => {
  template.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
});

test('read models are retained and recoverable', () => {
  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({ BillingMode: 'PAY_PER_REQUEST', PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })
  });
});

test('the service account role is assumed through the cluster OIDC provider (IRSA)', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Action: 'sts:AssumeRoleWithWebIdentity' })])
    })
  });
});
`
    }
  ];
}
