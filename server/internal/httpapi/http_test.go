package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// decodeBody asserts the response is valid JSON and returns it as a generic map,
// so tests can pin the exact wire shape rather than merely "some JSON".
func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v\nbody: %s", err, recorder.Body.String())
	}
	return body
}

func TestWriteErrorProducesTheDocumentedEnvelope(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteError(recorder, BadRequest("validation_error", "Имя обязательно", nil))

	if recorder.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}

	body := decodeBody(t, recorder)
	errorObject, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("response has no error object: %v", body)
	}
	if errorObject["code"] != "validation_error" {
		t.Errorf("code = %v, want validation_error", errorObject["code"])
	}
	if errorObject["message"] != "Имя обязательно" {
		t.Errorf("message = %v, want the Russian message", errorObject["message"])
	}
	// Absent details must be omitted, not serialized as null: clients branch on
	// presence, and the previous implementation omitted it.
	if _, present := errorObject["details"]; present {
		t.Errorf("details should be omitted when nil, got %v", errorObject["details"])
	}
	if _, present := body["error_code"]; present {
		t.Error("response must not use a flat error_code field")
	}
}

func TestWriteErrorIncludesDetailsWhenPresent(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteError(recorder, PlanLimit("units", 1, 1, "free", "Тариф «Бесплатный» позволяет создать не более 1 объекта"))

	body := decodeBody(t, recorder)
	errorObject := body["error"].(map[string]any)
	if errorObject["code"] != "plan_limit" {
		t.Fatalf("code = %v, want plan_limit", errorObject["code"])
	}
	details, ok := errorObject["details"].(map[string]any)
	if !ok {
		t.Fatalf("details missing from a plan-limit error: %v", errorObject)
	}
	// These four fields are what lets a client build an upgrade prompt without
	// parsing the localized message.
	for field, want := range map[string]any{"resource": "units", "plan": "free"} {
		if details[field] != want {
			t.Errorf("details.%s = %v, want %v", field, details[field], want)
		}
	}
	if details["limit"] != float64(1) || details["current"] != float64(1) {
		t.Errorf("details limit/current = %v/%v, want 1/1", details["limit"], details["current"])
	}
}

func TestWriteErrorHidesInternalDetails(t *testing.T) {
	recorder := httptest.NewRecorder()
	// A raw database error must not reach the client: it can disclose schema and
	// query structure.
	WriteError(recorder, errors.New("pq: relation \"secret_table\" does not exist"))

	if recorder.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "secret_table") {
		t.Errorf("internal error text leaked to the client: %s", recorder.Body.String())
	}
	body := decodeBody(t, recorder)
	errorObject := body["error"].(map[string]any)
	if errorObject["code"] != "internal" {
		t.Errorf("code = %v, want internal", errorObject["code"])
	}
}

func TestWriteErrorUnwrapsWrappedApiErrors(t *testing.T) {
	// Handlers routinely wrap errors with context. errors.As must still find the
	// ApiError, otherwise every wrapped error degrades into a 500.
	wrapped := errors.New("outer")
	wrapped = errors.Join(wrapped, NotFound("unit_not_found", "Объект не найден"))

	recorder := httptest.NewRecorder()
	WriteError(recorder, wrapped)

	if recorder.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["error"].(map[string]any)["code"] != "unit_not_found" {
		t.Errorf("code = %v, want unit_not_found", body["error"])
	}
}

type echoPayload struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

func TestDecodeJSONRejectsUnknownFields(t *testing.T) {
	// A misspelled field is a client bug that must fail loudly. Accepting it
	// silently would drop the value and produce a confusing downstream error.
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"a","nmae":"b"}`))
	ctx := &Context{Request: request, Params: map[string]string{}}

	var payload echoPayload
	err := ctx.DecodeJSON(&payload)
	if err == nil {
		t.Fatal("expected an error for an unknown field")
	}
	var apiErr *ApiError
	if !errors.As(err, &apiErr) || apiErr.Code != "invalid_json" {
		t.Fatalf("expected invalid_json, got %v", err)
	}
}

func TestDecodeJSONRejectsMalformedAndEmptyBodies(t *testing.T) {
	for name, body := range map[string]string{
		"malformed":     `{"name":`,
		"not an object": `[1,2,3]`,
		"empty":         ``,
		"plain text":    `hello`,
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
			ctx := &Context{Request: request, Params: map[string]string{}}

			var payload echoPayload
			if err := ctx.DecodeJSON(&payload); err == nil {
				t.Errorf("DecodeJSON accepted %q", body)
			}
		})
	}
}

func TestDecodeJSONLooseToleratesUnknownFields(t *testing.T) {
	// Sync push must accept payloads from clients of any version, so an extra
	// column from a newer client is not an error.
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"a","future_field":42}`))
	ctx := &Context{Request: request, Params: map[string]string{}}

	var payload echoPayload
	if err := ctx.DecodeJSONLoose(&payload); err != nil {
		t.Fatalf("DecodeJSONLoose rejected a forward-compatible payload: %v", err)
	}
	if payload.Name != "a" {
		t.Errorf("known field was not decoded: %+v", payload)
	}
}

func TestRouterDispatchesAndExtractsPathParams(t *testing.T) {
	router := NewRouter()
	router.Handle(http.MethodGet, "/units/{id}", func(ctx *Context) error {
		WriteJSON(ctx.Writer, http.StatusOK, map[string]string{"id": ctx.PathParam("id")})
		return nil
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/units/abc-123", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["id"] != "abc-123" {
		t.Errorf("id = %v, want abc-123", body["id"])
	}
}

func TestRouterReturnsJSONForUnmatchedRoutes(t *testing.T) {
	// The default ServeMux 404 is plain text. Clients parse JSON, so an unmatched
	// route must still produce the error envelope.
	router := NewRouter()
	router.Handle(http.MethodGet, "/units", func(ctx *Context) error {
		WriteJSON(ctx.Writer, http.StatusOK, map[string]string{})
		return nil
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/nope", nil))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["error"].(map[string]any)["code"] != "not_found" {
		t.Errorf("expected a not_found error envelope, got %s", recorder.Body.String())
	}
}

func TestRouterDistinguishesMethods(t *testing.T) {
	router := NewRouter()
	router.Handle(http.MethodGet, "/units", func(ctx *Context) error {
		WriteJSON(ctx.Writer, http.StatusOK, map[string]string{"method": "get"})
		return nil
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, "/units", nil))
	if recorder.Code == http.StatusOK {
		t.Errorf("DELETE /units matched the GET route")
	}
}

func TestRouterConvertsHandlerErrorsToResponses(t *testing.T) {
	router := NewRouter()
	router.Handle(http.MethodGet, "/boom", func(*Context) error {
		return Conflict("night_conflict", "Даты заняты", map[string]any{"unitId": "u1"})
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/boom", nil))

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", recorder.Code)
	}
	body := decodeBody(t, recorder)
	if body["error"].(map[string]any)["code"] != "night_conflict" {
		t.Errorf("unexpected body: %s", recorder.Body.String())
	}
}

func TestWriteJSONDoesNotEscapeHTMLEntities(t *testing.T) {
	// Russian text and URLs should stay readable; Go escapes <, >, and & by
	// default, which would mangle invite links embedded in responses.
	recorder := httptest.NewRecorder()
	WriteJSON(recorder, http.StatusOK, map[string]string{"url": "https://x.test/?a=1&b=2"})

	if strings.Contains(recorder.Body.String(), `\u0026`) {
		t.Errorf("ampersand was HTML-escaped: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "&") {
		t.Errorf("ampersand missing from output: %s", recorder.Body.String())
	}
}

func TestPathParamNames(t *testing.T) {
	names := pathParamNames("/accounts/{accountId}/units/{unitId}")
	if len(names) != 2 || names[0] != "accountId" || names[1] != "unitId" {
		t.Errorf("pathParamNames = %v, want [accountId unitId]", names)
	}
	if got := pathParamNames("/units"); len(got) != 0 {
		t.Errorf("pathParamNames(/units) = %v, want empty", got)
	}
}
