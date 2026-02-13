# activate.ps1 - Launch WindowsDemo AppX via IApplicationActivationManager COM
# Usage: powershell -ExecutionPolicy Bypass -File activate.ps1
param([switch]$Kill)

if ($Kill) {
    Stop-Process -Name WindowsDemo -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AppxActivator {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager {}

    public static uint Activate(string aumid) {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid;
        int hr = mgr.ActivateApplication(aumid, "", 0, out pid);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        return pid;
    }
}
"@

$p = Get-AppxPackage '*WindowsDemo*' | Select-Object -First 1
if (-not $p) { Write-Host 'Error: WindowsDemo not registered' -ForegroundColor Red; exit 1 }

$aumid = "$($p.PackageFamilyName)!App"
try {
    $processId = [AppxActivator]::Activate($aumid)
    Write-Host "Launched (PID $processId)"
} catch {
    Write-Host "Activation failed: $_" -ForegroundColor Red
    exit 1
}
