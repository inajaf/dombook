package crypto

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const testSecret = "test-secret-for-unit-tests-only"

func TestJWTSecretIsRequired(t *testing.T) {
	// An empty secret must fail closed. If it were allowed, every deployment that
	// forgot to set one would issue tokens forgeable by anyone.
	if _, err := SignJWT(Claims{Subject: "u"}, "", time.Hour, time.Now()); err == nil {
		t.Error("SignJWT must reject an empty secret")
	}
	if _, err := VerifyJWT("a.b.c", "", time.Now()); err == nil {
		t.Error("VerifyJWT must reject an empty secret")
	}
}

func TestSignAndVerifyRoundTrip(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	want := Claims{
		Subject:   "11111111-1111-1111-1111-111111111111",
		Account:   "22222222-2222-2222-2222-222222222222",
		Role:      "owner",
		Email:     "owner@example.test",
		SessionID: "33333333-3333-3333-3333-333333333333",
	}

	token, err := SignJWT(want, testSecret, time.Hour, now)
	if err != nil {
		t.Fatalf("SignJWT: %v", err)
	}
	got, err := VerifyJWT(token, testSecret, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("VerifyJWT: %v", err)
	}

	if got.Subject != want.Subject || got.Account != want.Account || got.Role != want.Role ||
		got.Email != want.Email || got.SessionID != want.SessionID {
		t.Errorf("claims round-tripped incorrectly:\n got %+v\nwant %+v", got, want)
	}
	if got.IssuedAt != now.Unix() {
		t.Errorf("IssuedAt = %d, want %d", got.IssuedAt, now.Unix())
	}
	if got.ExpiresAt != now.Add(time.Hour).Unix() {
		t.Errorf("ExpiresAt = %d, want %d", got.ExpiresAt, now.Add(time.Hour).Unix())
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	now := time.Now()
	token, err := SignJWT(Claims{Subject: "u", SessionID: "s"}, testSecret, time.Hour, now)
	if err != nil {
		t.Fatalf("SignJWT: %v", err)
	}
	if _, err := VerifyJWT(token, "a-different-secret", now); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("expected ErrInvalidToken for a wrong secret, got %v", err)
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	now := time.Now()
	token, err := SignJWT(Claims{Subject: "user-a", SessionID: "s"}, testSecret, time.Hour, now)
	if err != nil {
		t.Fatalf("SignJWT: %v", err)
	}

	// Swap in a payload claiming to be a different user, keeping the signature.
	parts := strings.Split(token, ".")
	forged, err := json.Marshal(Claims{Subject: "user-b", SessionID: "s", ExpiresAt: now.Add(time.Hour).Unix()})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	parts[1] = base64.RawURLEncoding.EncodeToString(forged)
	tampered := strings.Join(parts, ".")

	if _, err := VerifyJWT(tampered, testSecret, now); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("expected ErrInvalidToken for a tampered payload, got %v", err)
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	token, err := SignJWT(Claims{Subject: "u", SessionID: "s"}, testSecret, time.Minute, now)
	if err != nil {
		t.Fatalf("SignJWT: %v", err)
	}

	// Distinguishing expiry lets the server answer "refresh your session"
	// instead of "you are not authenticated".
	if _, err := VerifyJWT(token, testSecret, now.Add(2*time.Minute)); !errors.Is(err, ErrExpiredToken) {
		t.Errorf("expected ErrExpiredToken, got %v", err)
	}

	// The boundary itself counts as expired: a token is valid for its TTL, not
	// one instant longer.
	if _, err := VerifyJWT(token, testSecret, now.Add(time.Minute)); !errors.Is(err, ErrExpiredToken) {
		t.Errorf("expected expiry at the exact boundary, got %v", err)
	}
}

func TestVerifyRejectsNoneAlgorithm(t *testing.T) {
	// The classic JWT attack: claim alg=none with an empty signature. A verifier
	// that trusts the token's own header would accept this.
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	claims := base64.RawURLEncoding.EncodeToString(
		[]byte(`{"sub":"attacker","jti":"x","exp":99999999999}`))
	forged := header + "." + claims + "."

	if _, err := VerifyJWT(forged, testSecret, time.Now()); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("expected ErrInvalidToken for alg=none, got %v", err)
	}
}

func TestVerifyRejectsMalformedTokens(t *testing.T) {
	now := time.Now()
	for _, token := range []string{
		"",
		"only-one-part",
		"two.parts",
		"four.parts.here.now",
		"!!!.!!!.!!!",
	} {
		if _, err := VerifyJWT(token, testSecret, now); err == nil {
			t.Errorf("VerifyJWT(%q) should have failed", token)
		}
	}
}

func TestVerifyRejectsMissingRequiredClaims(t *testing.T) {
	now := time.Now()
	// A structurally valid, correctly signed token that simply lacks a subject
	// must still be refused: the signature proves origin, not usefulness.
	for name, claims := range map[string]Claims{
		"no subject": {SessionID: "s"},
		"no session": {Subject: "u"},
	} {
		token, err := SignJWT(claims, testSecret, time.Hour, now)
		if err != nil {
			t.Fatalf("%s: SignJWT: %v", name, err)
		}
		if _, err := VerifyJWT(token, testSecret, now); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s: expected ErrInvalidToken, got %v", name, err)
		}
	}

	// A token with no `exp` cannot be produced by SignJWT, so it is assembled by
	// hand. This is the "never expires" case: a verifier that only checks
	// `exp > now` reads a missing exp as far-future and accepts the token
	// forever, so its absence must be an explicit rejection.
	claims := Claims{Subject: "u", SessionID: "s", IssuedAt: now.Unix()}
	encodedClaims, err := encodeSegment(claims)
	if err != nil {
		t.Fatalf("encode claims: %v", err)
	}
	encodedHeader, err := encodeSegment(map[string]string{"alg": expectedAlg, "typ": "JWT"})
	if err != nil {
		t.Fatalf("encode header: %v", err)
	}
	unsigned := encodedHeader + "." + encodedClaims
	noExpiry := unsigned + "." + base64.RawURLEncoding.EncodeToString(sign(unsigned, testSecret))

	if _, err := VerifyJWT(noExpiry, testSecret, now); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("no expiry: expected ErrInvalidToken, got %v", err)
	}
}

func TestSignJWTRejectsNonPositiveTTL(t *testing.T) {
	for _, ttl := range []time.Duration{0, -time.Hour} {
		if _, err := SignJWT(Claims{Subject: "u", SessionID: "s"}, testSecret, ttl, time.Now()); err == nil {
			t.Errorf("SignJWT must reject ttl=%s", ttl)
		}
	}
}

func TestOTPCodeShapeAndDistribution(t *testing.T) {
	for _, length := range []int{4, 6, 8} {
		code, err := OTPCode(length)
		if err != nil {
			t.Fatalf("OTPCode(%d): %v", length, err)
		}
		if len(code) != length {
			t.Errorf("OTPCode(%d) returned %q with length %d", length, code, len(code))
		}
		for _, r := range code {
			if r < '0' || r > '9' {
				t.Errorf("OTPCode(%d) returned a non-digit: %q", length, code)
			}
		}
	}

	if _, err := OTPCode(0); err == nil {
		t.Error("OTPCode(0) must fail")
	}
	if _, err := OTPCode(-1); err == nil {
		t.Error("OTPCode(-1) must fail")
	}
}

// TestOTPCodeUsesFullDigitRange is a weak entropy smoke test: modulo bias would
// not show up in a handful of draws, but a generator stuck on a narrow range
// would. Deeper statistical testing belongs in a dedicated tool, not the unit
// suite.
func TestOTPCodeUsesFullDigitRange(t *testing.T) {
	seen := map[rune]bool{}
	for i := 0; i < 300; i++ {
		code, err := OTPCode(6)
		if err != nil {
			t.Fatalf("OTPCode: %v", err)
		}
		for _, r := range code {
			seen[r] = true
		}
	}
	if len(seen) < 10 {
		t.Errorf("saw only %d distinct digits across 1800 draws: %v", len(seen), seen)
	}
}

func TestRandomTokenIsUniqueAndURLSafe(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		token, err := RandomToken(32)
		if err != nil {
			t.Fatalf("RandomToken: %v", err)
		}
		if seen[token] {
			t.Fatalf("RandomToken repeated a value: %q", token)
		}
		seen[token] = true

		if strings.ContainsAny(token, "+/=") {
			t.Errorf("token %q is not URL-safe", token)
		}
		if len(token) < 40 {
			t.Errorf("token %q is shorter than expected for 32 bytes", token)
		}
	}

	if _, err := RandomToken(0); err == nil {
		t.Error("RandomToken(0) must fail")
	}
}

func TestNewUUIDShapeAndUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id, err := NewUUID()
		if err != nil {
			t.Fatalf("NewUUID: %v", err)
		}
		if seen[id] {
			t.Fatalf("NewUUID repeated a value: %q", id)
		}
		seen[id] = true

		if len(id) != 36 {
			t.Fatalf("uuid %q has length %d, want 36", id, len(id))
		}
		if id[14] != '4' {
			t.Errorf("uuid %q is not version 4", id)
		}
		if !strings.ContainsRune("89ab", rune(id[19])) {
			t.Errorf("uuid %q has the wrong variant nibble", id)
		}
	}
}

func TestSHA256HexIsStable(t *testing.T) {
	// Known-answer test: if this changes, every stored hash becomes invalid.
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := SHA256Hex("abc"); got != want {
		t.Errorf("SHA256Hex(abc) = %s, want %s", got, want)
	}
	if SHA256Hex("abc") == SHA256Hex("abd") {
		t.Error("SHA256Hex collided on distinct inputs")
	}
}

func TestConstantTimeEqual(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"secret", "secret", true},
		{"", "", true},
		{"secret", "secreT", false},
		{"secret", "secret-longer", false},
		{"secret-longer", "secret", false},
		{"secret", "", false},
	}
	for _, testCase := range cases {
		if got := ConstantTimeEqual(testCase.a, testCase.b); got != testCase.want {
			t.Errorf("ConstantTimeEqual(%q, %q) = %v, want %v", testCase.a, testCase.b, got, testCase.want)
		}
	}
}
