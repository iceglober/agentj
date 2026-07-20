---
"@glrs-dev/aj": patch
---

Ground completion claims in the turn's actual tool activity. AgentJ no longer reports `status=done` when it ran no tools that turn — such a report is fabricated (it fills the completion-report template from the plan text without doing or validating the work), so it is rejected and the model gets one corrective retry, then an explicit failure report. The same primitive still verifies background-job claims: saying it is monitoring work requires a started job. Both checks now live in one grounding gate (`completion-grounding.ts`) instead of separate per-symptom guards. The `gpt-5.6-sol` and `gpt-5.6-terra` profiles also re-enable the evidence rule (`hallucinationGuard`), which the subtractive 5.6 prompt guidance had dropped, so the model is told never to claim a test result it has not observed via a tool this session.
