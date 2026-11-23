@echo off
rem Removes the OCIO Color Assist shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Remove
pause
