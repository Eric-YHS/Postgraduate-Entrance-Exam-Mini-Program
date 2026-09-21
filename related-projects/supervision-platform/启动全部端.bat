@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Shangan Learning Platform

echo Starting student and teacher platforms...
start "Student Platform" "%~dp0启动学生端.bat"
start "Teacher Platform" "%~dp0启动老师端.bat"

echo.
echo Student: http://127.0.0.1:5173/student
echo Teacher: http://127.0.0.1:5174/teacher
echo.
echo Each platform window will wait until its own Vite server is ready.
exit /b 0
