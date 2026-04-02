import * as vscode from 'vscode';

/**
 * Returns the short C# type name from a fully-qualified CLR name.
 * "System.Windows.RoutedEventArgs" → "RoutedEventArgs"
 */
function shortTypeName(fullName: string): string {
  return fullName.split('.').pop() ?? 'EventArgs';
}

/**
 * Detects the indentation unit in use (tab or 4-space default).
 */
function detectIndent(content: string): string {
  const m = /^([ \t]+)\S/m.exec(content);
  if (!m) { return '    '; }
  return m[1][0] === '\t' ? '\t' : '    ';
}

/**
 * Finds the line index of an existing method with the given name.
 * Returns -1 if not found.
 */
function findExistingMethod(lines: string[], handlerName: string): number {
  return lines.findIndex(l => /\bvoid\b/.test(l) && l.includes(`${handlerName}(`));
}

/**
 * Finds the line index of the class-closing `}` — the last brace that is not
 * at column 0 (which would be the namespace closing brace).
 *
 * Handles two common patterns:
 *   - Traditional namespace:  two `}` lines at the end — pick the second-to-last.
 *   - File-scoped namespace (C# 10+) or no namespace: one `}` line — pick it.
 */
function findClassClosingBraceLine(lines: string[]): number {
  const bracesFromEnd: number[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\}\s*$/.test(lines[i])) {
      bracesFromEnd.push(i);
      if (bracesFromEnd.length === 2) { break; }
    }
  }
  if (bracesFromEnd.length === 0) { return -1; }
  // If there are two closing braces, the second collected (earlier in file) is the class brace.
  // If only one, that is the class brace (file-scoped namespace or no namespace).
  return bracesFromEnd.length >= 2 ? bracesFromEnd[1] : bracesFromEnd[0];
}

/**
 * Inserts a private event handler stub into the code-behind document.
 *
 * - If the method already exists, returns the position of its body without inserting.
 * - Otherwise inserts before the class closing `}` and returns the position of the
 *   empty line inside the method body (where the cursor should land).
 *
 * Returns null if the insertion point cannot be determined.
 */
export async function insertEventHandlerStub(
  codeBehindPath: string,
  handlerName: string,
  eventArgTypeFullName: string
): Promise<vscode.Position | null> {
  const uri = vscode.Uri.file(codeBehindPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const content = doc.getText();
  const lines = content.split('\n');

  // Navigate to an existing method rather than inserting a duplicate.
  const existingLine = findExistingMethod(lines, handlerName);
  if (existingLine >= 0) {
    return new vscode.Position(existingLine, 0);
  }

  const closingLine = findClassClosingBraceLine(lines);
  if (closingLine < 0) { return null; }

  const indent = detectIndent(content);
  const memberIndent = indent + indent;   // namespace { class {  ← method lives here
  const bodyIndent   = memberIndent + indent;
  const argType = shortTypeName(eventArgTypeFullName);

  // Insert the stub immediately before the class closing brace.
  const stub =
    `\n${memberIndent}private void ${handlerName}(object sender, ${argType} e)\n` +
    `${memberIndent}{\n` +
    `${bodyIndent}\n` +
    `${memberIndent}}\n`;

  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(closingLine, 0), stub);
  await vscode.workspace.applyEdit(edit);

  // Cursor goes to the empty body line (closingLine + 3 after insertion).
  return new vscode.Position(closingLine + 3, bodyIndent.length);
}
