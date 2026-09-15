@echo off
chcp 65001 >nul
setlocal

rem 深信服案例库导出工具 · 一键编译
rem 零第三方依赖，CGO_ENABLED=0 即可编译，无需 gcc

cd /d "%~dp0"

set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64

echo [1/2] 运行静态检查...
go vet ./...
if errorlevel 1 (
  echo go vet 未通过，已中止。
  pause
  exit /b 1
)

echo [2/2] 编译 sangfor-case-exporter.exe ...
go build -trimpath -ldflags="-H windowsgui -s -w" -o sangfor-case-exporter.exe .
if errorlevel 1 (
  echo 编译失败。
  pause
  exit /b 1
)

echo.
echo 编译完成：sangfor-case-exporter.exe
echo 界面资源已内嵌，分发时只需要这一个文件。
echo.
pause
