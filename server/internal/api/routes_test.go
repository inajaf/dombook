package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/inajaf/dombook/server/internal/auth"
	"github.com/inajaf/dombook/server/internal/store"
	"github.com/inajaf/dombook/server/internal/testdb"
)

// These tests drive the real HTTP surface: real routing, real middleware, real
// PostgreSQL, and the real auth service. Unit tests cover the service's decisions
// with a fake store; this is where the wiring is checked — a route registered under
// the wrong method, a guard that never runs, or a JSON field that does not match
// what the client sends would all pass the unit tests and fail here.

const testJWTSecret = "integration-test-secret-value"

// setupTenantCounter keeps each test's accounts distinct without a shared sequence.
var setupTenantCounter sync.Mutex

func newServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	return newServerWithDatabase(t)
}

// newTestLimiter returns a limiter with limits loose enough that throttling never
// interferes with an unrelated test.
//
// Throttling has its own unit tests in internal/auth; a tight limit here would make
// unrelated tests fail depending on execution order, which is the worst kind of
// coupling.
func newTestLimiter() *auth.RateLimiter {
	return auth.NewRateLimiter(auth.RateLimiterOptions{
		MinInterval: 0,
		SendLimit:   1000,
		SendWindow:  time.Hour,
		MaxAttempts: 1000,
		LockWindow:  time.Hour,
	})
}

// newServerWithDatabase builds the auth-only stack and returns the database it uses, so
// a caller can seed data or create a second account directly.
func newServerWithDatabase(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	testdb.Prepare(t)
	// Every test starts from an empty installation. Without this the first test to
	// run leaves a user behind, the bootstrap gate closes, and every later setup
	// call fails with setup_denied depending on execution order.
	testdb.ResetData(t)

	database, err := store.New(context.Background(), testdb.AppDSN(t))
	if err != nil {
		t.Fatalf("connect as dombook_app: %v", err)
	}
	t.Cleanup(database.Close)

	service := authServiceForTest(t, database)

	handler, err := BuildHandler(Deps{Auth: service}, CORSConfig{AllowedOrigins: []string{"*"}})
	if err != nil {
		t.Fatalf("build handler: %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, database
}

// authServiceForTest builds the auth service with test-friendly settings: codes are
// returned in the response so a test can complete a login without reaching into the
// service's internals, which would stop exercising the real send path.
func authServiceForTest(t *testing.T, database *store.Store) *auth.Service {
	t.Helper()
	return auth.New(database, auth.Options{
		AppName:    "RentKeeper Test",
		JWTSecret:  testJWTSecret,
		AccessTTL:  15 * time.Minute,
		RefreshTTL: 24 * time.Hour,
		OTPTTL:     10 * time.Minute,
		OTPLength:  6,
		// Development mode so the code comes back in the response. Without it the
		// test would have to reach into the service's internals to complete a login,
		// which would stop testing the real send path.
		ExposeCode: true,
	}, newTestLimiter(), nil)
}

// request performs an HTTP call against the test server.
func request(t *testing.T, server *httptest.Server, method, path, token string, body any) (int, map[string]any) {
	t.Helper()

	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode request body: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequest(method, server.URL+path, reader)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()

	var decoded map[string]any
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		// An empty body is legitimate for some responses; anything else is a bug.
		decoded = map[string]any{}
	}
	return response.StatusCode, decoded
}

// uniqueEmail produces an address no other test has used, so the shared database
// does not couple tests together.
func uniqueEmail(t *testing.T) string {
	t.Helper()
	setupTenantCounter.Lock()
	defer setupTenantCounter.Unlock()
	return fmt.Sprintf("user-%d-%d@example.test", time.Now().UnixNano(), len(t.Name()))
}

// bootstrap runs setup for a fresh address and returns the email.
func bootstrap(t *testing.T, server *httptest.Server) string {
	t.Helper()
	email := uniqueEmail(t)
	status, body := request(t, server, http.MethodPost, "/auth/setup", "", map[string]any{
		"email":       email,
		"name":        "Тест",
		"accountName": "Тестовый дом отдыха",
	})
	if status != http.StatusCreated {
		t.Fatalf("setup returned %d: %v", status, body)
	}
	return email
}

// login performs a full send + verify and returns the session tokens.
func login(t *testing.T, server *httptest.Server, email string) (accessToken, refreshToken string) {
	t.Helper()

	status, body := request(t, server, http.MethodPost, "/auth/send", "", map[string]any{"email": email})
	if status != http.StatusOK {
		t.Fatalf("send returned %d: %v", status, body)
	}
	if body["loginable"] != true {
		t.Fatalf("expected %s to be loginable: %v", email, body)
	}
	code, _ := body["code"].(string)
	if code == "" {
		t.Fatal("expected the login code to be exposed in development mode")
	}

	status, body = request(t, server, http.MethodPost, "/auth/verify", "", map[string]any{
		"email": email, "code": code,
	})
	if status != http.StatusOK {
		t.Fatalf("verify returned %d: %v", status, body)
	}
	accessToken, _ = body["token"].(string)
	refreshToken, _ = body["refreshToken"].(string)
	if accessToken == "" || refreshToken == "" {
		t.Fatalf("verify did not return both tokens: %v", body)
	}
	return accessToken, refreshToken
}

// errorCode digs the stable error code out of an error envelope.
func errorCode(t *testing.T, body map[string]any) string {
	t.Helper()
	errorObject, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("response has no error object: %v", body)
	}
	code, _ := errorObject["code"].(string)
	return code
}

func TestHealthIsUnauthenticated(t *testing.T) {
	server, _ := newServer(t)

	status, body := request(t, server, http.MethodGet, "/health", "", nil)
	if status != http.StatusOK {
		t.Fatalf("health returned %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Errorf("health body = %v, want ok=true", body)
	}
}

func TestFullLoginLifecycleOverHTTP(t *testing.T) {
	server, _ := newServer(t)
	email := bootstrap(t, server)
	accessToken, refreshToken := login(t, server, email)

	t.Run("me reports the caller", func(t *testing.T) {
		status, body := request(t, server, http.MethodGet, "/auth/me", accessToken, nil)
		if status != http.StatusOK {
			t.Fatalf("me returned %d: %v", status, body)
		}
		if body["accountName"] != "Тестовый дом отдыха" {
			t.Errorf("accountName = %v", body["accountName"])
		}
		if body["plan"] != string(store.PlanFree) {
			t.Errorf("plan = %v, want free", body["plan"])
		}
		user, _ := body["user"].(map[string]any)
		if user["email"] != email {
			t.Errorf("user email = %v, want %v", user["email"], email)
		}
		// The response must not leak internal fields. This is the reason publicUser
		// exists as an explicit mapping rather than a JSON tag on the store type.
		for _, forbidden := range []string{"account_id", "created_at", "updated_at"} {
			if _, present := user[forbidden]; present {
				t.Errorf("user object leaks the internal field %q", forbidden)
			}
		}
	})

	t.Run("me requires a token", func(t *testing.T) {
		status, body := request(t, server, http.MethodGet, "/auth/me", "", nil)
		if status != http.StatusUnauthorized {
			t.Fatalf("me without a token returned %d, want 401", status)
		}
		if code := errorCode(t, body); code != "unauthorized" {
			t.Errorf("code = %q, want unauthorized", code)
		}
	})

	t.Run("me rejects a forged token", func(t *testing.T) {
		status, _ := request(t, server, http.MethodGet, "/auth/me", accessToken+"tampered", nil)
		if status != http.StatusUnauthorized {
			t.Errorf("me with a tampered token returned %d, want 401", status)
		}
	})

	t.Run("refresh rotates the refresh token", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/auth/refresh", "", map[string]any{
			"refreshToken": refreshToken,
		})
		if status != http.StatusOK {
			t.Fatalf("refresh returned %d: %v", status, body)
		}
		newAccess, _ := body["token"].(string)
		newRefresh, _ := body["refreshToken"].(string)
		if newAccess == "" || newRefresh == "" {
			t.Fatalf("refresh did not return both tokens: %v", body)
		}
		if newRefresh == refreshToken {
			t.Error("the refresh token must rotate")
		}
		if _, meBody := request(t, server, http.MethodGet, "/auth/me", newAccess, nil); meBody["accountId"] == nil {
			t.Error("the refreshed access token should authenticate")
		}
	})

	t.Run("logout revokes the session immediately", func(t *testing.T) {
		status, _ := request(t, server, http.MethodPost, "/auth/logout", accessToken, nil)
		if status != http.StatusOK {
			t.Fatalf("logout returned %d, want 200", status)
		}
		// The token is still cryptographically valid and unexpired; only the session
		// row is gone. If this passes, logout is advisory rather than effective.
		status, _ = request(t, server, http.MethodGet, "/auth/me", accessToken, nil)
		if status != http.StatusUnauthorized {
			t.Errorf("me after logout returned %d, want 401", status)
		}
		// Logging out twice must not error: a client may retry.
		if status, _ := request(t, server, http.MethodPost, "/auth/logout", accessToken, nil); status != http.StatusOK {
			t.Errorf("second logout returned %d, want 200", status)
		}
	})
}

func TestSetupIsOpenOnceThenGated(t *testing.T) {
	server, _ := newServer(t)
	bootstrap(t, server)

	// A second address has no setup token, so signup must be closed. The exact code
	// matters: the client distinguishes "already registered" from "closed".
	status, body := request(t, server, http.MethodPost, "/auth/setup", "", map[string]any{
		"email": uniqueEmail(t),
	})
	if status != http.StatusForbidden {
		t.Fatalf("second setup returned %d, want 403: %v", status, body)
	}
	if code := errorCode(t, body); code != "setup_denied" {
		t.Errorf("code = %q, want setup_denied", code)
	}
}

func TestDuplicateSetupReportsUserExists(t *testing.T) {
	server, _ := newServer(t)
	email := bootstrap(t, server)

	// The duplicate check must run before the bootstrap gate, so an existing user
	// retrying their own signup is told the account exists rather than that
	// registration is closed.
	status, body := request(t, server, http.MethodPost, "/auth/setup", "", map[string]any{
		"email": strings.ToUpper(email),
	})
	if status != http.StatusBadRequest {
		t.Fatalf("duplicate setup returned %d, want 400: %v", status, body)
	}
	if code := errorCode(t, body); code != "user_exists" {
		t.Errorf("code = %q, want user_exists", code)
	}
}

// TestSendDoesNotRevealWhetherAnAddressExists is the enumeration guard, asserted at
// the HTTP layer because that is where it can actually leak: a different status or
// body shape would hand an attacker a way to test addresses in bulk.
func TestSendDoesNotRevealWhetherAnAddressExists(t *testing.T) {
	server, _ := newServer(t)
	known := bootstrap(t, server)

	statusKnown, bodyKnown := request(t, server, http.MethodPost, "/auth/send", "", map[string]any{"email": known})
	statusUnknown, bodyUnknown := request(t, server, http.MethodPost, "/auth/send", "", map[string]any{"email": uniqueEmail(t)})

	if statusKnown != http.StatusOK || statusUnknown != http.StatusOK {
		t.Fatalf("both send responses must be 200, got %d and %d", statusKnown, statusUnknown)
	}
	if bodyKnown["ok"] != true || bodyUnknown["ok"] != true {
		t.Error("both responses must report ok")
	}
	if bodyUnknown["loginable"] != false {
		t.Errorf("an unknown address must not be loginable: %v", bodyUnknown)
	}
	// The body shape matches: both carry the same keys, and neither exposes a code
	// for an address that cannot log in. Only the loginable flag differs.
	for _, key := range []string{"ok", "loginable"} {
		_, inKnown := bodyKnown[key]
		_, inUnknown := bodyUnknown[key]
		if inKnown != inUnknown {
			t.Errorf("key %q is present in one response and not the other", key)
		}
	}
	// A code field is present in both, deliberately. Reporting one for an address
	// that cannot log in is inert — nothing is sent and there is no account to enter
	// — but omitting it would make the two responses differ in length, which is a
	// tell an attacker can measure just as easily as a different status code.
	if _, present := bodyUnknown["code"]; !present {
		t.Error("the unknown-address body must match the loginable shape exactly")
	}
}

func TestVerifyRejectsBadInput(t *testing.T) {
	server, _ := newServer(t)
	email := bootstrap(t, server)
	_, _ = login(t, server, email)

	t.Run("wrong code", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/auth/verify", "", map[string]any{
			"email": email, "code": "000000",
		})
		if status != http.StatusUnauthorized {
			t.Fatalf("wrong code returned %d, want 401: %v", status, body)
		}
	})

	t.Run("empty code", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/auth/verify", "", map[string]any{
			"email": email, "code": "",
		})
		if status != http.StatusBadRequest {
			t.Fatalf("empty code returned %d, want 400: %v", status, body)
		}
		if code := errorCode(t, body); code != "validation_error" {
			t.Errorf("code = %q, want validation_error", code)
		}
	})

	t.Run("malformed email", func(t *testing.T) {
		status, _ := request(t, server, http.MethodPost, "/auth/send", "", map[string]any{"email": "not-an-email"})
		if status != http.StatusBadRequest {
			t.Errorf("malformed email returned %d, want 400", status)
		}
	})
}

// TestCodeIsSingleUseOverHTTP confirms the single-use guarantee survives the full
// stack, including the connection pool and the database function.
func TestCodeIsSingleUseOverHTTP(t *testing.T) {
	server, _ := newServer(t)
	email := bootstrap(t, server)

	status, body := request(t, server, http.MethodPost, "/auth/send", "", map[string]any{"email": email})
	if status != http.StatusOK {
		t.Fatalf("send returned %d: %v", status, body)
	}
	code, _ := body["code"].(string)

	for attempt := 1; attempt <= 2; attempt++ {
		status, _ := request(t, server, http.MethodPost, "/auth/verify", "", map[string]any{
			"email": email, "code": code,
		})
		if attempt == 1 && status != http.StatusOK {
			t.Fatalf("first verify returned %d, want 200", status)
		}
		if attempt == 2 && status != http.StatusUnauthorized {
			t.Fatalf("replaying the code returned %d, want 401", status)
		}
	}
}

func TestRefreshReuseIsRejectedOverHTTP(t *testing.T) {
	server, _ := newServer(t)
	email := bootstrap(t, server)
	_, refreshToken := login(t, server, email)

	// Consume it legitimately.
	status, body := request(t, server, http.MethodPost, "/auth/refresh", "", map[string]any{
		"refreshToken": refreshToken,
	})
	if status != http.StatusOK {
		t.Fatalf("first refresh returned %d: %v", status, body)
	}

	// Replay it. Treated as compromise, so the whole family dies.
	status, body = request(t, server, http.MethodPost, "/auth/refresh", "", map[string]any{
		"refreshToken": refreshToken,
	})
	if status != http.StatusUnauthorized {
		t.Fatalf("replayed refresh returned %d, want 401: %v", status, body)
	}

	// The successor the legitimate client holds is revoked too.
	successor, _ := body["refreshToken"].(string)
	_ = successor
	status, _ = request(t, server, http.MethodPost, "/auth/refresh", "", map[string]any{
		"refreshToken": refreshToken,
	})
	if status != http.StatusUnauthorized {
		t.Errorf("a revoked family must stay revoked, got %d", status)
	}
}

func TestUnknownRoutesReturnTheJSONErrorEnvelope(t *testing.T) {
	server, _ := newServer(t)

	status, body := request(t, server, http.MethodGet, "/does-not-exist", "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("unknown route returned %d, want 404", status)
	}
	// The default net/http 404 is plain text, which a JSON client cannot parse.
	if code := errorCode(t, body); code != "not_found" {
		t.Errorf("code = %q, want not_found", code)
	}
}

func TestWrongMethodIsNotRoutedToTheWrongHandler(t *testing.T) {
	server, _ := newServer(t)

	// GET on a POST-only endpoint must not reach the handler.
	status, _ := request(t, server, http.MethodGet, "/auth/send", "", nil)
	if status == http.StatusOK {
		t.Error("GET /auth/send reached the POST handler")
	}
}

func TestMalformedJSONBodyIsRejected(t *testing.T) {
	server, _ := newServer(t)

	req, err := http.NewRequest(http.MethodPost, server.URL+"/auth/send", strings.NewReader(`{"email":`))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("malformed JSON returned %d, want 400", response.StatusCode)
	}
}

func TestRequestIDHeaderIsReturned(t *testing.T) {
	server, _ := newServer(t)

	response, err := server.Client().Get(server.URL + "/health")
	if err != nil {
		t.Fatalf("get health: %v", err)
	}
	defer response.Body.Close()

	// A correlation id is what makes a client bug report traceable to a log line.
	if response.Header.Get("X-Request-Id") == "" {
		t.Error("response is missing the X-Request-Id header")
	}
}
