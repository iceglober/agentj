import type { Defect } from "../sources/seeded-defect";

/**
 * The clinic-portal fixture: a small Python service whose behavior encodes a
 * domain rule (partner-provisioned orgs never have their own integration), plus
 * in-repo context — a ticket and a migration doc — so tasks can be posed the
 * way real requests arrive: symptom descriptions, punch lists, terse ticket
 * references, and read-only "what's next" questions.
 *
 * `CORRECT_FILES` is the known-good state; `CLINIC_DEFECTS` are the injectable
 * regressions whose find-strings are asserted against it at load.
 */

const PORTAL_PY = `"""Partner portal status, routing, and navigation."""

from flags import is_enabled

INTEGRATION_API = "api"        # provisioned through a channel partner's API
INTEGRATION_DIRECT = "direct"  # practice connects its own system


class Org:
    def __init__(self, name, integration, synced_at=None, flags=None, legacy_flags=None):
        self.name = name
        self.integration = integration
        self.synced_at = synced_at
        self.flags = dict(flags or {})
        self.legacy_flags = dict(legacy_flags or {})


def sync_banner(org):
    """Warn about a broken sync — only meaningful for direct integrations."""
    if org.integration != INTEGRATION_DIRECT:
        return None
    if org.synced_at is None:
        return "Data not syncing"
    return None


def onboarding_route(org):
    """API-provisioned orgs are onboarded by the partner: never send them to /setup."""
    if org.integration == INTEGRATION_API:
        return "/home"
    return "/home" if org.synced_at else "/setup"


def nav_items(org):
    """Partner orgs get the reduced nav; direct orgs see everything."""
    items = ["home", "claims", "settings"]
    if org.integration == INTEGRATION_DIRECT:
        items.insert(1, "reports")
        items.insert(2, "billing")
    if is_enabled(org, "exports"):
        items.append("exports")
    return items
`;

const FLAGS_PY = `"""Feature flags: per-org overrides win over registry defaults."""

REGISTRY = {
    "exports": False,
    "assistant": True,
}


def is_enabled(org, flag):
    if flag in org.flags:
        return bool(org.flags[flag])
    if flag in org.legacy_flags:  # TODO(migration): drop once legacy_flags is retired
        return bool(org.legacy_flags[flag])
    return REGISTRY.get(flag, False)
`;

const TEMPLATES_PY = `"""User-facing copy."""

ASSISTANT_LABEL = "Billing Assistant"


def assistant_intro(name):
    return f"{ASSISTANT_LABEL}: {name}"


def mfa_leave_warning():
    return "A sign-in code is still pending; leaving now may interrupt verification."
`;

const TESTS_PY = `"""Behavioral tests for the clinic portal fixture."""

import sys

from flags import is_enabled
from portal import (
    INTEGRATION_API,
    INTEGRATION_DIRECT,
    Org,
    nav_items,
    onboarding_route,
    sync_banner,
)
from templates import assistant_intro, mfa_leave_warning

FAILURES = []


def check(name, cond):
    if not cond:
        FAILURES.append(name)


api_org = Org("Northwind Dental", INTEGRATION_API)
direct_org = Org("Applegate Clinic", INTEGRATION_DIRECT)
synced_direct = Org("Synced Clinic", INTEGRATION_DIRECT, synced_at="2026-01-01")

# The sync banner is only meaningful for unsynced DIRECT integrations.
check("api orgs never see the sync banner", sync_banner(api_org) is None)
check("unsynced direct orgs see the sync banner", sync_banner(direct_org) == "Data not syncing")
check("synced direct orgs see no banner", sync_banner(synced_direct) is None)

# API-provisioned orgs are onboarded by the partner.
check("api orgs land on /home", onboarding_route(api_org) == "/home")
check("unsynced direct orgs go to /setup", onboarding_route(direct_org) == "/setup")
check("synced direct orgs land on /home", onboarding_route(synced_direct) == "/home")

# Internal navigation is direct-only.
check("api orgs get the partner nav", nav_items(api_org) == ["home", "claims", "settings"])
check(
    "direct orgs get the full nav",
    nav_items(direct_org) == ["home", "reports", "billing", "claims", "settings"],
)

# Per-org overrides win over registry defaults.
check("registry default applies", is_enabled(api_org, "exports") is False)
check(
    "org override wins",
    is_enabled(Org("o", INTEGRATION_API, flags={"exports": True}), "exports") is True,
)
check("unknown flags default off", is_enabled(api_org, "nope") is False)

# Copy renders; exact wording is asserted by file_state checks, not here.
check("assistant intro includes the name", "Kai" in assistant_intro("Kai"))
check("mfa warning is nonempty", len(mfa_leave_warning()) > 0)

if FAILURES:
    print("FAILED: " + "; ".join(FAILURES))
    sys.exit(1)
print("OK")
`;

const MIGRATION_MD = `# Flags v2 migration

Status of the flag-registry consolidation.

- [x] Move all flag defaults into \`REGISTRY\` in flags.py
- [x] Per-org overrides (\`Org.flags\`) win over registry defaults
- [ ] Emit an audit event whenever a per-org override changes
- [ ] Retire the \`legacy_flags\` fallback in \`is_enabled\` and delete \`Org.legacy_flags\`

Notes: the audit event needs the (not yet written) events module; retiring
legacy_flags is safe once no Org constructor passes it.
`;

const TCK_31_MD = `# TCK-31 — MFA leave warning: approved copy

The warning shown when a user navigates away while an MFA code is pending
still uses the draft wording. Legal approved the final copy.

Requirements:
- Must tell the user a sign-in code is still pending.
- Must not use the phrase "unintended consequences" (too alarming).
- Keep it to one sentence.

Acceptance: \`python3 tests.py\` still passes; only templates.py changes.
`;

export const CORRECT_FILES: Record<string, string> = {
  "portal.py": PORTAL_PY,
  "flags.py": FLAGS_PY,
  "templates.py": TEMPLATES_PY,
  "tests.py": TESTS_PY,
  "docs/migration.md": MIGRATION_MD,
  "tickets/TCK-31.md": TCK_31_MD,
};

/**
 * Injectable regressions. Each `prompt` is user-voice: a symptom or request in
 * product terms, never a pointer at the defective file or the failing test.
 */
export const CLINIC_DEFECTS = {
  bannerForPartners: {
    id: "banner-partners",
    file: "portal.py",
    find: "    if org.integration != INTEGRATION_DIRECT:\n        return None\n    if org.synced_at is None:",
    replace: "    if org.synced_at is None:",
    note: "banner no longer gated on direct integration",
    prompt:
      'Orgs provisioned through our channel partner are seeing a "Data not syncing" banner. ' +
      "They never have their own connection to break — that banner only makes sense for " +
      "direct integrations. Make it stop for partner orgs without breaking it for direct ones.",
  },
  setupRedirect: {
    id: "setup-redirect",
    file: "portal.py",
    find: '    if org.integration == INTEGRATION_API:\n        return "/home"\n    return "/home" if org.synced_at else "/setup"',
    replace: '    return "/home" if org.synced_at else "/setup"',
    note: "API orgs fall through to the /setup redirect",
    prompt:
      "A partner-provisioned org is getting bounced to /setup on first sign-in even though " +
      "their onboarding is handled entirely by the partner. They should land on /home. " +
      "Direct-integration practices should still get /setup until they've synced.",
  },
  navLeak: {
    id: "nav-leak",
    file: "portal.py",
    find: '    if org.integration == INTEGRATION_DIRECT:\n        items.insert(1, "reports")\n        items.insert(2, "billing")',
    replace: '    items.insert(1, "reports")\n    items.insert(2, "billing")',
    note: "internal nav items shown to every org",
    prompt:
      "Partner orgs can suddenly see the whole internal navigation — reports, billing, " +
      "everything. We absolutely cannot show that to them. Figure out whether it's the flag " +
      "registry or the nav logic and fix the actual cause.",
  },
  flagOverride: {
    id: "flag-override",
    file: "flags.py",
    find: "    if flag in org.flags:\n        return bool(org.flags[flag])\n",
    replace: "",
    note: "per-org overrides ignored",
    prompt:
      "Turning a feature off for one specific org does nothing — the global default always " +
      "wins. Org-level settings are supposed to take precedence.",
  },
  personaLabel: {
    id: "persona-label",
    file: "templates.py",
    find: 'ASSISTANT_LABEL = "Billing Assistant"',
    replace: 'ASSISTANT_LABEL = "Organization Persona"',
    note: "internal jargon leaked into customer-facing copy",
    prompt:
      'Customers should never see the words "Organization Persona" — the customer-facing ' +
      'label is "Billing Assistant".',
  },
  signinSentence: {
    id: "signin-sentence",
    file: "templates.py",
    find: '    return f"{ASSISTANT_LABEL}: {name}"',
    replace:
      "    return f\"{ASSISTANT_LABEL}: {name}. We'll create a sign-in for you on each payer's website.\"",
    note: "over-promising sentence added to the intro",
    prompt:
      "Kill the sentence about creating a sign-in on each payer's website — we don't do that.",
  },
  draftMfaCopy: {
    id: "mfa-copy",
    file: "templates.py",
    find: '    return "A sign-in code is still pending; leaving now may interrupt verification."',
    replace:
      '    return "You are currently waiting for a code. If you leave now, there may be unintended consequences."',
    note: "draft MFA copy shipped instead of the approved wording",
    prompt: "wrap up TCK-31",
  },
} satisfies Record<string, Defect>;
