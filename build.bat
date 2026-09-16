@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64

where go >nul 2>nul
if errorlevel 1 (
  echo 未找到 go 命令，请先安装 Go 并加入 PATH。
  pause
  exit /b 1
)

echo [1/2] 静态检查
go vet ./...
if errorlevel 1 goto :fail

echo [2/2] 编译
go build -trimpath -ldflags="-H windowsgui -s -w" -o sangfor-case-exporter.exe .
if errorlevel 1 goto :fail

echo.
echo 编译完成：%CD%\sangfor-case-exporter.exe
echo.
pause
exit /b 0

:fail
echo.
echo 构建未通过，请查看上方错误信息。
pause
exit /b 1
