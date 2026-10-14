// Package crypto holds RentKeeper's token and hashing primitives: HMAC-SHA256
// session JWTs, one-time login codes, opaque tokens for refresh and invites, and
// constant-time comparison.
//
// Everything here is deliberately small and dependency-free. A JWT verifier is
// exactly the kind of code where a library's extra features (algorithm
// negotiation, key discovery, `none`) become attack surface; the contract here is
// one algorithm and one secret.
package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// claimsHeader is the only JOSE header this server will accept. It is compared
// literally: accepting the header from the token would reintroduce algorithm
// confusion, where an attacker picks the algorithm the verifier then honors.
const expectedAlg = "HS256"

// Claims is the verified payload of a session token.
type Claims struct {
	// Subject is the user id.
	Subject string `json:"sub"`
	// Account is the tenant (account) id, carried so every request can scope
	// without a database round trip just to find the tenant.
	Account string `json:"act"`
	Role    string `json:"role"`
	Email   string `json:"email"`
	// SessionID is the jti, matching sessions.id, which makes a token
	// revocable before its natural expiry.
	SessionID string `json:"jti"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// ErrInvalidToken covers every rejection reason. The specific cause is
// deliberately not distinguished for callers: an attacker should not learn
// whether a token was expired, unsigned, or for the wrong account.
var ErrInvalidToken = errors.New("crypto: invalid token")

// ErrExpiredToken is returned separately because the server needs it to tell a
// client "refresh your session" rather than "you are not authenticated". It is
// not exposed to unauthenticated callers.
var ErrExpiredToken = errors.New("crypto: token expired")

// NewUUID returns a random RFC 4122 version 4 UUID string.
func NewUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("crypto: read random bytes: %w", err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}

// RandomToken returns a URL-safe opaque token with byteLength bytes of entropy.
// Used for refresh tokens and invite links, where the value must be
// unguessable rather than merely unique.
func RandomToken(byteLength int) (string, error) {
	if byteLength <= 0 {
		return "", fmt.Errorf("crypto: token length must be positive, got %d", byteLength)
	}
	bytes := make([]byte, byteLength)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("crypto: read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

// OTPCode returns a numeric one-time code of the requested length.
//
// Each digit is drawn uniformly from 0-9 via crypto/rand's rejection sampling.
// Taking a random byte modulo 10 instead would bias the first six digits
// (256 = 25*10 + 6), which shrinks the effective keyspace of a short-lived
// credential for no reason.
func OTPCode(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("crypto: otp length must be positive, got %d", length)
	}
	var builder strings.Builder
	builder.Grow(length)
	ten := big.NewInt(10)
	for i := 0; i < length; i++ {
		digit, err := rand.Int(rand.Reader, ten)
		if err != nil {
			return "", fmt.Errorf("crypto: read random digit: %w", err)
		}
		builder.WriteByte(byte('0' + digit.Int64()))
	}
	return builder.String(), nil
}

// SHA256Hex hashes a value for storage. One-time codes and refresh tokens are
// persisted only as hashes, so a database leak does not hand over live
// credentials.
func SHA256Hex(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

// ConstantTimeEqual compares two strings without leaking their common prefix
// length through timing. Used for the admin API key and setup token, where a
// byte-by-byte comparison would allow an attacker to recover the secret one
// character at a time.
func ConstantTimeEqual(a, b string) bool {
	// Comparing digests rather than raw bytes makes the comparison length-safe:
	// hmac.Equal itself returns early on unequal lengths, which would reveal the
	// secret's length.
	digestA := sha256.Sum256([]byte(a))
	digestB := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(digestA[:], digestB[:]) == 1
}

// SignJWT issues an HS256 session token. ttl is added to now; a non-positive ttl
// is rejected rather than producing an already-expired or never-expiring token.
func SignJWT(claims Claims, secret string, ttl time.Duration, now time.Time) (string, error) {
	if secret == "" {
		return "", errors.New("crypto: jwt secret is empty")
	}
	if ttl <= 0 {
		return "", fmt.Errorf("crypto: ttl must be positive, got %s", ttl)
	}

	claims.IssuedAt = now.Unix()
	claims.ExpiresAt = now.Add(ttl).Unix()

	header := map[string]string{"alg": expectedAlg, "typ": "JWT"}
	encodedHeader, err := encodeSegment(header)
	if err != nil {
		return "", err
	}
	encodedClaims, err := encodeSegment(claims)
	if err != nil {
		return "", err
	}

	unsigned := encodedHeader + "." + encodedClaims
	signature := sign(unsigned, secret)
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// VerifyJWT validates the signature and expiry of a session token and returns
// its claims.
func VerifyJWT(token, secret string, now time.Time) (Claims, error) {
	if secret == "" {
		return Claims{}, errors.New("crypto: jwt secret is empty")
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}
	encodedHeader, encodedClaims, encodedSignature := parts[0], parts[1], parts[2]

	// Reject an unexpected header before touching the signature: this is where
	// an "alg" substitution would otherwise be honored.
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(encodedHeader)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return Claims{}, ErrInvalidToken
	}
	if header.Alg != expectedAlg {
		return Claims{}, ErrInvalidToken
	}

	signature, err := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	// hmac.Equal is constant-time, so a forged signature cannot be discovered
	// prefix-by-prefix.
	if !hmac.Equal(signature, sign(encodedHeader+"."+encodedClaims, secret)) {
		return Claims{}, ErrInvalidToken
	}

	claimsBytes, err := base64.RawURLEncoding.DecodeString(encodedClaims)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var claims Claims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return Claims{}, ErrInvalidToken
	}

	if claims.ExpiresAt == 0 {
		return Claims{}, ErrInvalidToken
	}
	if now.Unix() >= claims.ExpiresAt {
		return Claims{}, ErrExpiredToken
	}
	if claims.Subject == "" || claims.SessionID == "" {
		return Claims{}, ErrInvalidToken
	}
	return claims, nil
}

func sign(unsigned, secret string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	return mac.Sum(nil)
}

func encodeSegment(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("crypto: encode jwt segment: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}
