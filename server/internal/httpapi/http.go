// Package httpapi holds the transport layer: routing, authentication
// middleware, error-to-JSON mapping, and request decoding.
//
// The wire contract is unchanged from the Cloudflare Workers implementation it
// replaces, so existing desktop and web clients keep working:
//
//	{"error":{"code":"validation_error","message":"...","details":{...}}}
//
// Handlers return Go errors; this package is the only place that decides an HTTP
// status. Keeping that mapping in one function is what stops a handler from
// accidentally answering 200 with an error body.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// ApiError is a client-visible error carrying a stable machine-readable code, a
// human-facing message, and optional structured details.
type ApiError struct {
	Status  int
	Code    string
	Message string
	Details any
}

func (e *ApiError) Error() string { return e.Message }

// BadRequest reports invalid input.
func BadRequest(code, message string, details any) *ApiError {
	return &ApiError{Status: http.StatusBadRequest, Code: code, Message: message, Details: details}
}

// Unauthorized reports a missing or invalid credential.
func Unauthorized(message string) *ApiError {
	return &ApiError{Status: http.StatusUnauthorized, Code: "unauthorized", Message: message}
}

// BadRequestWithField reports invalid input and names the offending field, so a form
// can highlight the right input instead of showing a message the user has to interpret.
func BadRequestWithField(code, message, field string) *ApiError {
	return &ApiError{
		Status:  http.StatusBadRequest,
		Code:    code,
		Message: message,
		Details: map[string]any{"field": field},
	}
}

// Forbidden reports an authenticated caller lacking permission.
func Forbidden(code, message string) *ApiError {
	return &ApiError{Status: http.StatusForbidden, Code: code, Message: message}
}

// NotFound reports a missing resource.
func NotFound(code, message string) *ApiError {
	if code == "" {
		code = "not_found"
	}
	if message == "" {
		message = "Not found"
	}
	return &ApiError{Status: http.StatusNotFound, Code: code, Message: message}
}

// Conflict reports a state collision, such as a booking overlapping an existing
// stay. It is distinct from BadRequest because clients retry it differently.
func Conflict(code, message string, details any) *ApiError {
	return &ApiError{Status: http.StatusConflict, Code: code, Message: message, Details: details}
}

// PlanLimit reports a quota rejection. The details carry the machine-readable
// cap so a client can render an upgrade prompt without parsing the message.
func PlanLimit(resource string, limit, current int, plan, message string) *ApiError {
	return &ApiError{
		Status:  http.StatusForbidden,
		Code:    "plan_limit",
		Message: message,
		Details: map[string]any{
			"resource": resource,
			"limit":    limit,
			"current":  current,
			"plan":     plan,
		},
	}
}

// errorBody is the wire shape. Details is a pointer so that an absent value is
// omitted entirely rather than serialized as null; the previous implementation
// did the same, and clients branch on presence.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details *any   `json:"details,omitempty"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

// WriteJSON writes a JSON response with no-store caching, matching the existing
// clients' expectations.
func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	encoder := json.NewEncoder(w)
	// The payload is built by this server, so escaping HTML entities only makes
	// the output harder to read without adding protection.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		// The status line is already written, so this cannot be turned into an
		// error response; log rather than silently truncating the body.
		slog.Error("write json response", "error", err)
	}
}

// WriteJSONStatus writes a success response from a handler. Returning its result
// (always nil) lets a handler end with `return WriteJSONStatus(...)`, which reads
// as "respond and finish" without a separate return statement that a later edit
// could forget.
func WriteJSONStatus(ctx *Context, status int, payload any) error {
	WriteJSON(ctx.Writer, status, payload)
	return nil
}

// WriteError maps an error to the wire contract. Any error that is not an
// *ApiError becomes a 500 with no internal detail, so a database message or
// stack detail cannot leak to a client.
func WriteError(w http.ResponseWriter, err error) {
	var apiErr *ApiError
	if !errors.As(err, &apiErr) {
		slog.Error("unhandled error", "error", err)
		WriteJSON(w, http.StatusInternalServerError, errorEnvelope{
			Error: errorBody{Code: "internal", Message: "Internal server error"},
		})
		return
	}

	body := errorBody{Code: apiErr.Code, Message: apiErr.Message}
	if apiErr.Details != nil {
		details := apiErr.Details
		body.Details = &details
	}
	WriteJSON(w, apiErr.Status, errorEnvelope{Error: body})
}

// Handler is a route handler that may return an error; the dispatcher converts
// it to a response.
type Handler func(*Context) error

// maxBodyBytes bounds request bodies. A sync push carries a bounded batch, so a
// generous but finite limit prevents an unauthenticated caller from streaming
// unbounded data into memory.
const maxBodyBytes = 8 << 20 // 8 MiB

// PathParam returns a decoded path parameter, or "" when absent.
func (c *Context) PathParam(name string) string { return c.Params[name] }

// Query returns a query parameter, or "" when absent.
func (c *Context) Query(name string) string { return c.Request.URL.Query().Get(name) }

// DecodeJSON reads a JSON request body into target. An unparseable or non-object
// body is a 400 rather than an empty struct: silently treating malformed input as
// "no fields provided" turns a client bug into a confusing validation error.
func (c *Context) DecodeJSON(target any) error {
	if c.Request.Body == nil {
		return BadRequest("invalid_json", "Invalid JSON body", nil)
	}
	limited := io.LimitReader(c.Request.Body, maxBodyBytes)

	decoder := json.NewDecoder(limited)
	// Unknown fields are rejected so a client typo (a misspelled column in a sync
	// payload) fails loudly instead of being silently dropped from the write.
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return BadRequest("invalid_json", "Invalid JSON body", nil)
		}
		return BadRequest("invalid_json", "Invalid JSON body", map[string]any{"reason": err.Error()})
	}
	return nil
}

// DecodeJSONLoose reads a JSON body without rejecting unknown fields. Used by the
// sync push, which must tolerate payloads from clients of any version — a newer
// client sending an extra column should not break an older server.
func (c *Context) DecodeJSONLoose(target any) error {
	if c.Request.Body == nil {
		return BadRequest("invalid_json", "Invalid JSON body", nil)
	}
	decoder := json.NewDecoder(io.LimitReader(c.Request.Body, maxBodyBytes))
	if err := decoder.Decode(target); err != nil {
		return BadRequest("invalid_json", "Invalid JSON body", map[string]any{"reason": err.Error()})
	}
	return nil
}

// Route is one registered endpoint.
type Route struct {
	Method string
	// Pattern uses Go 1.22+ net/http syntax: "/places/{id}".
	Pattern string
	// Handler is the composed handler, including any auth middleware.
	Handler Handler
}

// Router dispatches requests to handlers.
type Router struct {
	routes []Route
}

// NewRouter returns an empty router.
func NewRouter() *Router { return &Router{} }

// Handle registers a route. Middleware should already be applied to handler.
func (r *Router) Handle(method, pattern string, handler Handler) {
	r.routes = append(r.routes, Route{Method: method, Pattern: pattern, Handler: handler})
}

// ServeHTTP implements http.Handler.
//
// Routing is delegated to net/http's ServeMux, which handles path patterns and
// path-parameter extraction since Go 1.22. Writing a matcher by hand would mean
// reimplementing precedence, trailing-slash, and escaping rules — all places
// where a subtle difference from the platform's behavior becomes a security bug.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	mux := http.NewServeMux()
	for _, route := range r.routes {
		route := route
		mux.HandleFunc(route.Method+" "+route.Pattern, func(w http.ResponseWriter, req *http.Request) {
			ctx := &Context{
				Request: req,
				Params:  map[string]string{},
				Writer:  w,
			}
			for _, name := range pathParamNames(route.Pattern) {
				ctx.Params[name] = req.PathValue(name)
			}
			if err := route.Handler(ctx); err != nil {
				WriteError(w, err)
			}
		})
	}

	// A request that matches no route must be JSON like every other response; the
	// default ServeMux body is plain text, which clients cannot parse.
	mux.HandleFunc("/", func(w http.ResponseWriter, req *http.Request) {
		WriteError(w, NotFound("not_found", "Not found"))
	})

	mux.ServeHTTP(w, req)
}

// pathParamNames extracts "{name}" segments from a route pattern.
func pathParamNames(pattern string) []string {
	var names []string
	for _, segment := range strings.Split(pattern, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			names = append(names, strings.TrimSuffix(strings.TrimPrefix(segment, "{"), "}"))
		}
	}
	return names
}

// Health is a trivially cheap liveness handler.
func Health(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// String renders an ApiError for logs without exposing it to clients.
func (e *ApiError) String() string {
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}
