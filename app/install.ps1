# Adds OCIO Color Assist to the Start menu and the desktop, as its own Edge app window.
# Run it through Install.bat. Run with -Remove (Uninstall.bat) to take the shortcuts away again.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$name = 'OCIO Color Assist'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$page = Join-Path $here "$name.html"
$localDir = Join-Path $env:LOCALAPPDATA $name
$places = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))

if ($Remove) {
    foreach ($dir in $places) { Remove-Item (Join-Path $dir "$name.lnk") -ErrorAction SilentlyContinue }
    Remove-Item $localDir -Recurse -ErrorAction SilentlyContinue
    Write-Host "$name removed from the Start menu and desktop. Unpin it from the taskbar by hand if it's there."
    return
}

if (-not (Test-Path $page)) { throw "Can't find $page. Run Install.bat from the OCIO_COLOR_ASSIST folder." }

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found on this PC.' }

# The icon is copied locally so the shortcut still shows it when the shared folder file is online-only.
New-Item -ItemType Directory -Force $localDir | Out-Null
Copy-Item (Join-Path $here 'icon.ico') (Join-Path $localDir 'icon.ico') -Force

# The page itself stays in the shared folder, so everyone gets updates automatically.
$uri = [System.Uri]$page
$arguments = "--profile-directory=Default --app=`"$($uri.AbsoluteUri)`" --window-size=700,600"

# Edge gives an --app window its own taskbar ID, built from the page's location:
# "MSEdge." + "_" + URL path, cut to 31 characters in the middle (first 15 + last 16), spaces as "_".
# Stamping the same ID on the shortcut makes the pinned icon and the open window one taskbar button.
$component = '_' + $uri.AbsoluteUri.Substring('file://'.Length) # "/C:/..." with the leading slash, as Edge has it
if ($component.Length -gt 31) { $component = $component.Substring(0, 15) + $component.Substring($component.Length - 16) }
$appId = ('MSEdge.' + $component).Replace(' ', '_')

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AppIdStamp {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); int Commit(); }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
  public static void Set(string lnkPath, string appId) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore ps;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out ps));
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; // System.AppUserModel.ID
    var v = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(appId) };
    try { Marshal.ThrowExceptionForHR(ps.SetValue(ref key, ref v)); Marshal.ThrowExceptionForHR(ps.Commit()); }
    finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(ps); }
  }
}
'@

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in $places) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "$name.lnk"))
    $lnk.TargetPath = $edge
    $lnk.Arguments = $arguments
    $lnk.WorkingDirectory = $here
    $lnk.IconLocation = (Join-Path $localDir 'icon.ico') + ',0'
    $lnk.Description = 'Final colour to input value through the ACES 1.0 SDR-video look (Redshift OCIO config)'
    $lnk.Save()
    # Explorer may still be reading the fresh shortcut, so retry for a moment
    for ($try = 1; $try -le 10; $try++) {
        try { [AppIdStamp]::Set((Join-Path $dir "$name.lnk"), $appId); break }
        catch { if ($try -eq 10) { throw } ; Start-Sleep -Milliseconds 300 }
    }
}

Write-Host ''
Write-Host "$name is installed."
Write-Host ''
Write-Host 'To pin it to the taskbar: open Start, type OCIO, right-click OCIO Color Assist and choose Pin to taskbar.'
Write-Host 'There is also a shortcut on your desktop.'
