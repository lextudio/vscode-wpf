import * as path from 'path';

export const repoRoot = process.env.WPF_REPO_ROOT
  ? path.resolve(process.env.WPF_REPO_ROOT)
  : path.resolve(__dirname, '..', '..', '..', '..');
