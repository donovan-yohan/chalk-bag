import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getGitHubToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }

  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  return null;
}
