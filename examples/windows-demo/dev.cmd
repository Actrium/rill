@echo off
setlocal enabledelayedexpansion

rem Use UTF-8 code page for Metro/Hermes Unicode output.
chcp 65001 >nul
set "CI=1"
rem dev.cmd - Build & deploy Rill Windows Demo
rem
rem Interactive:  dev.cmd
rem CLI:          dev.cmd -engine quickjs -release -clean -nolaunch

cd /d "%~dp0"

set TOTAL=7
set CLEAN=0
set LAUNCH=1
set ENGINE=
set CONFIG=

rem ── Parse CLI args ──
:parse
if "%~1"=="" goto after_parse
if /i "%~1"=="-clean"    ( set CLEAN=1& shift& goto parse )
if /i "%~1"=="-nolaunch" ( set LAUNCH=0& shift& goto parse )
if /i "%~1"=="-release"  ( set CONFIG=Release& shift& goto parse )
if /i "%~1"=="-debug"    ( set CONFIG=Debug& shift& goto parse )
if /i "%~1"=="-engine"   ( set "ENGINE=%~2"& shift& shift& goto parse )
shift
goto parse

:after_parse
rem ── Interactive mode if engine/config not specified ──
if not defined ENGINE goto menu
if not defined CONFIG set CONFIG=Debug
goto validate

:menu
echo.
echo   ===================================
echo      Rill Windows Demo  -  Build
echo   ===================================
echo.
echo   Engine:
echo     [1] QuickJS
echo     [2] Hermes
echo.
choice /c 12 /n /m "   > "
set "_c=!errorlevel!"
if "!_c!"=="2" (set "ENGINE=hermes") else (set "ENGINE=quickjs")
echo.
echo   Config:
echo     [1] Debug
echo     [2] Release
echo.
choice /c 12 /n /m "   > "
set "_c=!errorlevel!"
if "!_c!"=="2" (set "CONFIG=Release") else (set "CONFIG=Debug")
echo.
echo   Options:
echo     [1] Build + Launch
echo     [2] Build + Launch  (clean)
echo     [3] Build only
echo.
choice /c 123 /n /m "   > "
set "_c=!errorlevel!"
if "!_c!"=="3" (set "LAUNCH=0")
if "!_c!"=="2" (set "CLEAN=1")
echo.
goto build

:validate
if not "%ENGINE%"=="quickjs" if not "%ENGINE%"=="hermes" (
    echo Error: -engine must be quickjs or hermes >&2
    exit /b 1
)

:build
echo.
echo   Engine: %ENGINE%  Config: %CONFIG%  Clean: %CLEAN%  Launch: %LAUNCH%
echo.

rem ── Find MSBuild ──
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe 2^>nul`) do set "MSBUILD=%%i"
if not defined MSBUILD echo Error: MSBuild not found >&2 & exit /b 1

rem ── Find CMake ──
set "CMAKE="
where cmake >nul 2>&1 && set "CMAKE=cmake"
if not defined CMAKE (
    for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -find Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe 2^>nul`) do set "CMAKE=%%i"
)
if not defined CMAKE echo Error: CMake not found >&2 & exit /b 1

rem ── Auto-clean on engine switch (prevents stale .obj from incremental build) ──
set "ENGINE_STAMP=windows\x64\.rill_engine"
if exist "!ENGINE_STAMP!" (
    set /p _PREV_ENGINE=<"!ENGINE_STAMP!"
    if not "!_PREV_ENGINE!"=="!ENGINE!" (
        echo   Engine changed [!_PREV_ENGINE!] -^> [!ENGINE!], cleaning...
        if exist windows\x64 rd /s /q windows\x64
        if exist windows\WindowsDemo\x64 rd /s /q windows\WindowsDemo\x64
        if exist windows\WindowsDemo.Package\bin rd /s /q windows\WindowsDemo.Package\bin
    )
)

rem ── Clean ──
if "%CLEAN%"=="1" (
    echo   Cleaning...
    if exist windows\x64 rd /s /q windows\x64
    if exist windows\WindowsDemo\x64 rd /s /q windows\WindowsDemo\x64
    if exist windows\WindowsDemo.Package\bin rd /s /q windows\WindowsDemo.Package\bin
    if exist windows\RillSandboxNative\build rd /s /q windows\RillSandboxNative\build
    if exist windows\WindowsDemo.Package\Bundle\index.windows.bundle del /q windows\WindowsDemo.Package\Bundle\index.windows.bundle
    if exist windows\WindowsDemo.Package\Bundle\step1.bundle del /q windows\WindowsDemo.Package\Bundle\step1.bundle
    if exist windows\WindowsDemo.Package\Bundle\bytecode rd /s /q windows\WindowsDemo.Package\Bundle\bytecode
)

rem ── [1] npm install ──
if not exist "node_modules\.bin" (
    echo   [1/%TOTAL%] npm install...
    call npm install --no-audit --no-fund
    if !errorlevel! neq 0 echo Error: npm install failed >&2 & exit /b 1
) else (
    echo   [1/%TOTAL%] Dependencies (up to date^)
)

rem ── [2] JS bundle ──
set "BUNDLE=windows\WindowsDemo.Package\Bundle\index.windows.bundle"
echo   [2/%TOTAL%] Bundling JS...
if not exist windows\WindowsDemo.Package\Bundle mkdir windows\WindowsDemo.Package\Bundle
call npx react-native bundle --entry-file index.js --platform windows --dev false --bundle-output "%BUNDLE%" --assets-dest windows\WindowsDemo.Package\Bundle
if !errorlevel! neq 0 echo Error: JS bundle failed >&2 & exit /b 1
if exist windows\WindowsDemo.Package\Bundle\step1.bundle del /q windows\WindowsDemo.Package\Bundle\step1.bundle >nul 2>&1

if /i "%ENGINE%"=="hermes" (
    set "HERMESC=%USERPROFILE%\.nuget\packages\microsoft.javascript.hermes\0.0.0-2511.7001-d7ca19b3\tools\native\release\x64\hermesc.exe"
    if not exist "!HERMESC!" set "HERMESC=%USERPROFILE%\.nuget\packages\microsoft.javascript.hermes\0.0.0-2511.7001-d7ca19b3\tools\native\release\x86\hermesc.exe"
    if exist "!HERMESC!" (
        echo   [2/%TOTAL%] Building Hermes bytecode assets...
        if not exist windows\WindowsDemo.Package\Bundle\bytecode mkdir windows\WindowsDemo.Package\Bundle\bytecode
        "!HERMESC!" -emit-binary -out windows\WindowsDemo.Package\Bundle\bytecode\fib.hbc TestCode\fib.js
        if !errorlevel! neq 0 echo Error: hermesc failed for fib.js >&2 & exit /b 1
        "!HERMESC!" -emit-binary -out windows\WindowsDemo.Package\Bundle\bytecode\json.hbc TestCode\json.js
        if !errorlevel! neq 0 echo Error: hermesc failed for json.js >&2 & exit /b 1
        "!HERMESC!" -emit-binary -out windows\WindowsDemo.Package\Bundle\bytecode\array.hbc TestCode\array.js
        if !errorlevel! neq 0 echo Error: hermesc failed for array.js >&2 & exit /b 1
        "!HERMESC!" -emit-binary -out windows\WindowsDemo.Package\Bundle\bytecode\string.hbc TestCode\string.js
        if !errorlevel! neq 0 echo Error: hermesc failed for string.js >&2 & exit /b 1
        "!HERMESC!" -emit-binary -out windows\WindowsDemo.Package\Bundle\bytecode\guest.hbc TestCode\guest.js
        if !errorlevel! neq 0 echo Error: hermesc failed for guest.js >&2 & exit /b 1
    ) else (
        echo   [2/%TOTAL%] Hermes bytecode compiler not found, skip .hbc generation
    )
) else (
    if exist windows\WindowsDemo.Package\Bundle\bytecode rd /s /q windows\WindowsDemo.Package\Bundle\bytecode
)

rem ── [3] CMake sandbox lib ──
set "CMAKE_BD=windows\RillSandboxNative\build"
set "STAMP=%CMAKE_BD%\.rill_engine_%CONFIG%"
set CMAKE_NEEDED=0
if not exist "%STAMP%" ( set CMAKE_NEEDED=1 ) else (
    set /p PREV=<"%STAMP%"
    if not "!PREV!"=="%ENGINE%" set CMAKE_NEEDED=1
)
if not exist "%CMAKE_BD%\%CONFIG%\rill_sandbox.lib" set CMAKE_NEEDED=1
rem Auto-clean stale CMake cache (path mismatch)
if exist "%CMAKE_BD%\CMakeCache.txt" (
    findstr /c:"%CD:\=/%" "%CMAKE_BD%\CMakeCache.txt" >nul 2>&1
    if !errorlevel! neq 0 (
        echo   Stale CMake cache, cleaning...
        rd /s /q "%CMAKE_BD%"
        set CMAKE_NEEDED=1
    )
)

if "%CMAKE_NEEDED%"=="1" (
    echo   [3/%TOTAL%] CMake sandbox [%ENGINE%] [%CONFIG%]...
    "%CMAKE%" -S windows\RillSandboxNative -B %CMAKE_BD% -G "Visual Studio 17 2022" -DRILL_SANDBOX_ENGINE=%ENGINE%
    if !errorlevel! neq 0 echo Error: CMake configure failed >&2 & exit /b 1
    "%CMAKE%" --build %CMAKE_BD% --config %CONFIG%
    if !errorlevel! neq 0 echo Error: CMake build failed >&2 & exit /b 1
    echo %ENGINE%> "%STAMP%"
) else (
    echo   [3/%TOTAL%] Sandbox lib [%ENGINE%] [%CONFIG%] (up to date^)
)

rem ── [4] NuGet restore ──
if exist "windows\WindowsDemo\obj\project.assets.json" (
    echo   [4/%TOTAL%] NuGet restore (up to date^)
) else (
    echo   [4/%TOTAL%] NuGet restore...
    "%MSBUILD%" windows\WindowsDemo.sln /t:Restore /p:Platform=x64 /nologo /v:m
    if !errorlevel! neq 0 echo Error: NuGet restore failed >&2 & exit /b 1
)

rem ── [5] MSBuild ──
echo   [5/%TOTAL%] MSBuild [%ENGINE%] [%CONFIG%]...
"%MSBUILD%" windows\WindowsDemo.sln /p:Configuration=%CONFIG% /p:Platform=x64 /p:RillSandboxEngine=%ENGINE% /p:Bundle=false /p:ReactNativeBundle=false /nologo /v:m
if !errorlevel! neq 0 echo Error: MSBuild failed >&2 & exit /b 1
rem Record engine for switch detection
if not exist "windows\x64" mkdir "windows\x64"
>windows\x64\.rill_engine echo !ENGINE!

rem ── [6] Sync AppX layout ──
set "APPX=windows\WindowsDemo.Package\bin\x64\%CONFIG%"
if exist "%BUNDLE%" (
    if not exist "%APPX%\WindowsDemo\Bundle" mkdir "%APPX%\WindowsDemo\Bundle"
    copy /y "%BUNDLE%" "%APPX%\WindowsDemo\Bundle\index.windows.bundle" >nul 2>&1
    if exist "%APPX%\WindowsDemo\Bundle\step1.bundle" del /q "%APPX%\WindowsDemo\Bundle\step1.bundle" >nul 2>&1
    if exist windows\WindowsDemo.Package\Bundle\bytecode (
        if not exist "%APPX%\WindowsDemo\Bundle\bytecode" mkdir "%APPX%\WindowsDemo\Bundle\bytecode"
        xcopy /s /i /y /q windows\WindowsDemo.Package\Bundle\bytecode "%APPX%\WindowsDemo\Bundle\bytecode" >nul 2>&1
    )
)
if not exist "%APPX%\Images" (
    xcopy /s /i /q windows\WindowsDemo.Package\Images "%APPX%\Images" >nul 2>&1
)
echo   [6/%TOTAL%] AppX synced

rem ── Register ──
powershell -NoProfile -Command "$p=Get-AppxPackage -Name '*WindowsDemo*'; $ok=$p -and $p.InstallLocation -and (Test-Path (Join-Path $p.InstallLocation 'AppxManifest.xml')); if($p -and -not $ok){Remove-AppxPackage $p.PackageFullName -ErrorAction SilentlyContinue; $p=$null}; if(-not $p -or -not $ok){Add-AppxPackage -Register '%CD%\%APPX%\AppxManifest.xml'}" 2>nul

rem End delayed expansion before launch (! is special in delayed expansion)
set "L=%LAUNCH%" & set "T=%TOTAL%" & set "E=%ENGINE%" & set "C=%CONFIG%"
endlocal & set "LAUNCH=%L%" & set "TOTAL=%T%" & set "ENGINE=%E%" & set "CONFIG=%C%"

rem ── [7] Launch ──
if "%LAUNCH%"=="1" (
    echo   [7/%TOTAL%] Launching...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0activate.ps1" -Kill
) else (
    echo   [7/%TOTAL%] Launch (skipped^)
)

echo.
echo   Done [%ENGINE%] [%CONFIG%]
