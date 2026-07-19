---
"@glrs-dev/aj": minor
---

First run no longer dead-ends on a missing key. Starting `agentj` interactively without a provider key configured used to print "Azure API key missing" and exit; it now walks you through entering the key (masked, stored in your OS keychain) and continues straight into a session. The model already has a working default, so that key is the only step. Non-interactive runs (`agentj run`, pipes) keep the plain error.
