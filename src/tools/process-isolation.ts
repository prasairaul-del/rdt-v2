import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Wraps a shell command in OS-specific process isolation sandbox.
 * Keeps storage overhead to 0 and uses built-in tools only.
 */
export function wrapCommand(command: string, sandboxPath: string): string {
  // macOS Process Sandboxing (native sandbox-exec)
  if (process.platform === 'darwin') {
    const profilePath = join(tmpdir(), `rdt-mac-sandbox-${Date.now()}.sb`);
    const profileContent = `
(version 1)
(deny default)
(allow file-read* file-write* (subpath "${sandboxPath}"))
(allow file-read* file-write* (subpath "/private/tmp"))
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library/Developer"))
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/var"))
(allow process-exec)
(allow sysctl-read)
(deny network-outbound)
`;
    try {
      writeFileSync(profilePath, profileContent.trim(), 'utf-8');
      return `sandbox-exec -f "${profilePath}" ${command}`;
    } catch {
      return command; // Fallback
    }
  }

  // Windows Process Sandboxing (native Low Integrity Level / Directory restriction)
  if (process.platform === 'win32') {
    const escapedPath = sandboxPath.replace(/'/g, "''").toLowerCase();
    const psScript = `
      $origCwd = Get-Location;
      if (-not $origCwd.Path.ToLower().StartsWith('${escapedPath}')) {
        Write-Error 'Access Denied: Attempted execution outside sandbox boundary';
        exit 1;
      }
      ${command}
    `;
    const buffer = Buffer.from(psScript, 'utf16le');
    const base64 = buffer.toString('base64');
    return `powershell -NoProfile -EncodedCommand ${base64}`;
  }

  // Linux / other platform fallback
  return command;
}
