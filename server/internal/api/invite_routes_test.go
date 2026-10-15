package api

import (
	"net/http"
	"testing"
)

// Invitation route tests.
//
// These exist because the HTTP surface was the only thing missing: the store already
// implemented invitations, and the legacy backend exposed the routes. Without them, removing
// the legacy backend would have silently taken away the ability to add a colleague to an
// account.

func TestOwnerCanInviteStaff(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
		"email": "colleague@example.test",
		"role":  "staff",
	})
	if status != http.StatusCreated {
		t.Fatalf("POST /auth/invites returned %d: %v", status, body)
	}

	invite, ok := body["invite"].(map[string]any)
	if !ok {
		t.Fatalf("response has no invite object: %v", body)
	}
	if invite["email"] != "colleague@example.test" {
		t.Errorf("email = %v", invite["email"])
	}
	if invite["role"] != "staff" {
		t.Errorf("role = %v, want staff", invite["role"])
	}
	if invite["status"] != "pending" {
		t.Errorf("status = %v, want pending", invite["status"])
	}
	// Dates are RFC3339, so a client can parse them rather than guess a format.
	if invite["expiresAt"] == "" || invite["createdAt"] == "" {
		t.Errorf("invite is missing its dates: %v", invite)
	}

	// The token comes back exactly once, because only its hash is stored.
	tokenValue, _ := body["inviteToken"].(string)
	if tokenValue == "" {
		t.Fatal("the creation response must include the invitation token")
	}
	if len(tokenValue) < 32 {
		t.Errorf("the token is only %d characters, which is too short to be unguessable", len(tokenValue))
	}
}

// TestInviteTokenIsNeverReturnedAgain is the property that makes an invitation safe to keep in
// the database: a leaked row cannot be turned back into a working link.
func TestInviteTokenIsNeverReturnedAgain(t *testing.T) {
	server, token := newDomainServer(t)

	_, created := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
		"email": "colleague@example.test",
	})
	secret, _ := created["inviteToken"].(string)
	if secret == "" {
		t.Fatal("no token was returned")
	}

	status, listing := getJSON(t, server, "/auth/invites", token)
	if status != http.StatusOK {
		t.Fatalf("GET /auth/invites returned %d: %v", status, listing)
	}

	invites, _ := listing["invites"].([]any)
	if len(invites) != 1 {
		t.Fatalf("listed %d invites, want 1", len(invites))
	}

	// The token, its hash, and the internal token column must all be absent from the list.
	for key, value := range invites[0].(map[string]any) {
		if value == secret {
			t.Errorf("the listing exposes the invitation token in %q", key)
		}
	}
	if _, present := invites[0].(map[string]any)["tokenHash"]; present {
		t.Error("the listing exposes the token hash")
	}
}

func TestInviteDefaultsToStaffNotAdmin(t *testing.T) {
	// A typo in the role must not hand out administrative rights, so anything other than an
	// explicit "admin" is staff.
	server, token := newDomainServer(t)

	// A number is deliberately absent: the field is a string, so a numeric role is refused
	// as malformed JSON before the defaulting logic is reached. That is the right answer, and
	// asserting it here would be testing the decoder rather than the rule.
	for index, role := range []any{"", "owner", "administrator", "ADMIN", nil} {
		status, body := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
			"email": uniqueInviteEmail(t, index),
			"role":  role,
		})
		if status != http.StatusCreated {
			t.Fatalf("role %v returned %d: %v", role, status, body)
		}
		invite := body["invite"].(map[string]any)
		if invite["role"] != "staff" {
			t.Errorf("role %v produced %v, want staff", role, invite["role"])
		}
	}
}

func TestInviteRejectsAMalformedAddress(t *testing.T) {
	server, token := newDomainServer(t)

	for _, email := range []string{"", "not-an-email", "no@domain", "@example.test", "spaces in@example.test"} {
		status, body := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
			"email": email,
		})
		if status != http.StatusBadRequest {
			t.Errorf("email %q returned %d, want 400: %v", email, status, body)
		}
	}
}

func TestInviteNormalizesTheAddress(t *testing.T) {
	// Addresses are case-insensitive in practice, so a duplicate check that compared raw
	// strings would let the same person be invited twice under different capitalisation.
	server, token := newDomainServer(t)

	if status, body := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
		"email": "  COLLEAGUE@Example.TEST  ",
	}); status != http.StatusCreated {
		t.Fatalf("first invite returned %d: %v", status, body)
	} else if body["invite"].(map[string]any)["email"] != "colleague@example.test" {
		t.Errorf("email was not normalized: %v", body["invite"].(map[string]any)["email"])
	}

	// The same address in different case is a duplicate, not a second invitation: two live
	// links would mean revoking one does not close the other.
	status, body := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
		"email": "Colleague@example.test",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("a duplicate invite returned %d, want 400: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "invite_exists" {
		t.Errorf("code = %v, want invite_exists", code)
	}
}

func TestOwnerCanRevokeAnInvitation(t *testing.T) {
	server, token := newDomainServer(t)

	_, created := request(t, server, http.MethodPost, "/auth/invites", token, map[string]any{
		"email": "colleague@example.test",
	})
	inviteID := created["invite"].(map[string]any)["id"].(string)

	status, body := request(t, server, http.MethodPost, "/auth/invites/"+inviteID+"/revoke", token, nil)
	if status != http.StatusOK {
		t.Fatalf("revoke returned %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Errorf("ok = %v", body["ok"])
	}

	// The invitation no longer accepts anyone, which is the point of revoking it.
	_, listing := getJSON(t, server, "/auth/invites", token)
	for _, raw := range listing["invites"].([]any) {
		invite := raw.(map[string]any)
		if invite["id"] == inviteID && invite["status"] == "pending" {
			t.Error("a revoked invitation is still pending")
		}
	}

	// Revoking the same invitation twice reports that there is nothing to revoke rather than
	// appearing to succeed.
	status, body = request(t, server, http.MethodPost, "/auth/invites/"+inviteID+"/revoke", token, nil)
	if status != http.StatusNotFound {
		t.Fatalf("a second revoke returned %d, want 404: %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "invite_not_found" {
		t.Errorf("code = %v, want invite_not_found", code)
	}
}

func TestRevokingAnUnknownInvitationIsANotFound(t *testing.T) {
	server, token := newDomainServer(t)

	status, body := request(t, server, http.MethodPost,
		"/auth/invites/11111111-1111-1111-1111-111111111111/revoke", token, nil)
	if status != http.StatusNotFound {
		t.Fatalf("returned %d, want 404: %v", status, body)
	}
}

// TestOnlyManagersMayInvite: inviting someone grants access to the account's data, so it is an
// administrative act rather than something any member may do.
func TestOnlyManagersMayInvite(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	ownerToken, _ := login(t, server, bootstrap(t, server))
	staffToken := addMemberAndLogin(t, server, database, ownerToken)

	t.Run("a member cannot invite", func(t *testing.T) {
		status, body := request(t, server, http.MethodPost, "/auth/invites", staffToken, map[string]any{
			"email": "someone@example.test",
		})
		if status != http.StatusForbidden {
			t.Fatalf("a member inviting returned %d, want 403: %v", status, body)
		}
	})

	t.Run("a member cannot list invitations", func(t *testing.T) {
		// The list reveals who has been invited and when, which is account administration.
		status, body := getJSON(t, server, "/auth/invites", staffToken)
		if status != http.StatusForbidden {
			t.Fatalf("a member listing invites returned %d, want 403: %v", status, body)
		}
	})

	t.Run("a member cannot revoke", func(t *testing.T) {
		_, created := request(t, server, http.MethodPost, "/auth/invites", ownerToken, map[string]any{
			"email": "someone@example.test",
		})
		inviteID := created["invite"].(map[string]any)["id"].(string)

		status, body := request(t, server, http.MethodPost, "/auth/invites/"+inviteID+"/revoke", staffToken, nil)
		if status != http.StatusForbidden {
			t.Fatalf("a member revoking returned %d, want 403: %v", status, body)
		}

		// And the invitation is untouched.
		_, listing := getJSON(t, server, "/auth/invites", ownerToken)
		found := false
		for _, raw := range listing["invites"].([]any) {
			invite := raw.(map[string]any)
			if invite["id"] == inviteID && invite["status"] == "pending" {
				found = true
			}
		}
		if !found {
			t.Error("a forbidden revoke still changed the invitation")
		}
	})
}

// TestInvitationIsScopedToItsAccount: an id from one account must not be revocable by another.
func TestInvitationIsScopedToItsAccount(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	tokenA, _ := login(t, server, bootstrap(t, server))

	_, created := request(t, server, http.MethodPost, "/auth/invites", tokenA, map[string]any{
		"email": "colleague@example.test",
	})
	inviteID := created["invite"].(map[string]any)["id"].(string)

	// A second account's owner, who would be a manager of their own account but not of A's.
	tokenB := bootstrapSecondAccount(t, server, database, uniqueEmail(t))

	status, body := request(t, server, http.MethodPost, "/auth/invites/"+inviteID+"/revoke", tokenB, nil)
	if status != http.StatusNotFound {
		t.Fatalf("another account revoking returned %d, want 404: %v", status, body)
	}

	// Invitation A is still pending, so the refusal was real rather than cosmetic.
	_, listing := getJSON(t, server, "/auth/invites", tokenA)
	found := false
	for _, raw := range listing["invites"].([]any) {
		invite := raw.(map[string]any)
		if invite["id"] == inviteID && invite["status"] == "pending" {
			found = true
		}
	}
	if !found {
		t.Error("the invitation was changed by the other account")
	}

	// And B's own list is empty: invitations are not visible across accounts.
	_, listingB := getJSON(t, server, "/auth/invites", tokenB)
	if len(listingB["invites"].([]any)) != 0 {
		t.Errorf("account B sees %d invitations", len(listingB["invites"].([]any)))
	}
}

func TestInvitesRequireAuthentication(t *testing.T) {
	server, _ := newDomainServer(t)

	for _, probe := range []struct{ method, path string }{
		{http.MethodGet, "/auth/invites"},
		{http.MethodPost, "/auth/invites"},
		{http.MethodPost, "/auth/invites/some-id/revoke"},
	} {
		status, _ := request(t, server, probe.method, probe.path, "", nil)
		if status != http.StatusUnauthorized {
			t.Errorf("%s %s without a token returned %d, want 401", probe.method, probe.path, status)
		}
	}
}

// uniqueInviteEmail gives each case in a loop its own address.
func uniqueInviteEmail(t *testing.T, index int) string {
	t.Helper()
	return "invite-" + string(rune('a'+index)) + "-" + uniqueEmail(t)
}

func TestMembersListShowsTheTeamAndOnlyTheTeam(t *testing.T) {
	server, database := newDomainServerWithDatabase(t)
	ownerToken, _ := login(t, server, bootstrap(t, server))
	staffToken := addMemberAndLogin(t, server, database, ownerToken)

	t.Run("an owner sees the people in the account", func(t *testing.T) {
		status, body := getJSON(t, server, "/account/members", ownerToken)
		if status != http.StatusOK {
			t.Fatalf("GET /account/members returned %d: %v", status, body)
		}
		members, ok := body["members"].([]any)
		if !ok || len(members) < 2 {
			t.Fatalf("members = %v, want at least the owner and the invited colleague", body["members"])
		}
		roles := map[string]bool{}
		selfSeen := 0
		for _, raw := range members {
			member := raw.(map[string]any)
			roles[member["role"].(string)] = true
			if member["isSelf"] == true {
				selfSeen++
			}
			// The list is for people, not for credentials: no session or token material.
			for _, forbidden := range []string{"token", "password", "session", "hash"} {
				if _, present := member[forbidden]; present {
					t.Errorf("member exposes %q: %v", forbidden, member)
				}
			}
		}
		if !roles["owner"] || !roles["staff"] {
			t.Errorf("roles = %v, want the owner and the colleague", roles)
		}
		// Exactly one row is the reader: the client marks it, so it does not offer to remove
		// the account's only owner.
		if selfSeen != 1 {
			t.Errorf("isSelf is set on %d rows, want exactly 1", selfSeen)
		}
	})

	t.Run("a member sees the team too", func(t *testing.T) {
		// Knowing who you work alongside is not administration; the invitation list is.
		status, body := getJSON(t, server, "/account/members", staffToken)
		if status != http.StatusOK {
			t.Fatalf("a member reading the team returned %d, want 200: %v", status, body)
		}
		members := body["members"].([]any)
		if len(members) < 2 {
			t.Fatalf("a member sees %d people, want the whole team", len(members))
		}
	})

	t.Run("an anonymous caller sees nothing", func(t *testing.T) {
		status, _ := getJSON(t, server, "/account/members", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("an unauthenticated read returned %d, want 401", status)
		}
	})
}
