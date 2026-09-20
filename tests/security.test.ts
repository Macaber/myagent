import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { WorkspaceJail } from '../dist/security/workspace-jail.js';
import { PolicyEngine } from '../dist/security/policy-engine.js';
import { ApprovalGate, PermissionDeniedByUserError } from '../dist/security/approval-gate.js';

describe('Security & HITL Approval Gate', () => {
  const dummyRoot = path.resolve('/tmp/test_workspace');
  const jail = new WorkspaceJail(dummyRoot);
  const policy = new PolicyEngine(jail);

  test('WorkspaceJail prevents directory escape attacks', () => {
    assert.throws(
      () => jail.resolvePath('../../etc/shadow'),
      /escapes workspace root/
    );
  });

  test('WorkspaceJail blocks sensitive files like .env and credentials', () => {
    assert.throws(
      () => jail.resolvePath('.env'),
      /strictly prohibited/
    );
    assert.throws(
      () => jail.resolvePath('subdir/.env.production'),
      /strictly prohibited/
    );
    assert.throws(
      () => jail.resolvePath('id_rsa'),
      /strictly prohibited/
    );
  });

  test('PolicyEngine evaluates risk tiers properly', () => {
    // Read only should not require approval
    const r1 = policy.evaluateToolCall({ toolName: 'read', riskLevel: 'READ_ONLY' });
    assert.strictEqual(r1.requiresApproval, false);

    // Workspace write inside jail should not require approval in non-strict mode
    const r2 = policy.evaluateToolCall({
      toolName: 'write',
      riskLevel: 'WORKSPACE_WRITE',
      filePath: 'src/app.ts',
    });
    assert.strictEqual(r2.requiresApproval, false);

    // High risk command execution MUST require approval
    const r3 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'npm run clean',
    });
    assert.strictEqual(r3.requiresApproval, true);
  });

  test('ApprovalGate throws PermissionDeniedByUserError when user rejects', async () => {
    // Mock dispatcher that returns REJECTED
    const mockDispatcher: any = {
      requestClient: async () => ({ decision: 'REJECTED', reason: 'Unsafe command' }),
    };
    const gate = new ApprovalGate(policy, mockDispatcher);

    await assert.rejects(
      async () => {
        await gate.checkAndRequestApproval({
          threadId: 't1',
          toolName: 'bash',
          riskLevel: 'HIGH_RISK_EXEC',
          description: 'Run rm -rf',
          command: 'rm -rf /tmp/data',
        });
      },
      PermissionDeniedByUserError
    );
  });

  test('ApprovalGate whitelists tool when APPROVED_ALWAYS is returned', async () => {
    let callCount = 0;
    const mockDispatcher: any = {
      requestClient: async () => {
        callCount++;
        return { decision: 'APPROVED_ALWAYS' };
      },
    };
    const gate = new ApprovalGate(policy, mockDispatcher);

    // First call prompts client
    await gate.checkAndRequestApproval({
      threadId: 't1',
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      description: 'Run npm test',
      command: 'npm test',
    });
    assert.strictEqual(callCount, 1);

    // Second call for same tool should bypass client prompt
    await gate.checkAndRequestApproval({
      threadId: 't1',
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      description: 'Run npm test again',
      command: 'npm test',
    });
    assert.strictEqual(callCount, 1, 'Should not prompt user again after APPROVED_ALWAYS');
  });

  test('PolicyEngine auto-approves safe read-only workspace inspection commands', () => {
    // Safe read-only inspection commands within workspace should NOT require approval
    const safe1 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'cat src/app.ts',
    });
    assert.strictEqual(safe1.requiresApproval, false, 'cat within workspace should be auto-approved');

    const safe2 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'od -c hello.txt && wc -c hello.txt',
    });
    assert.strictEqual(safe2.requiresApproval, false, 'chained od and wc should be auto-approved');

    const safe3 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'git status',
    });
    assert.strictEqual(safe3.requiresApproval, false, 'git status should be auto-approved');

    // Dangerous or mutating commands MUST require approval
    const unsafe1 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'cat /etc/shadow',
    });
    assert.strictEqual(unsafe1.requiresApproval, true, 'cat outside workspace must require approval');

    const unsafe2 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'cat .env',
    });
    assert.strictEqual(unsafe2.requiresApproval, true, 'cat sensitive file must require approval');

    const unsafe3 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'echo "hi" > evil.sh',
    });
    assert.strictEqual(unsafe3.requiresApproval, true, 'output redirection must require approval');

    const unsafe4 = policy.evaluateToolCall({
      toolName: 'bash',
      riskLevel: 'HIGH_RISK_EXEC',
      command: 'rm -rf data',
    });
    assert.strictEqual(unsafe4.requiresApproval, true, 'rm command must require approval');
  });
});
