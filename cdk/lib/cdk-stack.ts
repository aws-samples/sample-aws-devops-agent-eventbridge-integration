import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DevOpsAgentEventBridgeJiraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Parameter: Secrets Manager Secret ARN
    // The secret must contain: jiraBaseUrl, jiraUserEmail, jiraApiToken, jiraProjectKey
    const secretArn = new cdk.CfnParameter(this, 'SecretArn', {
      type: 'String',
      description: 'ARN of the Secrets Manager secret containing Jira credentials (jiraBaseUrl, jiraUserEmail, jiraApiToken, jiraProjectKey)',
    });

    // Reference the existing Secrets Manager secret
    const jiraSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'JiraSecret',
      secretArn.valueAsString
    );

    // DynamoDB Table: Investigation ID to Jira Issue Key mapping
    const mappingTable = new dynamodb.Table(this, 'InvestigationJiraMappingTable', {
      tableName: 'devops-agent-investigation-jira-mapping',
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Lambda function: Jira Issue Creator
    const jiraIssueCreatorFunction = new lambda.Function(this, 'JiraIssueCreatorFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('src/jira-issue-creator'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Creates Jira issues and adds comments for AWS DevOps Agent investigation lifecycle events',
      environment: {
        SECRET_ARN: secretArn.valueAsString,
        MAPPING_TABLE_NAME: mappingTable.tableName,
      },
    });

    // Grant Lambda permission to read the secret
    jiraIssueCreatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretArn.valueAsString],
      })
    );

    // Grant Lambda permission to call DevOps Agent APIs
    jiraIssueCreatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['aidevops:GetBacklogTask', 'aidevops:ListJournalRecords'],
        resources: ['*'],
      })
    );

    // Grant Lambda read/write access to DynamoDB mapping table
    mappingTable.grantReadWriteData(jiraIssueCreatorFunction);

    // EventBridge Rule: Capture all DevOps Agent investigation lifecycle events using prefix match
    const investigationRule = new events.Rule(this, 'DevOpsAgentInvestigationRule', {
      ruleName: 'devops-agent-investigation-jira-issue',
      description: 'Captures all AWS DevOps Agent Investigation lifecycle events and triggers Jira issue creation/comment',
      eventPattern: {
        source: ['aws.aidevops'],
        detailType: [{ prefix: 'Investigation' }] as any,
      },
    });

    // Add Lambda as the target of the EventBridge rule
    investigationRule.addTarget(new targets.LambdaFunction(jiraIssueCreatorFunction));

    // Outputs
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: jiraIssueCreatorFunction.functionName,
      description: 'Name of the Jira Issue Creator Lambda function',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: jiraIssueCreatorFunction.functionArn,
      description: 'ARN of the Jira Issue Creator Lambda function',
    });

    new cdk.CfnOutput(this, 'EventBridgeRuleName', {
      value: investigationRule.ruleName,
      description: 'Name of the EventBridge rule',
    });

    new cdk.CfnOutput(this, 'MappingTableName', {
      value: mappingTable.tableName,
      description: 'Name of the DynamoDB mapping table',
    });
  }
}
