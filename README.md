# AWS DevOps Agent EventBridge Integration - Jira Issue Creator

## Overview

AWS DevOps Agent sends events to Amazon EventBridge at each stage of the investigation lifecycle. You can use this architecture to build integrations with any chat tool or ticket management tool.

This repository provides a sample integration with **Jira Cloud**, built with AWS CDK (TypeScript).

**Features:**
- `Investigation Created`: Automatically creates a Bug issue in Jira and saves a taskId → issueKey mapping to DynamoDB
- All other Investigation events: Adds a comment to the existing Jira issue using the DynamoDB mapping

**Supported events (all Investigation events):**

| detail-type | Description |
|-------------|-------------|
| `Investigation Created` | An investigation was created |
| `Investigation Priority Updated` | The priority of an investigation was changed |
| `Investigation In Progress` | An investigation started active analysis |
| `Investigation Completed` | An investigation finished successfully with findings |
| `Investigation Failed` | An investigation encountered an error |
| `Investigation Timed Out` | An investigation exceeded the maximum allowed duration |
| `Investigation Cancelled` | An investigation was canceled |
| `Investigation Pending Triage` | An investigation is awaiting triage |
| `Investigation Linked` | An investigation was linked to a related incident |
| `Investigation Skipped` | An investigation was skipped |

**Components:**
- EventBridge rule with prefix match catches all Investigation events
- Lambda function calls Jira REST API v3 to create issues / add comments
- DynamoDB manages the mapping between Investigation taskId and Jira Issue Key
- Jira credentials are stored securely in AWS Secrets Manager

## Architecture

```
┌──────────────────────────┐
│  AWS DevOps Agent        │
│  (Investigation Events)  │
└───────────┬──────────────┘
            │ Events (source: aws.aidevops)
            │ detail-type: "Investigation *" (prefix match)
            ▼
┌──────────────────────────┐
│  Amazon EventBridge      │
│  Rule: prefix match      │
│  "Investigation"         │
└───────────┬──────────────┘
            │ Target: Lambda
            ▼
┌──────────────────────────┐      ┌──────────────────────┐
│  Lambda Function         │─────▶│  AWS Secrets Manager │
│  (Jira Issue Creator)    │      │  (Jira Credentials)  │
└───────────┬──────────────┘      └──────────────────────┘
            │
            ├─── DynamoDB (taskId → issueKey mapping)
            │
            │ HTTP POST (REST API v3)
            ▼
┌──────────────────────────┐
│  Jira Cloud              │
│  - Issue Created         │
│  - Comments Added        │
└──────────────────────────┘
```

**Example flow:**
1. `Investigation Created` → Creates a Jira issue and saves `taskId → issueKey` mapping to DynamoDB
2. `Investigation In Progress` → Retrieves the mapping from DynamoDB and adds a comment to the Jira issue
3. `Investigation Completed` → Retrieves the mapping and adds a comment with the investigation summary

All other events (Failed, Timed Out, Cancelled, Pending Triage, Linked, Skipped, Priority Updated) are also processed as comments on the existing Jira issue.

## Prerequisites

### Required Tools

1. **AWS CLI** - AWS Command Line Interface
   - Installation: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
   - Verify with `aws --version`
   - Configure credentials with `aws configure`

2. **AWS CDK** - Cloud Development Kit
   - Installation: `npm install -g aws-cdk`
   - Verify with `cdk --version`

3. **Node.js** - v18 or later
   - Verify with `node --version`

### Jira Setup

Get an API token from Jira Cloud:

1. Go to [Atlassian Account](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token" to generate a token
3. Note the following information:
   - Jira Base URL (e.g., `https://your-domain.atlassian.net`)
   - Your email address
   - API token
   - Project key (e.g., `PROJ`)

## Deployment

### Step 1: Create a secret in Secrets Manager

Store Jira credentials in AWS Secrets Manager:

```bash
# Set environment variables
export JIRA_BASE_URL="https://your-domain.atlassian.net"
export JIRA_USER_EMAIL="your-email@example.com"
export JIRA_API_TOKEN="your-api-token"
export JIRA_PROJECT_KEY="PROJ"
export SECRET_NAME="devops-agent-jira-credentials"

# Create the secret in Secrets Manager
aws secretsmanager create-secret \
  --name ${SECRET_NAME} \
  --description "Jira credentials for DevOps Agent EventBridge integration" \
  --secret-string "{\"jiraBaseUrl\":\"${JIRA_BASE_URL}\",\"jiraUserEmail\":\"${JIRA_USER_EMAIL}\",\"jiraApiToken\":\"${JIRA_API_TOKEN}\",\"jiraProjectKey\":\"${JIRA_PROJECT_KEY}\"}"
```

**Example output:**
```json
{
    "ARN": "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:devops-agent-jira-credentials-AbCdEf",
    "Name": "devops-agent-jira-credentials",
    "VersionId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Note the ARN from the output. You will use it in the next step.

### Step 2: CDK Bootstrap (first time only)

If this is the first time using CDK in the region, run bootstrap:

```bash
cd cdk
cdk bootstrap
```

### Step 3: CDK Deploy

```bash
cd cdk
npm install
npm run build
cdk deploy --parameters SecretArn=arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:devops-agent-jira-credentials-AbCdEf
```

Enter `y` when prompted to confirm the deployment.

## Jira Issue Content

The Lambda function creates a Jira issue with the following fields:

| Field | Content | Example |
|-------|---------|---------|
| Issue Type | Bug | Bug |
| Summary | `[DevOps Agent] {task title}` | `[DevOps Agent] Investigation 2026-06-19T05:02:16.517Z` |
| Description | Task details + metadata | See below |

**Description example:**

```
AWS DevOps Agent has created an investigation.

--- Task Details ---
Title: Investigation 2026-06-19T05:02:16.517Z
Description: Investigate the latest ECS errors

--- Metadata ---
Task ID: f59c0b90-93f4-4fcb-9b16-fa786f1f6f8d
Execution ID: exe-ops1-ac91a665-c0e3-434f-b681-6c400879a57d
Agent Space ID: 2a8005eb-3ea2-44e4-80c1-56b76d17529a
Task Type: INVESTIGATION
Priority: MEDIUM
Status: PENDING_START
Event Time: 2026-06-19T05:02:18Z
Region: ap-northeast-1
Account: 123456789012
```

The `Title` and `Description` fields are retrieved from the DevOps Agent [GetBacklogTask API](https://docs.aws.amazon.com/cli/latest/reference/devops-agent/get-backlog-task.html). Since EventBridge events do not include task title/description, the Lambda function calls this API to get the details.

## Project Structure

```
.
├── README.md
└── cdk/
    ├── bin/
    │   └── cdk.ts              # CDK app entry point
    ├── lib/
    │   └── cdk-stack.ts        # Stack definition (EventBridge, Lambda, DynamoDB, IAM)
    ├── src/
    │   └── jira-issue-creator/
    │       └── index.js        # Lambda function code
    ├── cdk.json
    ├── package.json
    └── tsconfig.json
```

## Secrets Manager Secret Format

Store the secret in the following JSON format:

```json
{
  "jiraBaseUrl": "https://your-domain.atlassian.net",
  "jiraUserEmail": "your-email@example.com",
  "jiraApiToken": "your-api-token-here",
  "jiraProjectKey": "PROJ"
}
```

| Key | Description |
|-----|-------------|
| `jiraBaseUrl` | Jira Cloud URL |
| `jiraUserEmail` | Jira user email address |
| `jiraApiToken` | Jira API token |
| `jiraProjectKey` | Project key for issue creation |

## Cleanup

### Step 1: Delete the CDK stack

```bash
cd cdk
cdk destroy
```

### Step 2: Delete the Secrets Manager secret

```bash
aws secretsmanager delete-secret \
  --secret-id devops-agent-jira-credentials \
  --force-delete-without-recovery
```

## EventBridge Events Reference

Examples of EventBridge events that this project handles (captured from Lambda logs).

### Investigation Created Event

```json
{
  "version": "0",
  "id": "e034f9c8-20fe-e2ce-8cde-a523e6768f70",
  "detail-type": "Investigation Created",
  "source": "aws.aidevops",
  "account": "123456789012",
  "time": "2026-06-21T23:52:24Z",
  "region": "ap-northeast-1",
  "resources": [
    "arn:aws:aidevops:ap-northeast-1:123456789012:agentspace/a1b2c3d4-5678-90ab-cdef-example00001"
  ],
  "detail": {
    "version": "1.0.0",
    "metadata": {
      "agent_space_id": "a1b2c3d4-5678-90ab-cdef-example00001",
      "task_id": "f1e2d3c4-5678-90ab-cdef-example00002",
      "execution_id": "exe-ops1-a1b2c3d4-5678-90ab-cdef-example00003"
    },
    "data": {
      "task_type": "INVESTIGATION",
      "priority": "MEDIUM",
      "status": "PENDING_START",
      "created_at": "2026-06-21T23:52:24.979Z",
      "updated_at": "2026-06-21T23:52:24.979Z"
    }
  }
}
```

### Investigation In Progress Event

```json
{
  "version": "0",
  "id": "afdbd45c-eb25-8b6a-1756-5cc1d14a1a09",
  "detail-type": "Investigation In Progress",
  "source": "aws.aidevops",
  "account": "123456789012",
  "time": "2026-06-21T23:52:30Z",
  "region": "ap-northeast-1",
  "resources": [
    "arn:aws:aidevops:ap-northeast-1:123456789012:agentspace/a1b2c3d4-5678-90ab-cdef-example00001"
  ],
  "detail": {
    "version": "1.0.0",
    "metadata": {
      "agent_space_id": "a1b2c3d4-5678-90ab-cdef-example00001",
      "task_id": "f1e2d3c4-5678-90ab-cdef-example00002",
      "execution_id": "exe-ops1-a1b2c3d4-5678-90ab-cdef-example00003"
    },
    "data": {
      "task_type": "INVESTIGATION",
      "priority": "MEDIUM",
      "status": "IN_PROGRESS",
      "created_at": "2026-06-21T23:52:24.979Z",
      "updated_at": "2026-06-21T23:52:30.427Z"
    }
  }
}
```

### Investigation Completed Event

```json
{
  "version": "0",
  "id": "21adf0b2-ae09-b0e4-214a-ded5f9d09e6c",
  "detail-type": "Investigation Completed",
  "source": "aws.aidevops",
  "account": "123456789012",
  "time": "2026-06-21T23:54:04Z",
  "region": "ap-northeast-1",
  "resources": [
    "arn:aws:aidevops:ap-northeast-1:123456789012:agentspace/a1b2c3d4-5678-90ab-cdef-example00001"
  ],
  "detail": {
    "version": "1.0.0",
    "metadata": {
      "agent_space_id": "a1b2c3d4-5678-90ab-cdef-example00001",
      "task_id": "f1e2d3c4-5678-90ab-cdef-example00002",
      "execution_id": "exe-ops1-a1b2c3d4-5678-90ab-cdef-example00003"
    },
    "data": {
      "task_type": "INVESTIGATION",
      "priority": "MEDIUM",
      "status": "COMPLETED",
      "created_at": "2026-06-21T23:52:24.979Z",
      "updated_at": "2026-06-21T23:54:04.233Z",
      "summary_record_id": "b4c5d6e7-1234-56ab-cdef-example00004"
    }
  }
}
```

**Field descriptions:**

| Field | Description |
|-------|-------------|
| `detail-type` | Event type: `Investigation Created`, `Investigation In Progress`, `Investigation Completed`, etc. |
| `detail.metadata.agent_space_id` | Agent Space ID |
| `detail.metadata.task_id` | Task (investigation) ID. Used as the DynamoDB mapping key |
| `detail.metadata.execution_id` | Execution ID. Used with ListJournalRecords API |
| `detail.data.status` | Transitions: `PENDING_START` → `IN_PROGRESS` → `COMPLETED` |
| `detail.data.summary_record_id` | Only present on Investigation Completed. Used to retrieve the investigation summary |

> **Reference:** [AWS DevOps Agent events detail reference](https://docs.aws.amazon.com/devopsagent/latest/userguide/integrating-devops-agent-into-event-driven-applications-using-amazon-eventbridge-devops-agent-events-detail-reference.html) - Based on the definitions for all Investigation `detail-type` values. For `Investigation Completed`, `data.summary_record_id` is included and can be used with the [ListJournalRecords API](https://docs.aws.amazon.com/devopsagent/latest/APIReference/API_ListJournalRecords.html) with `recordType: investigation_summary_md` to retrieve the investigation summary.

## References

- [Integrating AWS DevOps Agent with Amazon EventBridge](https://docs.aws.amazon.com/devopsagent/latest/userguide/configuring-integrations-and-knowledge-integrating-devops-agent-into-event-driven-applications-using-amazon-eventbridge-index.html)
- [AWS DevOps Agent events detail reference](https://docs.aws.amazon.com/devopsagent/latest/userguide/integrating-devops-agent-into-event-driven-applications-using-amazon-eventbridge-devops-agent-events-detail-reference.html)
- [Jira Cloud REST API v3 - Create Issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [Sample: AWS DevOps Agent CloudWatch WebHook](https://github.com/aws-samples/sample-aws-devops-agent-cloudwatch)

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
