//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

/* ==========================================================================
 * 原生启动器窗口：纯 syscall + GDI 自绘，不引入任何第三方模块。
 * 职责很窄 —— 告诉用户界面地址、重开界面、退出程序。
 * 真正的功能界面在浏览器里（见 web/ 目录）。
 * ========================================================================== */

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")

	// user32
	pRegisterClassExW              = user32.NewProc("RegisterClassExW")
	pCreateWindowExW               = user32.NewProc("CreateWindowExW")
	pDefWindowProcW                = user32.NewProc("DefWindowProcW")
	pGetMessageW                   = user32.NewProc("GetMessageW")
	pTranslateMessage              = user32.NewProc("TranslateMessage")
	pDispatchMessageW              = user32.NewProc("DispatchMessageW")
	pPostQuitMessage               = user32.NewProc("PostQuitMessage")
	pPostMessageW                  = user32.NewProc("PostMessageW")
	pDestroyWindow                 = user32.NewProc("DestroyWindow")
	pBeginPaint                    = user32.NewProc("BeginPaint")
	pEndPaint                      = user32.NewProc("EndPaint")
	pFillRect                      = user32.NewProc("FillRect")
	pGetClientRect                 = user32.NewProc("GetClientRect")
	pGetWindowRect                 = user32.NewProc("GetWindowRect")
	pSetWindowPos                  = user32.NewProc("SetWindowPos")
	pSetWindowTextW                = user32.NewProc("SetWindowTextW")
	pShowWindow                    = user32.NewProc("ShowWindow")
	pUpdateWindow                  = user32.NewProc("UpdateWindow")
	pLoadCursorW                   = user32.NewProc("LoadCursorW")
	pSetCursor                     = user32.NewProc("SetCursor")
	pDrawTextW                     = user32.NewProc("DrawTextW")
	pInvalidateRect                = user32.NewProc("InvalidateRect")
	pTrackMouseEvent               = user32.NewProc("TrackMouseEvent")
	pGetCursorPos                  = user32.NewProc("GetCursorPos")
	pScreenToClient                = user32.NewProc("ScreenToClient")
	pSetTimer                      = user32.NewProc("SetTimer")
	pKillTimer                     = user32.NewProc("KillTimer")
	pMessageBoxW                   = user32.NewProc("MessageBoxW")
	pSystemParametersInfoW         = user32.NewProc("SystemParametersInfoW")
	pGetDC                         = user32.NewProc("GetDC")
	pReleaseDC                     = user32.NewProc("ReleaseDC")
	pOpenClipboard                 = user32.NewProc("OpenClipboard")
	pCloseClipboard                = user32.NewProc("CloseClipboard")
	pEmptyClipboard                = user32.NewProc("EmptyClipboard")
	pSetClipboardData              = user32.NewProc("SetClipboardData")
	pSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
	pSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	pGetDpiForWindow               = user32.NewProc("GetDpiForWindow")

	// gdi32
	pCreateSolidBrush    = gdi32.NewProc("CreateSolidBrush")
	pCreatePen           = gdi32.NewProc("CreatePen")
	pRoundRect           = gdi32.NewProc("RoundRect")
	pEllipse             = gdi32.NewProc("Ellipse")
	pCreateFontW         = gdi32.NewProc("CreateFontW")
	pSelectObject        = gdi32.NewProc("SelectObject")
	pDeleteObject        = gdi32.NewProc("DeleteObject")
	pSetBkMode           = gdi32.NewProc("SetBkMode")
	pSetTextColor        = gdi32.NewProc("SetTextColor")
	pCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBmp = gdi32.NewProc("CreateCompatibleBitmap")
	pBitBlt              = gdi32.NewProc("BitBlt")
	pDeleteDC            = gdi32.NewProc("DeleteDC")
	pGetDeviceCaps       = gdi32.NewProc("GetDeviceCaps")

	// kernel32
	pGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
	pGlobalAlloc      = kernel32.NewProc("GlobalAlloc")
	pGlobalLock       = kernel32.NewProc("GlobalLock")
	pGlobalUnlock     = kernel32.NewProc("GlobalUnlock")
	pRtlMoveMemory    = kernel32.NewProc("RtlMoveMemory")

	// shell32
	pShellExecuteW = shell32.NewProc("ShellExecuteW")
)

/* ----------------------------------------------------------------- 常量 */

const (
	wmCreate          = 0x0001
	wmDestroy         = 0x0002
	wmPaint           = 0x000F
	wmClose           = 0x0010
	wmQueryEndSession = 0x0011
	wmEraseBkgnd      = 0x0014
	wmEndSession      = 0x0016
	wmSetCursor       = 0x0020
	wmTimer           = 0x0113
	wmMouseMove       = 0x0200
	wmLButtonDn       = 0x0201
	wmLButtonUp       = 0x0202
	wmMouseLeave      = 0x02A3
	wmDpiChanged      = 0x02E0

	// 自定义消息（WM_APP + 1）：界面上已经确认过一次的退出请求，
	// 收到后直接关窗，不再弹二次确认框。
	wmQuitConfirmed = 0x8001

	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsVisible     = 0x10000000
	wsExAppWindow = 0x00040000

	swShow        = 5
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010

	htCaption = 2
	htClient  = 1

	idcArrow = 32512
	idcHand  = 32649

	cfUnicodeText = 13
	gmemMoveable  = 0x0002
	gmemZeroInit  = 0x0040

	srcCopy     = 0x00CC0020
	transparent = 1
	psSolid     = 0

	dtLeft        = 0x00000000
	dtCenter      = 0x00000001
	dtVCenter     = 0x00000004
	dtSingleLine  = 0x00000020
	dtNoPrefix    = 0x00000800
	dtEndEllipsis = 0x00008000

	tmeLeave       = 0x00000002
	spiGetWorkArea = 0x0030
	logPixelsX     = 88

	mbOK              = 0x00000000
	mbYesNo           = 0x00000004
	mbIconError       = 0x00000010
	mbIconQuestion    = 0x00000020
	mbIconInformation = 0x00000040
	mbDefaultButton2  = 0x00000100
	mbTopMost         = 0x00040000
	mbSetForeground   = 0x00010000

	// MessageBox 返回值
	idYes = 6

	// 逻辑设计尺寸（96 DPI 下的像素），实际渲染按 DPI 缩放
	lwClient = 496
	lhClient = 268
)

const (
	btnNone = -1
	btnOpen = 0
	btnCopy = 1
	btnQuit = 2
	btnURL  = 3
)

/* ----------------------------------------------------------------- 类型 */

type rectT struct{ left, top, right, bottom int32 }
type pointT struct{ x, y int32 }

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type msgT struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      pointT
}

type paintStructT struct {
	hdc         uintptr
	fErase      int32
	rcPaint     rectT
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

type trackMouseEventT struct {
	cbSize      uint32
	dwFlags     uint32
	hwndTrack   uintptr
	dwHoverTime uint32
}

/* ----------------------------------------------------------------- 状态 */

type launcherWin struct {
	hwnd     uintptr
	url      string
	onOpen   func()
	autoOpen bool // 启动时是否已自动打开浏览器，只影响提示文案

	dpi uint32

	fontTitle uintptr
	fontSub   uintptr
	fontBody  uintptr
	fontSmall uintptr

	rcURL  rectT
	rcOpen rectT
	rcCopy rectT
	rcQuit rectT

	hover   int
	pressed int
	tip     string

	// 系统注销/关机时置位，让随后的关闭动作不再弹确认框阻塞关机
	skipConfirm bool
}

var (
	curWin  *launcherWin
	appHWND uintptr
	// 回调必须保活，否则会被 GC 回收导致窗口消息派发出错
	wndProcCb = syscall.NewCallback(launcherProc)
)

func rgb(r, g, b uint32) uintptr {
	return uintptr(r&0xFF | (g&0xFF)<<8 | (b&0xFF)<<16)
}

/* --------------------------------------------------------------- 公共 API */

// initDPIAwareness 让窗口在高缩放屏幕上不被系统拉伸模糊。
// 注意：不要在清单里再声明 dpiAware，两者只能取其一，否则运行时调用会失败。
func initDPIAwareness() {
	if pSetProcessDpiAwarenessContext.Find() == nil {
		// -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
		if r, _, _ := pSetProcessDpiAwarenessContext.Call(^uintptr(3)); r != 0 {
			return
		}
	}
	if pSetProcessDPIAware.Find() == nil {
		pSetProcessDPIAware.Call()
	}
}

func openURL(u string) {
	if u == "" {
		return
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	target, _ := syscall.UTF16PtrFromString(u)
	pShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(target)),
		0, 0, uintptr(swShow))
}

func showMessageBox(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	flags := uintptr(mbOK | mbTopMost | mbSetForeground | mbIconInformation)
	pMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
}

func fatalBox(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	flags := uintptr(mbOK | mbTopMost | mbSetForeground | mbIconError)
	pMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
}

// confirmQuit 在真正关闭之前做一次二次确认，返回 true 表示用户确认退出。
// 默认按钮刻意设为「否」：误按回车/空格时程序保持运行，而不是直接退出。
func confirmQuit(hwnd uintptr) bool {
	title, _ := syscall.UTF16PtrFromString(appName)
	text, _ := syscall.UTF16PtrFromString(
		"确定要退出「" + appName + "」吗？\n\n" +
			"退出后本地服务会一并关闭，浏览器中正在使用的界面将无法继续操作。")
	flags := uintptr(mbYesNo | mbIconQuestion | mbDefaultButton2 | mbTopMost | mbSetForeground)
	r, _, _ := pMessageBoxW.Call(hwnd,
		uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), flags)
	return r == idYes
}

// requestWindowClose 通知窗口关闭；窗口还没建好时返回 false，
// 由调用方走「无窗口」的降级退出路径。
// 走的是自定义消息而非 WM_CLOSE：界面上的「退出程序」已经弹过一次确认，
// 这里不再重复询问。
func requestWindowClose() bool {
	if appHWND == 0 {
		return false
	}
	pPostMessageW.Call(appHWND, wmQuitConfirmed, 0, 0)
	return true
}

func writeCrashLog(err error) {
	p := filepath.Join(os.TempDir(), "sangfor-case-exporter.log")
	f, e := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if e != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  local server stopped: %v\n", time.Now().Format(time.RFC3339), err)
}

/* -------------------------------------------------------------- 窗口过程 */

func launcherProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	l := curWin
	switch msg {
	case wmEraseBkgnd:
		return 1

	case wmPaint:
		paint(hwnd)
		return 0

	case wmMouseMove:
		if l != nil {
			x := int32(int16(lParam & 0xFFFF))
			y := int32(int16((lParam >> 16) & 0xFFFF))
			h := l.hitTest(x, y)
			if h != l.hover {
				l.hover = h
				invalidate(hwnd)
			}
			// 订阅 WM_MOUSELEAVE，否则移出按钮后一直停留在 hover 状态
			var tme trackMouseEventT
			tme.cbSize = uint32(unsafe.Sizeof(tme))
			tme.dwFlags = tmeLeave
			tme.hwndTrack = hwnd
			pTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
		}
		return 0

	case wmMouseLeave:
		if l != nil && (l.hover != btnNone || l.pressed != btnNone) {
			l.hover = btnNone
			l.pressed = btnNone
			invalidate(hwnd)
		}
		return 0

	case wmLButtonDn:
		if l != nil {
			x := int32(int16(lParam & 0xFFFF))
			y := int32(int16((lParam >> 16) & 0xFFFF))
			l.pressed = l.hitTest(x, y)
			invalidate(hwnd)
		}
		return 0

	case wmLButtonUp:
		if l != nil {
			x := int32(int16(lParam & 0xFFFF))
			y := int32(int16((lParam >> 16) & 0xFFFF))
			h := l.hitTest(x, y)
			was := l.pressed
			l.pressed = btnNone
			invalidate(hwnd)
			if h != btnNone && h == was {
				l.activate(h, hwnd)
			}
		}
		return 0

	case wmSetCursor:
		if l != nil && lParam&0xFFFF == htClient {
			var pt pointT
			pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			pScreenToClient.Call(hwnd, uintptr(unsafe.Pointer(&pt)))
			if l.hitTest(pt.x, pt.y) != btnNone {
				if c, _, _ := pLoadCursorW.Call(0, uintptr(idcHand)); c != 0 {
					pSetCursor.Call(c)
					return 1
				}
			}
		}

	case wmTimer:
		if l != nil && wParam == 1 {
			pKillTimer.Call(hwnd, 1)
			l.tip = ""
			invalidate(hwnd)
		}
		return 0

	case wmDpiChanged:
		if l != nil {
			newDPI := uint32(wParam & 0xFFFF)
			if newDPI == 0 {
				newDPI = 96
			}
			l.dpi = newDPI
			l.rebuildFonts()
			l.layout()
			w, h := l.windowSize()
			pSetWindowPos.Call(hwnd, 0, 0, 0, uintptr(w), uintptr(h),
				uintptr(swpNoZOrder|swpNoActivate))
			invalidate(hwnd)
		}
		return 0

	case wmQueryEndSession:
		// 系统要关机/注销：直接放行，并把 skipConfirm 置位，
		// 让随后的关闭不再弹确认框拖住关机流程。
		if l != nil {
			l.skipConfirm = true
		}
		return 1

	case wmEndSession:
		if wParam != 0 && l != nil {
			l.skipConfirm = true
			pDestroyWindow.Call(hwnd)
		}
		return 0

	case wmClose:
		// 关窗前二次确认，避免误点标题栏的 × 或误触「退出」把程序关掉。
		if l != nil && !l.skipConfirm && !confirmQuit(hwnd) {
			return 0
		}
		pDestroyWindow.Call(hwnd)
		return 0

	case wmQuitConfirmed:
		// 界面里已经确认过的退出：直接关窗，不重复询问。
		pDestroyWindow.Call(hwnd)
		return 0

	case wmDestroy:
		appHWND = 0
		if l != nil {
			l.releaseFonts()
		}
		pPostQuitMessage.Call(0)
		return 0
	}

	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return r
}

func invalidate(hwnd uintptr) {
	pInvalidateRect.Call(hwnd, 0, 0)
}

/* ---------------------------------------------------------------- 绘制 */

func paint(hwnd uintptr) {
	var ps paintStructT
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

	var cr rectT
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&cr)))
	w, h := cr.right-cr.left, cr.bottom-cr.top
	if w <= 0 || h <= 0 {
		return
	}

	// 双缓冲：自绘控件多，直接画到屏幕 DC 会闪
	memDC, _, _ := pCreateCompatibleDC.Call(hdc)
	bmp, _, _ := pCreateCompatibleBmp.Call(hdc, uintptr(w), uintptr(h))
	oldBmp, _, _ := pSelectObject.Call(memDC, bmp)

	curWin.draw(memDC, w, h)

	pBitBlt.Call(hdc, 0, 0, uintptr(w), uintptr(h), memDC, 0, 0, uintptr(srcCopy))
	pSelectObject.Call(memDC, oldBmp)
	pDeleteObject.Call(bmp)
	pDeleteDC.Call(memDC)
}

func (l *launcherWin) draw(hdc uintptr, w, h int32) {
	bg := rgb(0xFF, 0xFF, 0xFF)
	fillRect(hdc, rectT{0, 0, w, h}, bg)

	// 顶部色带
	fillRect(hdc, rectT{0, 0, w, l.px(84)}, rgb(0x15, 0x65, 0xC0))
	drawText(hdc, appName, l.pxRect(28, 16, 468, 46), l.fontTitle,
		rgb(0xFF, 0xFF, 0xFF), dtSingleLine|dtVCenter|dtLeft|dtNoPrefix)
	drawText(hdc, "support.sangfor.com.cn · 案例 / 解决方案批量导出", l.pxRect(29, 48, 468, 68),
		l.fontSub, rgb(0xCF, 0xE0, 0xF7), dtSingleLine|dtVCenter|dtLeft|dtNoPrefix)

	// 运行状态
	dotR := l.px(4)
	cx, cy := l.px(30), l.px(105)
	fillEllipse(hdc, rectT{cx - dotR, cy - dotR, cx + dotR, cy + dotR}, rgb(0x16, 0xA3, 0x4A))
	status := "本地服务运行中，界面已在浏览器中打开"
	if !l.autoOpen {
		status = "本地服务运行中，点下面的按钮打开功能界面"
	}
	drawText(hdc, status, l.pxRect(44, 95, 468, 115), l.fontBody,
		rgb(0x1F, 0x23, 0x29), dtSingleLine|dtVCenter|dtLeft|dtNoPrefix|dtEndEllipsis)

	// 地址框
	urlBox := l.pxRect(24, 124, 472, 160)
	roundRectFill(hdc, urlBox, l.px(8), rgb(0xF5, 0xF7, 0xFB), rgb(0xE3, 0xE6, 0xEC), int(l.px(1)))
	drawText(hdc, l.url, rectT{urlBox.left + l.px(14), urlBox.top, urlBox.right - l.px(14), urlBox.bottom},
		l.fontBody, rgb(0x1A, 0x6F, 0xD4), dtSingleLine|dtVCenter|dtLeft|dtNoPrefix|dtEndEllipsis)

	// 按钮
	l.drawButton(hdc, l.rcOpen, "在浏览器中打开", btnPrimary, btnOpen)
	l.drawButton(hdc, l.rcCopy, "复制地址", btnDefault, btnCopy)
	l.drawButton(hdc, l.rcQuit, "退出", btnDefault, btnQuit)

	// 分隔线 + 提示
	sepY := l.px(232)
	fillRect(hdc, rectT{l.px(24), sepY, w - l.px(24), sepY + l.px(1)}, rgb(0xED, 0xEF, 0xF3))
	tip := "关闭窗口前会二次确认；抓取与导出均在本机完成，不经过任何第三方服务器"
	if l.tip != "" {
		tip = l.tip
	}
	drawText(hdc, tip, l.pxRect(24, 240, 472, 260), l.fontSmall,
		rgb(0x8A, 0x93, 0xA0), dtSingleLine|dtVCenter|dtLeft|dtNoPrefix|dtEndEllipsis)
}

const (
	btnPrimary = iota
	btnDefault
)

func (l *launcherWin) drawButton(hdc uintptr, r rectT, label string, kind int, id int) {
	hovered := l.hover == id
	pressed := l.pressed == id

	var fill, border, text uintptr
	switch {
	case kind == btnPrimary && pressed:
		fill, border, text = rgb(0x12, 0x4F, 0x9C), rgb(0x12, 0x4F, 0x9C), rgb(0xFF, 0xFF, 0xFF)
	case kind == btnPrimary && hovered:
		fill, border, text = rgb(0x15, 0x5A, 0xB0), rgb(0x15, 0x5A, 0xB0), rgb(0xFF, 0xFF, 0xFF)
	case kind == btnPrimary:
		fill, border, text = rgb(0x1A, 0x6F, 0xD4), rgb(0x1A, 0x6F, 0xD4), rgb(0xFF, 0xFF, 0xFF)
	case pressed:
		fill, border, text = rgb(0xE6, 0xEB, 0xF3), rgb(0x1A, 0x6F, 0xD4), rgb(0x1F, 0x23, 0x29)
	case hovered:
		fill, border, text = rgb(0xF2, 0xF5, 0xFA), rgb(0x9C, 0xBC, 0xE4), rgb(0x1F, 0x23, 0x29)
	default:
		fill, border, text = rgb(0xFF, 0xFF, 0xFF), rgb(0xD6, 0xDA, 0xE2), rgb(0x1F, 0x23, 0x29)
	}
	roundRectFill(hdc, r, l.px(7), fill, border, int(l.px(1)))
	drawText(hdc, label, r, l.fontBody, text, dtSingleLine|dtVCenter|dtCenter|dtNoPrefix)
}

/* ----------------------------------------------------------- 命中与动作 */

func (l *launcherWin) hitTest(x, y int32) int {
	switch {
	case inRect(l.rcOpen, x, y):
		return btnOpen
	case inRect(l.rcCopy, x, y):
		return btnCopy
	case inRect(l.rcQuit, x, y):
		return btnQuit
	case inRect(l.rcURL, x, y):
		return btnURL
	}
	return btnNone
}

func inRect(r rectT, x, y int32) bool {
	return x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

func (l *launcherWin) activate(id int, hwnd uintptr) {
	switch id {
	case btnOpen, btnURL:
		if l.onOpen != nil {
			l.onOpen()
		}
	case btnCopy:
		if err := setClipboardText(hwnd, l.url); err != nil {
			l.tip = "复制失败：" + err.Error()
		} else {
			l.tip = "已复制：" + l.url
		}
		pSetTimer.Call(hwnd, 1, 2200, 0)
		invalidate(hwnd)
	case btnQuit:
		pPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
}

/* ---------------------------------------------------------------- 尺寸 */

func (l *launcherWin) px(v int32) int32 {
	if l.dpi == 0 {
		return v
	}
	return (v*int32(l.dpi) + 48) / 96
}

func (l *launcherWin) pxRect(left, top, right, bottom int32) rectT {
	return rectT{l.px(left), l.px(top), l.px(right), l.px(bottom)}
}

func (l *launcherWin) layout() {
	l.rcURL = l.pxRect(24, 124, 472, 160)
	l.rcOpen = l.pxRect(24, 180, 192, 218)
	l.rcCopy = l.pxRect(204, 180, 308, 218)
	l.rcQuit = l.pxRect(394, 180, 472, 218)
}

// windowSize 由「客户区目标尺寸 + 实际边框差」反推窗口外框尺寸，
// 比 AdjustWindowRectEx 更省事，且自动适配不同系统主题的边框宽度。
func (l *launcherWin) windowSize() (int32, int32) {
	wantW, wantH := l.px(lwClient), l.px(lhClient)
	var wr, cr rectT
	if ok, _, _ := pGetWindowRect.Call(l.hwnd, uintptr(unsafe.Pointer(&wr))); ok == 0 {
		return wantW, wantH
	}
	pGetClientRect.Call(l.hwnd, uintptr(unsafe.Pointer(&cr)))
	dw := (wr.right - wr.left) - (cr.right - cr.left)
	dh := (wr.bottom - wr.top) - (cr.bottom - cr.top)
	return wantW + dw, wantH + dh
}

/* ---------------------------------------------------------------- 字体 */

func (l *launcherWin) rebuildFonts() {
	l.releaseFonts()
	dpi := int(l.dpi)
	if dpi == 0 {
		dpi = 96
	}
	l.fontTitle = createFont(dpi, 21, true)
	l.fontSub = createFont(dpi, 13, false)
	l.fontBody = createFont(dpi, 14, false)
	l.fontSmall = createFont(dpi, 13, false)
}

func (l *launcherWin) releaseFonts() {
	for _, f := range []uintptr{l.fontTitle, l.fontSub, l.fontBody, l.fontSmall} {
		if f != 0 {
			pDeleteObject.Call(f)
		}
	}
	l.fontTitle, l.fontSub, l.fontBody, l.fontSmall = 0, 0, 0, 0
}

// createFont 的 nHeight 取负值表示「字符高度」而非单元格高度，
// 这样不同字号的行高才符合预期。
func createFont(dpi, logicalPx int, bold bool) uintptr {
	height := -(logicalPx * dpi / 96)
	weight := uintptr(400)
	if bold {
		weight = 700
	}
	face, _ := syscall.UTF16PtrFromString("Microsoft YaHei UI")
	f, _, _ := pCreateFontW.Call(
		uintptr(height), 0, 0, 0, weight, 0, 0, 0,
		1, // DEFAULT_CHARSET
		0, 0,
		5, // CLEARTYPE_QUALITY
		0,
		uintptr(unsafe.Pointer(face)),
	)
	return f
}

/* ------------------------------------------------------------ GDI 小工具 */

func fillRect(hdc uintptr, r rectT, color uintptr) {
	br, _, _ := pCreateSolidBrush.Call(color)
	pFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), br)
	pDeleteObject.Call(br)
}

func fillEllipse(hdc uintptr, r rectT, color uintptr) {
	br, _, _ := pCreateSolidBrush.Call(color)
	pen, _, _ := pCreatePen.Call(psSolid, 0, color)
	oldB, _, _ := pSelectObject.Call(hdc, br)
	oldP, _, _ := pSelectObject.Call(hdc, pen)
	pEllipse.Call(hdc, uintptr(r.left), uintptr(r.top), uintptr(r.right), uintptr(r.bottom))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(br)
	pDeleteObject.Call(pen)
}

func roundRectFill(hdc uintptr, r rectT, radius int32, fill, border uintptr, borderW int) {
	br, _, _ := pCreateSolidBrush.Call(fill)
	pen, _, _ := pCreatePen.Call(psSolid, uintptr(borderW), border)
	oldB, _, _ := pSelectObject.Call(hdc, br)
	oldP, _, _ := pSelectObject.Call(hdc, pen)
	pRoundRect.Call(hdc, uintptr(r.left), uintptr(r.top), uintptr(r.right), uintptr(r.bottom),
		uintptr(radius*2), uintptr(radius*2))
	pSelectObject.Call(hdc, oldB)
	pSelectObject.Call(hdc, oldP)
	pDeleteObject.Call(br)
	pDeleteObject.Call(pen)
}

// negOne 用 -1 表示「按 \0 结尾取整个字符串」；不能写成常量转换，
// 常量 -1 转 uintptr 会直接编译报错。
var negOne = uintptr(0xFFFFFFFF)

func drawText(hdc uintptr, s string, r rectT, font, color uintptr, format uint32) {
	if s == "" || font == 0 {
		return
	}
	old, _, _ := pSelectObject.Call(hdc, font)
	pSetBkMode.Call(hdc, transparent)
	pSetTextColor.Call(hdc, color)
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		pSelectObject.Call(hdc, old)
		return
	}
	pDrawTextW.Call(hdc,
		uintptr(unsafe.Pointer(p)),
		negOne,
		uintptr(unsafe.Pointer(&r)),
		uintptr(format))
	pSelectObject.Call(hdc, old)
}

/* -------------------------------------------------------------- 剪贴板 */

func setClipboardText(hwnd uintptr, s string) error {
	if ok, _, _ := pOpenClipboard.Call(hwnd); ok == 0 {
		return fmt.Errorf("剪贴板被其它程序占用")
	}
	defer pCloseClipboard.Call()
	pEmptyClipboard.Call()

	utf16, err := syscall.UTF16FromString(s)
	if err != nil {
		return err
	}
	size := uintptr(len(utf16) * 2)
	h, _, _ := pGlobalAlloc.Call(gmemMoveable|gmemZeroInit, size)
	if h == 0 {
		return fmt.Errorf("内存不足")
	}
	ptr, _, _ := pGlobalLock.Call(h)
	if ptr == 0 {
		return fmt.Errorf("内存锁定失败")
	}
	// 只做「Go 指针 → uintptr」这一安全方向的转换，避免 go vet 报警
	pRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&utf16[0])), size)
	pGlobalUnlock.Call(h)
	if r, _, _ := pSetClipboardData.Call(cfUnicodeText, h); r == 0 {
		return fmt.Errorf("写入剪贴板失败")
	}
	return nil
}

/* ------------------------------------------------------------ 创建与运行 */

// runLauncherWindow 创建并运行启动器窗口，窗口关闭后返回。
func runLauncherWindow(url string, onOpen func(), autoOpen bool) error {
	inst, _, _ := pGetModuleHandleW.Call(0)
	className, _ := syscall.UTF16PtrFromString("SangforCaseExporterWnd")
	cursor, _, _ := pLoadCursorW.Call(0, uintptr(idcArrow))

	wc := wndClassExW{
		style:         0x0002 | 0x0001, // CS_HREDRAW | CS_VREDRAW
		lpfnWndProc:   wndProcCb,
		hInstance:     inst,
		hCursor:       cursor,
		lpszClassName: className,
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	// 同类名已注册时返回 0，属正常情况，无需处理
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	win := &launcherWin{url: url, onOpen: onOpen, autoOpen: autoOpen, hover: btnNone, pressed: btnNone}
	win.dpi = desktopDPI()

	style := uintptr(wsCaption | wsSysMenu | wsMinimizeBox)
	rawTitle, _ := syscall.UTF16PtrFromString(appName)

	hwnd, _, err := pCreateWindowExW.Call(
		uintptr(wsExAppWindow),
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(rawTitle)),
		style,
		0, 0, uintptr(win.px(lwClient)+24), uintptr(win.px(lhClient)+64),
		0, 0, inst, 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowEx 失败（%v）", err)
	}
	win.hwnd = hwnd
	curWin = win
	appHWND = hwnd

	// 建好后才能读到真实 DPI 与边框宽度，据此收敛尺寸并居中
	if d := dpiOfWindow(hwnd); d > 0 {
		win.dpi = d
	}
	win.rebuildFonts()
	win.layout()

	w, h := win.windowSize()
	x, y := centerOnWorkArea(w, h)
	pSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		uintptr(swpNoZOrder|swpNoActivate))
	pShowWindow.Call(hwnd, swShow)
	pUpdateWindow.Call(hwnd)

	var msg msgT
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
	// 从这里走完，说明窗口已销毁，main 会去关停本地服务
	curWin = nil
	return nil
}

func desktopDPI() uint32 {
	hdc, _, _ := pGetDC.Call(0)
	if hdc == 0 {
		return 96
	}
	defer pReleaseDC.Call(0, hdc)
	dpi, _, _ := pGetDeviceCaps.Call(hdc, logPixelsX)
	if dpi < 72 || dpi > 480 {
		return 96
	}
	return uint32(dpi)
}

func dpiOfWindow(hwnd uintptr) uint32 {
	if pGetDpiForWindow.Find() != nil {
		return 0
	}
	if d, _, _ := pGetDpiForWindow.Call(hwnd); d >= 72 && d <= 480 {
		return uint32(d)
	}
	return 0
}

func centerOnWorkArea(w, h int32) (int32, int32) {
	var work rectT
	ok, _, _ := pSystemParametersInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&work)), 0)
	if ok == 0 {
		return 120, 120
	}
	x := work.left + ((work.right-work.left)-w)/2
	y := work.top + ((work.bottom-work.top)-h)/2
	return x, y
}
