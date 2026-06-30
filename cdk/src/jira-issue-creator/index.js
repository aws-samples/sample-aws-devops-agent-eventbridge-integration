// Jira Issue Creator / Comment Lambda Function
// This Lambda function is triggered by EventBridge for all AWS DevOps Agent
// investigation lifecycle events:
//   - Investigation Created: Creates a Jira Issue and saves mapping to DynamoDB
//   - All other events: Adds a comment to the existing Jira Issue

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { DevOpsAgentClient, GetBacklogTaskCommand, ListJournalRecordsCommand } = require('@aws-sdk/client-devops-agent');
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');

// Emoji and label mapping for each event type
const EVENT_CONFIG = {
  'Investigation Created': { emoji: '🆕', label: 'Investigation Created' },
  'Investigation Priority Updated': { emoji: '🔀', label: 'Investigation Priority Updated' },
  'Investigation In Progress': { emoji: '🔄', label: 'Investigation In Progress' },
  'Investigation Completed': { emoji: '✅', label: 'Investigation Completed' },
  'Investigation Failed': { emoji: '❌', label: 'Investigation Failed' },
  'Investigation Timed Out': { emoji: '⏰', label: 'Investigation Timed Out' },
  'Investigation Cancelled': { emoji: '🚫', label: 'Investigation Cancelled' },
  'Investigation Pending Triage': { emoji: '⏳', label: 'Investigation Pending Triage' },
  'Investigation Linked': { emoji: '🔗', label: 'Investigation Linked' },
  'Investigation Skipped': { emoji: '⏭️', label: 'Investigation Skipped' },
};

exports.handler = async (event) => {
  console.log('Jira Issue Creator Lambda invoked');
  console.log('EventBridge event:', JSON.stringify(event, null, 2));

  const detailType = event['detail-type'] || '';
  console.log('Event detail-type:', detailType);

  // Retrieve Jira credentials from Secrets Manager
  const jiraCredentials = await getJiraCredentials();

  // Extract metadata from EventBridge event
  const detail = event.detail || {};
  const metadata = detail.metadata || {};
  const data = detail.data || {};

  const agentSpaceId = metadata.agent_space_id || '';
  const taskId = metadata.task_id || '';
  const executionId = metadata.execution_id || '';
  const priority = data.priority || 'MEDIUM';
  const status = data.status || '';
  const taskType = data.task_type || 'INVESTIGATION';
  const summaryRecordId = data.summary_record_id || '';
  const timestamp = event.time || new Date().toISOString();
  const region = event.region || process.env.AWS_REGION || 'ap-northeast-1';
  const account = event.account || 'unknown';

  // Route: Investigation Created -> create issue, everything else -> add comment
  if (detailType === 'Investigation Created') {
    return await handleInvestigationCreated({
      jiraCredentials,
      agentSpaceId,
      taskId,
      executionId,
      priority,
      status,
      taskType,
      timestamp,
      region,
      account,
    });
  }

  // All other investigation events -> add comment to existing issue
  return await handleInvestigationEvent({
    jiraCredentials,
    detailType,
    agentSpaceId,
    taskId,
    executionId,
    priority,
    status,
    taskType,
    summaryRecordId,
    timestamp,
    region,
    account,
  });
};

/**
 * Handle Investigation Created: Create Jira Issue + save mapping to DynamoDB
 */
async function handleInvestigationCreated(params) {
  const { jiraCredentials, agentSpaceId, taskId, executionId, priority, status, taskType, timestamp, region, account } = params;

  // Call DevOps Agent GetBacklogTask API to get task details
  let taskTitle = `Investigation ${taskId}`;
  let taskDescription = '';

  if (agentSpaceId && taskId) {
    try {
      const devopsAgentClient = new DevOpsAgentClient({ region });
      const getTaskCommand = new GetBacklogTaskCommand({
        agentSpaceId: agentSpaceId,
        taskId: taskId,
      });
      const taskResponse = await devopsAgentClient.send(getTaskCommand);
      const task = taskResponse.task || {};

      taskTitle = task.title || taskTitle;
      taskDescription = task.description || '';

      console.log('Successfully retrieved task details from DevOps Agent API:', {
        title: taskTitle,
        taskType: task.taskType || taskType,
      });
    } catch (error) {
      console.warn('Failed to retrieve task details from DevOps Agent API, using event data:', error.message);
    }
  }

  // Build Jira issue
  const summary = `[DevOps Agent] ${taskTitle}`;
  const description = buildDescription({
    taskTitle,
    taskDescription,
    taskId,
    executionId,
    agentSpaceId,
    taskType,
    priority,
    status,
    timestamp,
    region,
    account,
  });

  // Create Jira issue
  const issueData = await createJiraIssue(jiraCredentials, summary, description);

  // Save mapping to DynamoDB
  await saveMapping(taskId, issueData.key, agentSpaceId);

  console.log(`Investigation Created: Jira issue ${issueData.key} created and mapping saved`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Jira issue created successfully',
      issueKey: issueData.key,
      issueId: issueData.id,
      issueUrl: `${jiraCredentials.jiraBaseUrl}/browse/${issueData.key}`,
    }),
  };
}

/**
 * Handle all investigation lifecycle events (except Created): Add comment to existing Jira Issue
 */
async function handleInvestigationEvent(params) {
  const { jiraCredentials, detailType, agentSpaceId, taskId, executionId, priority, status, taskType, summaryRecordId, timestamp, region } = params;

  // Look up Jira Issue Key from DynamoDB
  const issueKey = await getIssueKeyFromMapping(taskId);
  if (!issueKey) {
    console.warn(`No Jira issue mapping found for taskId: ${taskId}. Skipping comment.`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: `No mapping found for taskId: ${taskId}` }),
    };
  }

  const config = EVENT_CONFIG[detailType] || { emoji: 'ℹ️', label: detailType };

  // Build comment lines
  const commentLines = [
    `${config.emoji} *${config.label}*`,
    ``,
    `- Status: ${status}`,
    `- Priority: ${priority}`,
    `- Execution ID: ${executionId}`,
    `- Time: ${timestamp}`,
  ];

  // Try to retrieve investigation summary for Completed events
  if (detailType === 'Investigation Completed' && summaryRecordId && agentSpaceId && executionId) {
    const summaryContent = await getInvestigationSummary(agentSpaceId, executionId, summaryRecordId, region);
    if (summaryContent) {
      commentLines.push(``, `--- Investigation Summary ---`, summaryContent);
    }
    commentLines.push(``, `Summary Record ID: ${summaryRecordId}`);
  }

  const commentBody = commentLines.join('\n');
  await addJiraComment(jiraCredentials, issueKey, commentBody);

  console.log(`${detailType}: Comment added to ${issueKey}`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Comment added to Jira issue',
      issueKey,
      eventType: detailType,
    }),
  };
}

// ========== Helper Functions ==========

/**
 * Get investigation summary from ListJournalRecords API
 */
async function getInvestigationSummary(agentSpaceId, executionId, summaryRecordId, region) {
  try {
    const devopsAgentClient = new DevOpsAgentClient({ region });
    const listRecordsCommand = new ListJournalRecordsCommand({
      agentSpaceId: agentSpaceId,
      executionId: executionId,
      recordType: 'investigation_summary_md',
    });
    const response = await devopsAgentClient.send(listRecordsCommand);
    const records = response.records || [];

    const summaryRecord = records.find((r) => r.recordId === summaryRecordId) || records[0];
    if (summaryRecord && summaryRecord.content) {
      console.log('Successfully retrieved investigation summary');
      return typeof summaryRecord.content === 'string'
        ? summaryRecord.content
        : JSON.stringify(summaryRecord.content);
    }
  } catch (error) {
    console.warn('Failed to retrieve investigation summary:', error.message);
  }
  return '';
}

/**
 * Get Jira credentials from Secrets Manager
 */
async function getJiraCredentials() {
  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) {
    throw new Error('SECRET_ARN environment variable is not set');
  }

  const secretsClient = new SecretsManagerClient();
  const getSecretCommand = new GetSecretValueCommand({ SecretId: secretArn });

  try {
    const secretResponse = await secretsClient.send(getSecretCommand);
    const secretData = JSON.parse(secretResponse.SecretString);
    const { jiraBaseUrl, jiraUserEmail, jiraApiToken, jiraProjectKey } = secretData;

    if (!jiraBaseUrl || !jiraUserEmail || !jiraApiToken || !jiraProjectKey) {
      throw new Error(
        'jiraBaseUrl, jiraUserEmail, jiraApiToken, and jiraProjectKey must be present in the secret'
      );
    }

    console.log('Successfully retrieved Jira credentials from Secrets Manager');
    return { jiraBaseUrl, jiraUserEmail, jiraApiToken, jiraProjectKey };
  } catch (error) {
    console.error('Failed to retrieve secret from Secrets Manager:', error);
    throw error;
  }
}

/**
 * Create a Jira Issue via REST API v3
 */
async function createJiraIssue(credentials, summary, description) {
  const { jiraBaseUrl, jiraUserEmail, jiraApiToken, jiraProjectKey } = credentials;

  const issuePayload = {
    fields: {
      project: { key: jiraProjectKey },
      summary: summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          },
        ],
      },
      issuetype: { name: 'Bug' },
    },
  };

  const authHeader = 'Basic ' + Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString('base64');
  const url = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue`;

  console.log('Creating Jira issue:', { url, project: jiraProjectKey, summary });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
      Accept: 'application/json',
    },
    body: JSON.stringify(issuePayload),
  });

  const responseBody = await response.text();
  console.log('Jira API response:', { statusCode: response.status, body: responseBody });

  if (response.ok) {
    const issueData = JSON.parse(responseBody);
    console.log(`Jira issue created successfully: ${issueData.key}`);
    return issueData;
  } else {
    throw new Error(`Jira API request failed with status ${response.status}: ${responseBody}`);
  }
}

/**
 * Add a comment to an existing Jira Issue via REST API v3
 */
async function addJiraComment(credentials, issueKey, commentText) {
  const { jiraBaseUrl, jiraUserEmail, jiraApiToken } = credentials;

  const commentPayload = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: commentText }],
        },
      ],
    },
  };

  const authHeader = 'Basic ' + Buffer.from(`${jiraUserEmail}:${jiraApiToken}`).toString('base64');
  const url = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/comment`;

  console.log('Adding comment to Jira issue:', { url, issueKey });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
      Accept: 'application/json',
    },
    body: JSON.stringify(commentPayload),
  });

  const responseBody = await response.text();
  console.log('Jira Comment API response:', { statusCode: response.status, body: responseBody });

  if (!response.ok) {
    throw new Error(`Jira Comment API request failed with status ${response.status}: ${responseBody}`);
  }

  return JSON.parse(responseBody);
}

/**
 * Save taskId -> Jira Issue Key mapping to DynamoDB
 */
async function saveMapping(taskId, issueKey, agentSpaceId) {
  const tableName = process.env.MAPPING_TABLE_NAME;
  if (!tableName) {
    throw new Error('MAPPING_TABLE_NAME environment variable is not set');
  }

  const dynamoClient = new DynamoDBClient();
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days TTL

  const command = new PutItemCommand({
    TableName: tableName,
    Item: {
      taskId: { S: taskId },
      issueKey: { S: issueKey },
      agentSpaceId: { S: agentSpaceId },
      createdAt: { S: new Date().toISOString() },
      ttl: { N: String(ttl) },
    },
  });

  await dynamoClient.send(command);
  console.log(`Mapping saved: taskId=${taskId} -> issueKey=${issueKey}`);
}

/**
 * Get Jira Issue Key from DynamoDB mapping
 */
async function getIssueKeyFromMapping(taskId) {
  const tableName = process.env.MAPPING_TABLE_NAME;
  if (!tableName) {
    throw new Error('MAPPING_TABLE_NAME environment variable is not set');
  }

  const dynamoClient = new DynamoDBClient();
  const command = new GetItemCommand({
    TableName: tableName,
    Key: { taskId: { S: taskId } },
  });

  const response = await dynamoClient.send(command);
  if (response.Item && response.Item.issueKey) {
    return response.Item.issueKey.S;
  }
  return null;
}

/**
 * Build a description string for the Jira issue
 */
function buildDescription(params) {
  const lines = [
    `AWS DevOps Agent has created an investigation.`,
    ``,
    `--- Task Details ---`,
    `Title: ${params.taskTitle}`,
  ];

  if (params.taskDescription) {
    lines.push(`Description: ${params.taskDescription}`);
  }

  lines.push(
    ``,
    `--- Metadata ---`,
    `Task ID: ${params.taskId}`,
    `Execution ID: ${params.executionId}`,
    `Agent Space ID: ${params.agentSpaceId}`,
    `Task Type: ${params.taskType}`,
    `Priority: ${params.priority}`,
    `Status: ${params.status}`,
    `Event Time: ${params.timestamp}`,
    `Region: ${params.region}`,
    `Account: ${params.account}`
  );

  return lines.join('\n');
}
