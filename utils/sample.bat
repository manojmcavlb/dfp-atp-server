@echo off
echo Hello from sample.bat!
echo What is your name?
set /p USER_NAME=
echo Welcome, %USER_NAME%!
echo Listing current directory contents:
dir
echo Script execution finished.
pause