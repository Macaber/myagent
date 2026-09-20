import * as fs from 'node:fs';
import * as path from 'node:path';
import { Blackboard } from '../context/blackboard.js';
import { ThreadMetricsReport } from '../persistence/telemetry-store.js';
import { getTasksDir } from '../config/paths.js';

export class ArtifactManager {
  public static saveRunSummary(
    workspaceRoot: string,
    threadId: string,
    report: ThreadMetricsReport,
    blackboard: Blackboard
  ): string {
    const summaryDir = path.join(getTasksDir(), threadId);
    if (!fs.existsSync(summaryDir)) {
      fs.mkdirSync(summaryDir, { recursive: true });
    }

    const artifacts = blackboard.getArtifacts();
    const payload = {
      ...report,
      artifacts,
      generatedAt: new Date().toISOString(),
    };

    const filePath = path.join(summaryDir, 'metrics_summary.json');
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return filePath;
  }
}
