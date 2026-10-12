// Runs one session's checkpoint on the engine its kind needs: the Copilot CLI engine, or the VS Code one for a chat file.
import { runCheckpoint } from './cli-checkpoint.mjs';
import { runVscodeCheckpoint } from './vscode-checkpoint.mjs';

// entry: a scan entry { sessionId, transcriptPath, kind, file }; input: the rest of the engine input (cwd, trigger, budgetMs, …).
export function runAnyCheckpoint(entry, input, options) {
  const vscode = entry.kind === 'vscode';
  return (vscode ? runVscodeCheckpoint : runCheckpoint)(
    {
      sessionId: entry.sessionId,
      transcriptPath: entry.transcriptPath,
      ...(vscode ? { file: entry.file } : {}),
      ...input,
    },
    {},
    options,
  );
}
