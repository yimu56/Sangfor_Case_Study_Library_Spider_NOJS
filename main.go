// 深信服案例库导出工具
//
// 单文件 Windows 程序：内置本地服务 + 内置界面，双击即用。
// 不需要浏览器插件、不需要脚本管理器、不需要任何运行环境。
//
// 设计要点：
//  1. 目标站点接口不允许跨域，所以本地服务承担「代理」角色，
//     界面只跟 127.0.0.1 通信，不存在 CORS 问题。
//  2. 界面在系统默认浏览器里打开 —— 排版/导出这类重活交给浏览器最划算，
//     也让导出文件能走浏览器原生下载，不会被安全软件拦截。
//  3. 另起一个原生小窗口做「启动器」，负责告知地址、重开界面与退出。
//     纯 syscall + GDI 自绘，零第三方依赖，CGO_ENABLED=0 可编译。
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"sync"
	"time"
)

const (
	appName    = "深信服案例库导出工具"
	appVersion = "2.0.0"
)

//go:embed web
var webFS embed.FS

func main() {
	var (
		port      = flag.Int("port", 0, "本地服务端口，0 表示自动分配空闲端口")
		noBrowser = flag.Bool("no-browser", false, "启动后不自动打开浏览器")
		showLog   = flag.Bool("log", false, "在控制台打印启动信息（调试用）")
	)
	flag.Parse()

	// Win32 窗口必须在同一个 OS 线程上创建与派发消息
	runtime.LockOSThread()

	initDPIAwareness()

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		fatal("内置资源损坏", err)
		return
	}

	app, err := startServer(sub, *port)
	if err != nil {
		fatal("启动本地服务失败", err)
		return
	}

	if *showLog {
		fmt.Printf("%s v%s\n本地界面：%s\n", appName, appVersion, app.url)
	}

	// 退出请求：有窗口就关窗口（消息循环结束后统一收尾），没有窗口就直接放行
	quitCh := make(chan struct{})
	var quitOnce sync.Once
	requestQuit := func() {
		if requestWindowClose() {
			return
		}
		quitOnce.Do(func() { close(quitCh) })
	}
	app.onQuit = requestQuit

	if !*noBrowser {
		go func() {
			// 稍等一下，让启动器窗口先画出来，避免浏览器抢焦点时窗口还没出现
			time.Sleep(250 * time.Millisecond)
			openURL(app.url)
		}()
	}

	if err := runLauncherWindow(app.url, func() { openURL(app.url) }, !*noBrowser); err != nil {
		// 窗口起不来时降级：告知地址，等界面里的「退出程序」按钮结束进程
		showMessageBox(appName, fmt.Sprintf(
			"启动器窗口创建失败：%v\n\n请在本机浏览器中打开下面的地址继续使用：\n%s\n\n（点击界面上的「退出程序」可结束本程序）",
			err, app.url))
		<-quitCh
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = app.srv.Shutdown(ctx)
	os.Exit(0)
}

func fatal(title string, err error) {
	msg := fmt.Sprintf("%s：%v", title, err)
	fmt.Fprintln(os.Stderr, msg)
	showMessageBox(appName, msg)
	os.Exit(1)
}
