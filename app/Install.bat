@echo off
rem Adds OCIO Color Assist to the Start menu and desktop. Pin it to the taskbar from Start.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
