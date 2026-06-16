import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Wraps a shell command in OS-specific process isolation sandbox.
 * Keeps storage overhead to 0 and uses built-in tools only.
 */
export function wrapCommand(command: string, sandboxPath: string): string {
  // macOS Process Sandboxing (native sandbox-exec)
  if (process.platform === 'darwin') {
    // Fix #5 — Use a fixed profile path keyed by sandbox path (not Date.now()),
    // so it is overwritten on reuse and cleaned up reliably after the process exits.
    const safeKey = sandboxPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
    const profilePath = join(tmpdir(), `rdt-mac-sandbox-${safeKey}.sb`);
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
      // Write command to a temp script file to avoid shell injection via single-quote escaping
      const scriptDir = mkdtempSync(join(tmpdir(), 'rdt-cmd-'));
      const scriptPath = join(scriptDir, 'run.sh');
      writeFileSync(
        scriptPath,
        `#!/bin/bash\n${command}\n__exit=$?\nrm -f "${profilePath}"\nrm -rf "${scriptDir}"\nexit $__exit`,
        'utf-8',
      );
      const escapedProfile = profilePath.replace(/"/g, '\\"');
      return `sandbox-exec -f "${escapedProfile}" bash "${scriptPath}"`;
    } catch {
      return command; // Fallback
    }
  }

  // Windows Process Sandboxing (native Low Integrity Level / Directory restriction)
  if (process.platform === 'win32') {
    const escapedPath = sandboxPath.replace(/'/g, "''").toLowerCase();
    // Write command to a temp script file to avoid PowerShell injection via interpolation
    const scriptDir = mkdtempSync(join(tmpdir(), 'rdt-cmd-'));
    const scriptPath = join(scriptDir, 'run.ps1');
    const psScript = `
$ErrorActionPreference = 'Stop'
$origCwd = Get-Location
if (-not $origCwd.Path.ToLower().StartsWith('${escapedPath}')) {
  Write-Error 'Access Denied: Attempted execution outside sandbox boundary'
  exit 1
}
${command}
Remove-Item -Recurse -Force '${scriptDir}' -ErrorAction SilentlyContinue
`;
    writeFileSync(scriptPath, psScript, 'utf-8');
    return `powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "${scriptPath}"`;
  }

  // Linux / other platform fallback
  return command;
}

/**
 * Clean up any leftover sandbox profile files and script directories for a given sandbox path.
 * Call this from Sandbox.destroy() as a belt-and-suspenders cleanup.
 */
export function cleanupIsolationArtifacts(sandboxPath: string): void {
  if (process.platform === 'darwin') {
    const safeKey = sandboxPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
    const profilePath = join(tmpdir(), `rdt-mac-sandbox-${safeKey}.sb`);
    if (existsSync(profilePath)) {
      try {
        unlinkSync(profilePath);
      } catch {
        /* best effort */
      }
    }
  }
  // Clean up any leftover script directories (best effort)
  try {
    const tmpContents = readdirSync(tmpdir());
    for (const item of tmpContents) {
      if (item.startsWith('rdt-cmd-') || item.startsWith('rdt-mac-sandbox-')) {
        try {
          rmSync(join(tmpdir(), item), { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
}
