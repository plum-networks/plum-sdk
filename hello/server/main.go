// Box-side service for this app. Core launches one copy per (user, app) under
// the app's own uid, hands it a unix socket in PLUM_APP_SOCKET, and proxies
// /apps/<id>/svc/* to it with the caller's identity in X-Plum-* headers.
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
)

func main() {
	log.SetFlags(0) // core timestamps every line for you

	sock := os.Getenv("PLUM_APP_SOCKET")
	if sock == "" {
		log.Fatal("PLUM_APP_SOCKET not set: this binary is started by the Plum supervisor")
	}
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatalf("listen %s: %v", sock, err)
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/whoami", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"userId":   r.Header.Get("X-Plum-User-Id"),
			"username": r.Header.Get("X-Plum-Username"),
			"appId":    r.Header.Get("X-Plum-App-Id"),
			"perms":    r.Header.Get("X-Plum-Perms"),
			"dataDir":  os.Getenv("PLUM_APP_DATA_DIR"),
			"version":  os.Getenv("PLUM_APP_VERSION"),
		})
	})

	log.Printf("listening on %s", sock)
	if err := (&http.Server{Handler: mux}).Serve(ln); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
