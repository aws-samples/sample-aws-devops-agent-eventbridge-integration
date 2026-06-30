#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { DevOpsAgentEventBridgeJiraStack } from '../lib/cdk-stack';

const app = new cdk.App();
new DevOpsAgentEventBridgeJiraStack(app, 'DevOpsAgentEventBridgeJiraStack', {
  description: 'AWS DevOps Agent EventBridge Integration - Creates Jira issues on investigation start',
});
