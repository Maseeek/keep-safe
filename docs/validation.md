# Validate the login handoff

Status on 17 October 2026: plan prepared, no independent participant sessions completed. Automated tests verify real Chromium login and agent resume; they do not prove physical-phone delivery, usability or demand. Keep results separate from targets below.

## Questions to answer

- Does a website login interrupt users when they are away from their computer, and how often?
- Can a new user pair their phone and return the same authenticated browser to an agent without assistance?
- Does Keep Safe save effort over their current mobile agent app, remote desktop or returning to the computer?
- Is easier connectivity worth a recurring charge, and would a team need separate approvers?

## First cohort and boundaries

Rehearse with the owner, then propose five independent consenting developers with recent examples of this interruption. Owner rehearsals do not count toward cohort gates. Include at least two agent clients and both iPhone and Android. Use already available devices; do not buy hardware or services within the £0 budget.

Each participant uses their own isolated bridge configuration, owner credential, phone pairing and dedicated test browser. Do not share the project owner's link or an existing authenticated personal browser. Current remembered phones belong to one owner; they are not separate team accounts.

This is a recruitment plan, not authorization to message people, publish source or grant repository access. Draft invitations for the owner's later use. The public demo needs no repository access, but a real bridge pilot needs an owner-approved private distribution path. No invitations, grants or interviews have happened yet.

## Session script

1. Ask about the last real interruption before showing the app: what the agent needed, where the person was, how they resolved it and the time lost. Accept "this never happens" as useful evidence. Avoid collecting service names or account identifiers.
2. Ask the participant to explain the demo's request, website origin, expiry and handback. Confirm they understand that approving gives them live browser control and the demo never takes real credentials.
3. From a documented fresh install, have them start the bridge, configure one agent, pair a phone and diagnose a wrong bridge address. Time from installed prerequisites; record installation time separately. Include a non-default port/configuration directory case.
4. On a synthetic test site, run two intended success-path handoffs per participant, ten total: agent request, phone approval, focus/type/scroll, then explicit handback. Success requires the agent to resume in the same authenticated browser before the original deadline. A green app status alone is insufficient.
5. Switch the phone between Wi-Fi and mobile data, leave/reopen the app, and exercise expiry and remembered-device revocation. Keep the computer and its route running. Check actual lock-screen push and its destination; do not infer delivery from a subscription response.
6. Repeat the task using their usual method. Alternate which method comes first across participants to reduce learning effects. Compare within the same person's setup and record when an alternative already solves the job.
7. Show the [future offer hypotheses](product.md#future-offers-to-test), with the free option visible. Ask which, if any, they would choose and why. Request permission for a later trial follow-up without taking money or adding them to a mailing list.

Observe only synthetic credentials and pages. For an optional real-world trial, participants enter credentials privately with observation and recording stopped. Never ask for a password, OTP, cookie, pairing link or browser debug endpoint. Do not record screens, trace traffic or upload login-bearing logs. Participants can stop at any time.

Use the packaged [synthetic rehearsal](connection.md#rehearse-a-login-handoff) for step 4. It opens an isolated virtual practice page, uses the existing external-browser handoff protocol and verifies the returned synthetic authenticated session after reload. It needs no private-network exception or external fixture server. The original developer login fixture remains a separate automated test aid. A rehearsed desktop or mobile-emulated session is not a physical-phone or independent participant result.

## Measures and proposed gates

These small-cohort thresholds are decision rules, not statistical proof or launch promises. Unplanned failed, abandoned, denied, expired and unsupported success-path attempts stay in the ten-attempt denominator. Report deliberately exercised denial/expiry/revocation checks separately. Record failure reasons rather than reporting only completed logins. Pair each intended login task with its usual-method baseline; report the count of successful matched pairs and all failures alongside timing medians.

| Measure | Definition | Gate before a hosted prototype |
| --- | --- | --- |
| Relevant problem | Recent away-from-desk interruption described before seeing the demo. | At least 3 of 5 encountered it in the previous two weeks. |
| Setup | Pairing and agent configuration work without direct operator intervention, from installed prerequisites. | At least 4 of 5 finish within 10 minutes; track prerequisite installation separately. |
| Handoff | Same-browser authenticated agent resume within original expiry. | At least 8 of 10 attempted synthetic handoffs succeed; no authority or credential-handling defect. |
| Interruption time | Request creation until confirmed authenticated agent resume. Compare matched successful tasks with the same person's usual method. | Successful-attempt median under 2 minutes; at least 8 successful matched pairs, with median improvement of at least 30 seconds and 25%. Report all failed attempts too. |
| Repeated use | Participant initiates a second useful handoff on a later day, excluding prompted demo repetitions. | At least 3 of 5 during a seven-day trial. |
| Paid interest | Chooses a stated paid hypothesis with the free option visible and requests a follow-up trial. | At least 2 of 5; willingness remains unproven until a later authorized paid experiment. |

Stop a pilot for unintended authority, input disclosure or another credential-handling defect. Fix and repeat the affected safety flow before further trials. If the need is rare or existing tools solve it, narrow the audience before building a relay. If setup dominates failures, improve setup before adding accounts or billing.

Seven-day observation may extend beyond autonomous development's stop on 24 October at 09:00 London. This plan does not extend that authorization or schedule interviews/follow-ups. The owner must arrange later work.

## Minimal evidence record

Use consented, owner-held notes in ignored `.keep-safe/validation/`, with a random participant code. Keep contact details separate and outside Git. Proposed fields:

```text
participant_code, date, agent_family, phone_os_family
recent_interruption_yes_no, usual_method_category
prerequisites_minutes, setup_minutes, setup_success, assistance_needed
handoff_attempts, authenticated_resumes, denied, expired, abandoned
successful_duration_seconds, failure_category, alternative_duration_seconds
physical_push_pass_fail_not_tested, revocation_pass_fail_not_tested
later_day_return_yes_no_not_observed, offer_choice, follow_up_requested
```

Use broad failure categories: installation, pairing, network, unsupported authentication, focus/control, expiry and agent resume. Exclude URLs, origin names, input content, screenshots, tokens, cookies, IP addresses and identifying transcripts. No telemetry or tracking service is added.

Ask permission before taking notes. Delete raw notes within 14 days of a session or earlier on request; retain only non-identifying aggregate counts the participant agreed could be kept. This is a proposed practice, not automated retention functionality.

## Current evidence

| Evidence | Observed result |
| --- | --- |
| Current local automated suite | 303 tests pass, including synthetic real-browser login, authenticated resume, custom-port MCP configuration, isolated rehearsal, trusted touch gestures and positioned nested scrolling, native keyboard controls and focus recovery, open-component and embedded-frame controls, origin/opaque-frame checks, password clearing and popup handback protection, and per-pairing notification lifecycle. Push-provider delivery is mocked; release/CI evidence is recorded in progress. |
| Physical phone, push and assistive technology | Not verified. |
| Independent sessions and later-day returns | Not run. |
| Paid demand, relay cost and contribution | Not measured. |

Update only with direct evidence and link technical verification in [progress.md](progress.md). Do not replace unknown results with the targets.
