package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// 本地服务只服务本机界面。设置域名白名单，避免这个代理被当成
// 「任意地址转发」的跳板（SSRF）。
var allowedHostSuffixes = []string{"sangfor.com.cn"}

const (
	maxTextBody  = 32 << 20
	maxImageBody = 24 << 20
	upstreamUA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0"
	upstreamReferer = "https://support.sangfor.com.cn/cases/list"
	upstreamOrigin  = "https://support.sangfor.com.cn"
)

type serverApp struct {
	url    string
	srv    *http.Server
	ln     net.Listener
	onQuit func()
}

type proxyRequest struct {
	URL    string `json:"url"`
	Method string `json:"method"`
	Body   string `json:"body"`
}

type proxyResponse struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status"`
	Body   string `json:"body,omitempty"`
	Error  string `json:"error,omitempty"`
}

func startServer(webRoot fs.FS, port int) (*serverApp, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, err
	}
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return nil, errors.New("无法获取监听端口")
	}

	app := &serverApp{
		url: fmt.Sprintf("http://127.0.0.1:%d/", tcpAddr.Port),
		ln:  ln,
	}
	client := newUpstreamClient()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"name":    appName,
			"version": appVersion,
			"port":    tcpAddr.Port,
		})
	})
mux.HandleFunc("/api/proxy", func(w http.ResponseWriter, r *http.Request) {
    if !guard(w, r) {
        return
    }
    handleProxy(w, r, client)
})
mux.HandleFunc("/api/image", func(w http.ResponseWriter, r *http.Request) {
    if !guard(w, r) {
        return
    }
    handleImage(w, r, client)
})
mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
    if !guard(w, r) {
        return
    }
    writeJSON(w, map[string]any{"ok": true})
    if app.onQuit != nil {
        go app.onQuit()
    }
})
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", noCache(http.FileServer(http.FS(webRoot))))

	app.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		if err := app.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// 服务异常退出时没有别的渠道可报，写一份日志到临时目录备查
			writeCrashLog(err)
		}
	}()
	return app, nil
}

// guard 拒绝来自其它页面的调用。同源请求要么不带 Origin（GET），
// 要么带的正是我们自己的地址（POST）。
func guard(w http.ResponseWriter, r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}

	u, err := url.Parse(o)
	if err != nil || !strings.EqualFold(u.Host, r.Host) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return false
	}
	return true
}

func newUpstreamClient() *http.Client {
	// 不显式设置拨号超时的话，Windows 上 SYN 无响应要拖满约 21 秒才报错
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	tr := &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
	}
	return &http.Client{Timeout: 120 * time.Second, Transport: tr}
}

func handleProxy(w http.ResponseWriter, r *http.Request, client *http.Client) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req proxyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeProxyErr(w, "请求解析失败："+err.Error())
		return
	}
	target, err := checkTarget(req.URL)
	if err != nil {
		writeProxyErr(w, err.Error())
		return
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		writeProxyErr(w, "不支持的方法："+method)
		return
	}

	var body io.Reader
	if req.Body != "" {
		body = strings.NewReader(req.Body)
	}
	up, err := http.NewRequestWithContext(r.Context(), method, target.String(), body)
	if err != nil {
		writeProxyErr(w, "构造上游请求失败："+err.Error())
		return
	}
	setUpstreamHeaders(up, req.Body != "")

	resp, err := client.Do(up)
	if err != nil {
		writeProxyErr(w, "请求上游失败："+err.Error())
		return
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxTextBody))
	if err != nil {
		writeProxyErr(w, "读取上游响应失败："+err.Error())
		return
	}
	writeJSON(w, proxyResponse{OK: true, Status: resp.StatusCode, Body: string(data)})
}

// handleImage 把正文里的配图取回本地，供界面转成 base64 内嵌，
// 从而绕开浏览器对跨域图片「能显示但不能读取字节」的限制。
func handleImage(w http.ResponseWriter, r *http.Request, client *http.Client) {
	target, err := checkTarget(r.URL.Query().Get("url"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	up, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	up.Header.Set("User-Agent", upstreamUA)
	up.Header.Set("Referer", upstreamReferer)

	resp, err := client.Do(up)
	if err != nil {
		http.Error(w, "请求图片失败："+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	ct := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if !strings.HasPrefix(ct, "image/") {
		http.Error(w, "上游返回的不是图片（"+ct+"）", http.StatusUnsupportedMediaType)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBody))
	if err != nil {
		http.Error(w, "读取图片失败："+err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}

func checkTarget(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("缺少目标地址")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("目标地址无法解析")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errors.New("只支持 http/https 地址")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return nil, errors.New("目标地址缺少主机名")
	}
	if net.ParseIP(host) != nil {
		return nil, errors.New("不接受 IP 形式的地址")
	}
	if !hostAllowed(host) {
		return nil, errors.New("目标域名不在白名单内：" + host)
	}
	return u, nil
}

func hostAllowed(host string) bool {
	for _, suffix := range allowedHostSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

func setUpstreamHeaders(req *http.Request, hasBody bool) {
	req.Header.Set("User-Agent", upstreamUA)
	req.Header.Set("Accept", "application/vnd.edusoho.v2+json")
	req.Header.Set("X-Requested-With", "xmlhttprequest")
	req.Header.Set("Referer", upstreamReferer)
	req.Header.Set("Origin", upstreamOrigin)
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
}

func writeProxyErr(w http.ResponseWriter, msg string) {
	writeJSON(w, proxyResponse{OK: false, Error: msg})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		next.ServeHTTP(w, r)
	})
}
