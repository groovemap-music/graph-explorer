"""E2E browser tests for the graph-explorer auth UI and user panes."""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Page, expect


_MOCK_TOKEN = "mock-test-access-token-abc123"  # nosec B105


def _wait_for_alpine(page: Page) -> None:
    """Wait for Alpine.js to be fully initialised."""
    page.wait_for_function("() => !!window.Alpine && !!Alpine.store('modals')", timeout=10000)


def _set_logged_in(page: Page, test_server: str) -> None:
    """Helper: inject auth token into localStorage and reload so authManager initialises."""
    page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
    _wait_for_alpine(page)
    page.evaluate(f"window.localStorage.setItem('auth_token', '{_MOCK_TOKEN}')")
    page.reload(wait_until="domcontentloaded", timeout=30000)
    _wait_for_alpine(page)
    # Wait for authManager.init() async calls to complete and UI to update
    expect(page.locator("#userDropdown")).not_to_have_class(re.compile(r"\bhidden\b"), timeout=8000)


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreAuthNavbar:
    """E2E tests for auth-related navbar elements."""

    def test_login_button_visible_when_logged_out(self, page: Page, test_server: str) -> None:
        """Login button is visible in navbar when no token is stored."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)

        login_btn = page.locator("#navLoginBtn")
        expect(login_btn).to_be_visible(timeout=5000)

    def test_user_dropdown_hidden_when_logged_out(self, page: Page, test_server: str) -> None:
        """User dropdown is hidden when not authenticated."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)

        user_dropdown = page.locator("#userDropdown")
        expect(user_dropdown).to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_collection_nav_hidden_when_logged_out(self, page: Page, test_server: str) -> None:
        """Secondary nav bar is hidden when logged out."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)

        expect(page.locator("#navSecondary")).to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_user_dropdown_visible_when_logged_in(self, page: Page, test_server: str) -> None:
        """User dropdown is visible after injecting an auth token."""
        _set_logged_in(page, test_server)

        user_dropdown = page.locator("#userDropdown")
        expect(user_dropdown).not_to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_auth_buttons_hidden_when_logged_in(self, page: Page, test_server: str) -> None:
        """Login button area is hidden once the user is authenticated."""
        _set_logged_in(page, test_server)

        auth_buttons = page.locator("#authButtons")
        expect(auth_buttons).to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_user_email_displayed_in_dropdown(self, page: Page, test_server: str) -> None:
        """Logged-in user's email appears in the navbar dropdown toggle."""
        _set_logged_in(page, test_server)

        email_display = page.locator("#userEmailDisplay")
        expect(email_display).to_have_text("test@example.com", timeout=5000)

    def test_collection_nav_visible_when_logged_in(self, page: Page, test_server: str) -> None:
        """Secondary nav bar appears after login."""
        _set_logged_in(page, test_server)

        expect(page.locator("#navSecondary")).not_to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_connect_discogs_button_visible_in_dropdown(self, page: Page, test_server: str) -> None:
        """Connect Discogs button is visible in the user dropdown when not connected."""
        _set_logged_in(page, test_server)

        # Open the user dropdown
        page.locator("#userMenuToggle").click()
        connect_btn = page.locator("#connectDiscogsBtn")
        expect(connect_btn).not_to_have_class(re.compile(r"\bhidden\b"), timeout=5000)

    def test_logout_button_visible_in_dropdown(self, page: Page, test_server: str) -> None:
        """Logout button is present in the user dropdown."""
        _set_logged_in(page, test_server)

        page.locator("#userMenuToggle").click()
        logout_btn = page.locator("#logoutBtn")
        expect(logout_btn).to_be_visible(timeout=5000)

    def test_logout_restores_logged_out_state(self, page: Page, test_server: str) -> None:
        """Clicking logout clears auth state and shows login button."""
        _set_logged_in(page, test_server)

        # Open dropdown and click logout
        page.locator("#userMenuToggle").click()
        page.locator("#logoutBtn").click()

        # Login button should reappear
        expect(page.locator("#navLoginBtn")).to_be_visible(timeout=5000)
        # User dropdown should hide
        expect(page.locator("#userDropdown")).to_have_class(re.compile(r"\bhidden\b"), timeout=5000)


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreAuthModal:
    """E2E tests for the login/register modal."""

    def test_auth_modal_exists_in_dom(self, page: Page, test_server: str) -> None:
        """The auth modal element is present in the DOM."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        modal = page.locator("#authModal")
        expect(modal).to_be_attached()

    def test_auth_modal_opens_on_login_click(self, page: Page, test_server: str) -> None:
        """Clicking the Login button opens the auth modal."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        modal = page.locator("#authModal")
        expect(modal).to_be_visible(timeout=5000)

    def test_auth_modal_has_login_tab(self, page: Page, test_server: str) -> None:
        """The auth modal has a Login tab."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        expect(page.locator("#login-tab")).to_be_visible(timeout=5000)

    def test_auth_modal_has_register_tab(self, page: Page, test_server: str) -> None:
        """The auth modal has a Register tab."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        expect(page.locator("#register-tab")).to_be_visible(timeout=5000)

    def test_login_form_has_email_and_password_fields(self, page: Page, test_server: str) -> None:
        """Login form contains email and password inputs."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        expect(page.locator("#loginEmail")).to_be_visible(timeout=5000)
        expect(page.locator("#loginPassword")).to_be_visible(timeout=5000)

    def test_register_tab_switches_on_click(self, page: Page, test_server: str) -> None:
        """Clicking the Register tab shows the register form."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        page.locator("#register-tab").click()

        # Register form fields should become visible
        expect(page.locator("#registerEmail")).to_be_visible(timeout=5000)
        expect(page.locator("#registerPassword")).to_be_visible(timeout=5000)

    def test_login_shows_error_for_invalid_credentials(self, page: Page, test_server: str) -> None:
        """Entering wrong credentials shows an error message."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        page.locator("#loginEmail").fill("wrong@example.com")
        page.locator("#loginPassword").fill("wrongpassword")
        page.locator("#loginSubmitBtn").click()

        error_el = page.locator("#loginError")
        expect(error_el).not_to_have_text("", timeout=8000)

    def test_successful_login_closes_modal(self, page: Page, test_server: str) -> None:
        """Correct credentials close the modal and show the user dropdown."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)

        page.locator("#navLoginBtn").click()
        page.locator("#loginEmail").fill("test@example.com")
        page.locator("#loginPassword").fill("testpassword")
        page.locator("#loginSubmitBtn").click()

        # Modal should close
        modal = page.locator("#authModal")
        expect(modal).not_to_be_visible(timeout=8000)

        # User dropdown should appear
        expect(page.locator("#userDropdown")).not_to_have_class(re.compile(r"\bhidden\b"), timeout=8000)


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreUserPanes:
    """E2E tests for Collection, Wantlist, and Recommendations panes."""

    def test_collection_pane_exists_in_dom(self, page: Page, test_server: str) -> None:
        """The collection pane element exists in the DOM."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#collectionPane")).to_be_attached()

    def test_wantlist_pane_exists_in_dom(self, page: Page, test_server: str) -> None:
        """The wantlist pane element exists in the DOM."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#wantlistPane")).to_be_attached()

    def test_recommendations_pane_exists_in_dom(self, page: Page, test_server: str) -> None:
        """The recommendations pane element exists in the DOM."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#recommendationsPane")).to_be_attached()

    def test_collection_pane_becomes_active_on_nav_click(self, page: Page, test_server: str) -> None:
        """Clicking the Collection nav item switches to the collection pane."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='collection']").click()

        collection_pane = page.locator("#collectionPane")
        expect(collection_pane).to_have_class(re.compile("active"), timeout=5000)

        # Explore pane should no longer be active
        explore_pane = page.locator("#explorePane")
        expect(explore_pane).not_to_have_class(re.compile("active"), timeout=5000)

    def test_wantlist_pane_becomes_active_on_nav_click(self, page: Page, test_server: str) -> None:
        """Clicking the Wantlist nav item switches to the wantlist pane."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='wantlist']").click()

        wantlist_pane = page.locator("#wantlistPane")
        expect(wantlist_pane).to_have_class(re.compile("active"), timeout=5000)

    def test_recommendations_pane_becomes_active_on_nav_click(self, page: Page, test_server: str) -> None:
        """Clicking the Discover nav item switches to the recommendations pane."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='recommendations']").click()

        rec_pane = page.locator("#recommendationsPane")
        expect(rec_pane).to_have_class(re.compile("active"), timeout=5000)

    def test_collection_pane_loads_release_data(self, page: Page, test_server: str) -> None:
        """Collection pane renders release titles from the API."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='collection']").click()

        # Wait for release list to appear (mock returns "OK Computer" and "Kid A")
        release_titles = page.locator(".release-list-title")
        expect(release_titles.first).to_be_visible(timeout=8000)
        expect(release_titles).to_have_count(2, timeout=8000)

    def test_collection_pane_shows_release_title(self, page: Page, test_server: str) -> None:
        """Collection pane shows known release title from mock data."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='collection']").click()

        expect(page.locator(".release-list-title").first).to_contain_text("OK Computer", timeout=8000)

    def test_wantlist_pane_loads_release_data(self, page: Page, test_server: str) -> None:
        """Wantlist pane renders release titles from the API."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='wantlist']").click()

        release_titles = page.locator(".release-list-title")
        expect(release_titles.first).to_be_visible(timeout=8000)
        expect(release_titles.first).to_contain_text("In Rainbows", timeout=8000)

    def test_recommendations_pane_loads_data(self, page: Page, test_server: str) -> None:
        """Recommendations pane shows recommendation items."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='recommendations']").click()

        rec_items = page.locator(".recommendation-item")
        expect(rec_items.first).to_be_visible(timeout=8000)
        expect(rec_items).to_have_count(2, timeout=8000)

    def test_collection_pane_has_refresh_button(self, page: Page, test_server: str) -> None:
        """Collection pane header contains a Refresh button."""
        _set_logged_in(page, test_server)

        page.locator("[data-pane='collection']").click()

        refresh_btn = page.locator("#collectionRefreshBtn")
        expect(refresh_btn).to_be_visible(timeout=5000)

    def test_logout_redirects_to_explore_pane(self, page: Page, test_server: str) -> None:
        """Logging out while on the collection pane redirects to the explore pane."""
        _set_logged_in(page, test_server)

        # Switch to collection pane
        page.locator("[data-pane='collection']").click()
        expect(page.locator("#collectionPane")).to_have_class(re.compile("active"), timeout=5000)

        # Logout
        page.locator("#userMenuToggle").click()
        page.locator("#logoutBtn").click()

        # Should be redirected to explore pane
        expect(page.locator("#explorePane")).to_have_class(re.compile("active"), timeout=5000)


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreDiscogsOAuth:
    """E2E tests for Discogs OAuth connect UI."""

    def test_discogs_modal_exists_in_dom(self, page: Page, test_server: str) -> None:
        """The Discogs OAuth verifier modal is present in the DOM."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#discogsModal")).to_be_attached()

    def test_discogs_verifier_input_exists(self, page: Page, test_server: str) -> None:
        """The verifier code input field is present in the Discogs modal."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#discogsVerifierInput")).to_be_attached()

    def test_discogs_verifier_submit_button_exists(self, page: Page, test_server: str) -> None:
        """The Connect button is present in the Discogs modal."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        submit_btn = page.locator("#discogsVerifierSubmit")
        expect(submit_btn).to_be_attached()


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreAuthAPIEndpoints:
    """E2E tests for auth and user API endpoints via page.request."""

    def test_login_endpoint_success(self, page: Page, test_server: str) -> None:
        """POST /api/auth/login returns a token for valid credentials."""
        response = page.request.post(
            f"{test_server}/api/auth/login",
            data={"email": "test@example.com", "password": "testpassword"},
        )
        assert response.ok
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert "expires_in" in data

    def test_login_endpoint_rejects_invalid_credentials(self, page: Page, test_server: str) -> None:
        """POST /api/auth/login returns 401 for wrong credentials."""
        response = page.request.post(
            f"{test_server}/api/auth/login",
            data={"email": "nobody@example.com", "password": "wrongpassword"},
        )
        assert response.status == 401

    def test_register_endpoint_success(self, page: Page, test_server: str) -> None:
        """POST /api/auth/register returns 201 for a new account request."""
        response = page.request.post(
            f"{test_server}/api/auth/register",
            data={"email": "newuser@example.com", "password": "newpassword123"},
        )
        assert response.status == 201

    def test_me_endpoint_with_token(self, page: Page, test_server: str) -> None:
        """GET /api/auth/me returns user info for a valid Bearer token."""
        response = page.request.get(
            f"{test_server}/api/auth/me",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert data["email"] == "test@example.com"
        assert "id" in data

    def test_me_endpoint_requires_auth(self, page: Page, test_server: str) -> None:
        """GET /api/auth/me returns 401 when no token is provided."""
        response = page.request.get(f"{test_server}/api/auth/me")
        assert response.status == 401

    def test_logout_endpoint(self, page: Page, test_server: str) -> None:
        """POST /api/auth/logout accepts a Bearer token and confirms logout."""
        response = page.request.post(
            f"{test_server}/api/auth/logout",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert data.get("logged_out") is True

    def test_oauth_authorize_discogs_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/oauth/authorize/discogs returns an authorization URL."""
        response = page.request.get(
            f"{test_server}/api/oauth/authorize/discogs",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "authorize_url" in data
        assert "state" in data

    def test_oauth_status_discogs_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/oauth/status/discogs returns connection status."""
        response = page.request.get(
            f"{test_server}/api/oauth/status/discogs",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "connected" in data

    def test_user_collection_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/user/collection returns paginated releases."""
        response = page.request.get(
            f"{test_server}/api/user/collection",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "releases" in data
        assert isinstance(data["releases"], list)
        assert "total" in data
        assert "has_more" in data

    def test_user_collection_requires_auth(self, page: Page, test_server: str) -> None:
        """GET /api/user/collection returns 401 without a token."""
        response = page.request.get(f"{test_server}/api/user/collection")
        assert response.status == 401

    def test_user_wantlist_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/user/wantlist returns paginated releases."""
        response = page.request.get(
            f"{test_server}/api/user/wantlist",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "releases" in data
        assert isinstance(data["releases"], list)

    def test_user_recommendations_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/user/recommendations returns recommendation items."""
        response = page.request.get(
            f"{test_server}/api/user/recommendations",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "recommendations" in data
        assert isinstance(data["recommendations"], list)

    def test_user_collection_stats_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/user/collection/stats returns stat fields."""
        response = page.request.get(
            f"{test_server}/api/user/collection/stats",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "total_releases" in data
        assert "unique_artists" in data

    def test_user_status_endpoint_anonymous(self, page: Page, test_server: str) -> None:
        """GET /api/user/status works without authentication."""
        response = page.request.get(f"{test_server}/api/user/status?ids=10,11")
        assert response.ok
        data = response.json()
        assert "status" in data
        assert "10" in data["status"]
        assert "11" in data["status"]

    def test_sync_trigger_endpoint(self, page: Page, test_server: str) -> None:
        """POST /api/sync returns 202 and a job ID."""
        response = page.request.post(
            f"{test_server}/api/sync",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.status == 202
        data = response.json()
        assert data["status"] == "started"
        assert "job_id" in data

    def test_sync_status_endpoint(self, page: Page, test_server: str) -> None:
        """GET /api/sync/status returns current sync state."""
        response = page.request.get(
            f"{test_server}/api/sync/status",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        )
        assert response.ok
        data = response.json()
        assert "status" in data


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreNewStaticFiles:
    """E2E tests verifying new JavaScript files are served correctly."""

    def test_auth_js_loads(self, page: Page, test_server: str) -> None:
        """auth.js is served with the correct content type."""
        response = page.request.get(f"{test_server}/js/auth.js")
        assert response.ok, "auth.js must be served"
        assert "javascript" in response.headers.get("content-type", "")

    def test_user_panes_js_loads(self, page: Page, test_server: str) -> None:
        """user-panes.js is served with the correct content type."""
        response = page.request.get(f"{test_server}/js/user-panes.js")
        assert response.ok, "user-panes.js must be served"
        assert "javascript" in response.headers.get("content-type", "")

    def test_auth_manager_available_in_browser(self, page: Page, test_server: str) -> None:
        """window.authManager is defined after page load."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        # Give scripts time to execute
        page.wait_for_timeout(500)
        defined = page.evaluate("typeof window.authManager !== 'undefined'")
        assert defined, "window.authManager must be defined"

    def test_user_panes_class_available_in_browser(self, page: Page, test_server: str) -> None:
        """window.UserPanes is defined after page load."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(500)
        defined = page.evaluate("typeof window.UserPanes !== 'undefined'")
        assert defined, "window.UserPanes must be defined"


def _open_settings(page: Page, test_server: str) -> None:
    """Sign in and open the Account Settings pane from the user dropdown."""
    _set_logged_in(page, test_server)
    page.locator("#userMenuToggle").click()
    page.locator("#accountSettingsBtn").click()
    expect(page.locator("#settingsPane")).to_have_class(re.compile(r"\bactive\b"), timeout=5000)


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreSettingsPrivacyExportErasure:
    """E2E tests for the Privacy, Export, and Delete Account settings cards."""

    def test_privacy_card_renders_both_purposes_from_the_server(self, page: Page, test_server: str) -> None:
        """Both published purposes render with the state the API reported."""
        _open_settings(page, test_server)

        analytics = page.locator('[data-consent-toggle="product_analytics"]')
        training = page.locator('[data-consent-toggle="model_training"]')
        expect(analytics).to_be_checked(timeout=5000)
        expect(training).not_to_be_checked(timeout=5000)

    def test_privacy_toggle_writes_through_and_reflects_the_answer(self, page: Page, test_server: str) -> None:
        """Granting a purpose persists and the control shows the stored state."""
        _open_settings(page, test_server)

        training = page.locator('[data-consent-toggle="model_training"]')
        training.check()
        expect(page.locator('[data-consent-toggle="model_training"]')).to_be_checked(timeout=5000)

        stored = page.request.get(
            f"{test_server}/api/user/consent",
            headers={"Authorization": f"Bearer {_MOCK_TOKEN}"},
        ).json()
        granted = {row["purpose"]: row["granted"] for row in stored["purposes"]}
        assert granted["model_training"] is True

    def test_export_downloads_the_ndjson_file(self, page: Page, test_server: str) -> None:
        """The export button downloads the NDJSON body under the published name."""
        _open_settings(page, test_server)

        with page.expect_download(timeout=15000) as download_info:
            page.locator("#exportDataBtn").click()
        assert download_info.value.suggested_filename == "groovemap-export.ndjson"
        expect(page.locator("#exportNote")).to_contain_text("downloaded", timeout=5000)

    def test_delete_account_confirm_requires_the_password(self, page: Page, test_server: str) -> None:
        """Confirming with no password reports the requirement and calls nothing."""
        _open_settings(page, test_server)

        page.locator("#deleteAccountBtn").click()
        page.locator("#erasureConfirmBtn").click()

        expect(page.locator("#erasureError")).to_contain_text("Password is required", timeout=5000)
        expect(page.locator("#erasurePassword")).to_be_visible()

    def test_delete_account_rejects_a_wrong_password_and_keeps_the_panel(self, page: Page, test_server: str) -> None:
        """A rejected credential reports the detail inline and leaves the panel standing.

        The API answers a wrong erasure password with 401, which ApiTransport treats as
        an expired session for every route alike, so the pane is hidden behind the
        signed-out view even though the confirm panel itself is intact. The 2FA disable
        card has answered a wrong password the same way since it was written; the
        settings card does not clear the session itself.
        """
        _open_settings(page, test_server)

        page.locator("#deleteAccountBtn").click()
        page.locator("#erasurePassword").fill("not-the-password")
        page.locator("#erasureConfirmBtn").click()

        expect(page.locator("#erasureError")).to_contain_text("Incorrect password", timeout=5000)
        expect(page.locator("#erasurePassword")).to_have_count(1)
        expect(page.locator("#erasureConfirmBtn")).not_to_be_disabled()
        expect(page.locator("#erasureId")).to_have_count(0)

    def test_delete_account_shows_the_erasure_id_and_signs_out(self, page: Page, test_server: str) -> None:
        """A successful erasure shows its id, clears the session, and signs the user out.

        The receipt is asserted visible, not merely present: the session clear
        switches the browser off Settings, so the copy in the card is behind the
        signed-out view and only the banner outside the panes is readable.
        """
        _open_settings(page, test_server)

        page.locator("#deleteAccountBtn").click()
        page.locator("#erasurePassword").fill("testpassword")
        page.locator("#erasureConfirmBtn").click()

        expect(page.locator("#navLoginBtn")).to_be_visible(timeout=5000)
        expect(page.locator("#userDropdown")).to_have_class(re.compile(r"\bhidden\b"), timeout=5000)
        expect(page.locator("#erasureReceiptBanner")).to_be_visible(timeout=5000)
        expect(page.locator("#erasureId")).to_be_visible(timeout=5000)
        expect(page.locator("#erasureId")).to_have_text("00000000-0000-0000-0000-0000000000ff")
        assert page.evaluate("window.localStorage.getItem('auth_token')") is None

    def test_the_erasure_receipt_is_dismissable_and_never_stored(self, page: Page, test_server: str) -> None:
        """The receipt is a one-time notice held in memory, not in the browser."""
        _open_settings(page, test_server)

        page.locator("#deleteAccountBtn").click()
        page.locator("#erasurePassword").fill("testpassword")
        page.locator("#erasureConfirmBtn").click()
        expect(page.locator("#erasureReceiptBanner")).to_be_visible(timeout=5000)

        stored = page.evaluate("() => JSON.stringify(window.localStorage)")
        assert "00000000-0000-0000-0000-0000000000ff" not in stored

        page.locator("#erasureReceiptDismissBtn").click()
        expect(page.locator("#erasureReceiptBanner")).to_be_hidden(timeout=5000)

        # Memory only: a reload does not bring it back.
        page.reload(wait_until="domcontentloaded", timeout=30000)
        expect(page.locator("#erasureReceiptBanner")).to_be_hidden(timeout=5000)


_FIRST_IMPRESSION = "11111111-1111-1111-1111-111111111111"
_FIRST_GM_ID = "gm:release:30"


def _open_discover(page: Page, test_server: str) -> None:
    """Sign in, clear the recorded event log, and open the Discover pane."""
    _set_logged_in(page, test_server)
    page.request.delete(f"{test_server}/api/activity/events")
    page.locator('[data-pane="recommendations"]').click()
    expect(page.locator("#recommendationsPane")).to_have_class(re.compile(r"\bactive\b"), timeout=5000)
    expect(page.locator(".recommendation-item").first).to_be_visible(timeout=8000)


def _recorded_events(page: Page, test_server: str) -> list[dict[str, str]]:
    """Read back what the page has posted to the activity route."""
    return list(page.request.get(f"{test_server}/api/activity/events").json()["events"])


def _expect_recorded(page: Page, test_server: str, event_type: str) -> dict[str, str]:
    """Wait for one event of this type and return it.

    Outcome posts are fire-and-forget, so the click returns before the request
    does; this polls rather than reading once.
    """
    deadline = 8000
    waited = 0
    while waited < deadline:
        for event in _recorded_events(page, test_server):
            if event["event_type"] == event_type:
                return event
        page.wait_for_timeout(200)
        waited += 200
    raise AssertionError(f"no {event_type} event was recorded: {_recorded_events(page, test_server)}")


@pytest.mark.e2e
@pytest.mark.usefixtures("test_server")
class TestExploreRecommendationOutcomes:
    """E2E tests for the outcome events the Discover pane emits."""

    def test_recommendation_rows_carry_their_impression(self, page: Page, test_server: str) -> None:
        """Every row keeps the impression and native ids the API issued with it."""
        _open_discover(page, test_server)

        first = page.locator(".recommendation-item").first
        expect(first).to_have_attribute("data-impression-id", _FIRST_IMPRESSION, timeout=5000)
        expect(first).to_have_attribute("data-gm-id", _FIRST_GM_ID, timeout=5000)

    def test_opening_a_recommendation_records_an_opened_outcome(self, page: Page, test_server: str) -> None:
        """The click-through emits recommendation.opened and still navigates."""
        _open_discover(page, test_server)

        page.locator(".recommendation-item").first.locator("a").click()

        event = _expect_recorded(page, test_server, "recommendation.opened")
        assert event["impression_id"] == _FIRST_IMPRESSION
        assert event["item_id"] == _FIRST_GM_ID
        # The post never blocks the navigation it accompanies.
        expect(page.locator("#explorePane")).to_have_class(re.compile(r"\bactive\b"), timeout=5000)

    def test_saving_a_recommendation_records_the_outcome_and_marks_the_row(self, page: Page, test_server: str) -> None:
        """Save emits recommendation.saved and leaves the row in a saved state."""
        _open_discover(page, test_server)

        first = page.locator(".recommendation-item").first
        first.locator('[data-outcome="save"]').click()

        event = _expect_recorded(page, test_server, "recommendation.saved")
        assert event["impression_id"] == _FIRST_IMPRESSION
        expect(first.locator('[data-outcome="save"]')).to_have_attribute("aria-pressed", "true", timeout=5000)
        expect(first).to_be_visible()

    def test_saving_twice_records_one_outcome(self, page: Page, test_server: str) -> None:
        """Saved is terminal — the vocabulary has no un-save term, so a repeat records nothing."""
        _open_discover(page, test_server)

        save = page.locator(".recommendation-item").first.locator('[data-outcome="save"]')
        save.click()
        _expect_recorded(page, test_server, "recommendation.saved")
        save.click()
        page.wait_for_timeout(500)

        saved = [e for e in _recorded_events(page, test_server) if e["event_type"] == "recommendation.saved"]
        assert len(saved) == 1

    def test_dismissing_a_recommendation_records_the_outcome_and_collapses_the_row(self, page: Page, test_server: str) -> None:
        """Dismiss emits recommendation.dismissed and removes the row."""
        _open_discover(page, test_server)

        expect(page.locator(".recommendation-item")).to_have_count(2, timeout=5000)
        page.locator(".recommendation-item").first.locator('[data-outcome="dismiss"]').click()

        event = _expect_recorded(page, test_server, "recommendation.dismissed")
        assert event["impression_id"] == _FIRST_IMPRESSION
        expect(page.locator(".recommendation-item")).to_have_count(1, timeout=5000)
        expect(page.locator(f'[data-impression-id="{_FIRST_IMPRESSION}"]')).to_have_count(0)

    def test_hiding_a_recommendation_records_the_outcome_and_collapses_the_row(self, page: Page, test_server: str) -> None:
        """Hide emits recommendation.hidden and removes the row."""
        _open_discover(page, test_server)

        expect(page.locator(".recommendation-item")).to_have_count(2, timeout=5000)
        page.locator(".recommendation-item").first.locator('[data-outcome="hide"]').click()

        event = _expect_recorded(page, test_server, "recommendation.hidden")
        assert event["impression_id"] == _FIRST_IMPRESSION
        expect(page.locator(".recommendation-item")).to_have_count(1, timeout=5000)

    def test_outcome_controls_are_reachable_by_keyboard(self, page: Page, test_server: str) -> None:
        """The controls are real buttons, so Enter activates them with no key handling."""
        _open_discover(page, test_server)

        save = page.locator(".recommendation-item").first.locator('[data-outcome="save"]')
        save.focus()
        page.keyboard.press("Enter")

        _expect_recorded(page, test_server, "recommendation.saved")

    def test_an_anonymous_session_records_nothing(self, page: Page, test_server: str) -> None:
        """No token means no controls and no events, even on the click-through."""
        page.goto(test_server, wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)
        page.evaluate("window.localStorage.removeItem('auth_token')")
        page.reload(wait_until="domcontentloaded", timeout=30000)
        _wait_for_alpine(page)
        page.request.delete(f"{test_server}/api/activity/events")

        # Render a row that would carry controls for a signed-in user, so this
        # exercises the anonymous branch rather than the empty-list one, then
        # click its link to prove the click-through emits nothing either.
        rendered = page.evaluate(
            """() => {
                const body = document.getElementById('recommendationsBody');
                window.userPanes._renderRecommendations(body, { recommendations: [{
                    id: '30', title: 'Pablo Honey', artist: 'Radiohead', year: 1993, score: 0.85,
                    impression_id: '11111111-1111-1111-1111-111111111111', gm_id: 'gm:release:30',
                }], total: 1 });
                body.querySelector('.recommendation-item a').click();
                return document.querySelectorAll('[data-outcome]').length;
            }"""
        )
        assert rendered == 0
        page.wait_for_timeout(500)
        assert _recorded_events(page, test_server) == []
