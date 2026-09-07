# Transactional email

Every email the platform sends goes through one function. This describes what it does, what
it refuses to do, and what to check when an email does not arrive.

Written 2026-09-07, after discovering that every operator alert the platform had ever tried
to send was being discarded before it reached the email provider.

---

## What this does

`sendTransactionalEmail` in `src/lib/email/send.ts` is the single way an email leaves this
system. It validates the message, sends it via Resend, and records anything that fails.

Templates live in `src/lib/email/templates/`. Each one exports a subject function and a
body function. Nothing else builds email HTML.

`sendTransactionalEmailWithDedup` in `src/lib/notifications/` wraps it for event-driven
mail that must only go out once per event. It keys on `notifications_log`.

---

## The one thing most likely to surprise you: audience

Emails are either **operator** mail or **customer** mail, and the rules differ.

| | operator | customer |
|---|---|---|
| Who reads it | doug@margenticos.com and nobody else | a client or a prospect |
| `undefined` / `null` / `NaN` check | applies | applies |
| Em dash / en dash check | **does not apply** | applies |

Set it on the send call:

```ts
await sendTransactionalEmail({
  to: operatorEmail,
  subject: agentFailureSubject(orgName, docType),
  html: agentFailureTemplate({ ... }),
  audience: 'operator',
})
```

**The default is `customer`.** Forgetting the label can only ever make an email stricter,
never laxer.

### Why the dash rule does not apply to internal mail

The dash ban exists because MargenticOS's ICP is founder-led consulting firms burned by AI
email, and an em dash is the most recognisable tell. It is a rule about copy that reaches a
client or a prospect. An internal alert reaches neither, and `MargenticOS — Operator Alert`
is correct English for a branding line.

Applying it to internal mail was not a harmless over-reach. It meant a cosmetic rule could
suppress a production alert, and it did, for the entire life of that code. See ADR-050.

### Why the rendering checks DO still apply to internal mail

A literal `undefined` in an email means a template was handed a missing variable. That is a
bug whoever reads the email, and an operator alert that says "Regeneration for undefined
could not be started" is not more acceptable for being internal.

---

## When an email does not arrive

**Check MON-030 first.** It reads `email_delivery_failures` on every monitor sweep and
turns PROBLEM on any unresolved row. Its detail line names the subject and the reason.

The two reasons a send fails, and what each means:

**`content_validation`** — the message never reached Resend. We rejected our own email.
  - "contains em dash" on an internal alert: the send call is missing `audience: 'operator'`.
  - "contains em dash" on client mail: the template genuinely needs fixing. Use a period, a
    comma, or a colon when what follows is the thing described.
  - "contains literal undefined": a template was called without a value it interpolates.

**`provider_send`** — Resend rejected it or was unreachable. Check `RESEND_API_KEY`,
`RESEND_FROM_EMAIL`, and the Resend dashboard.

Once the cause is fixed, set `resolved_at` on the row. **Never clear rows to make the board
green.** The history of what failed is the only record that any of it happened.

### Where else to look

`agent_runs.error_message` holds the reason a document agent failed, which is usually what
the alert was about. Vercel runtime logs carry the `sendTransactionalEmail` lines. Sentry
gets every validation failure. All three existed on 2026-09-05 and none of them was read
for two days, which is why MON-030 exists.

---

## Why a failed send returns rather than throws

`sendTransactionalEmail` returns `{ success: false, error }`. It does not throw.

That is deliberate: a notification must never be able to fail the run it is reporting on. A
failed email about a failed agent is still only one failure.

The cost is that every caller has to remember to check a return value, and on 2026-09-05
none of the twenty-one call sites did. The route that sends the agent-failure alert wraps
the call in `try/catch`, and a returned value does not enter a catch.

So the recording is done **inside the function**, where no caller can forget it. That is
what `email_delivery_failures` and MON-030 are for. Callers may still check the return value
and log it, and several do, but nothing depends on their remembering.

---

## Verifying it end to end

```
npx dotenv -e .env.local -- npx tsx scripts/verify-operator-alert-delivery.ts
```

**It sends a real email. Run it deliberately.** It sends the real agent-failure alert,
confirms a deliberately broken email is still rejected, confirms the rejection lands in
`email_delivery_failures` and turns MON-030 red, then resolves the row.

A test cannot replace this. Before 2026-09-07 every test fed the validator hand-written
strings and mocked Resend, so nothing had ever rendered a real template and asked the real
validator whether it would go out. That is precisely the gap the failure lived in.

`src/lib/email/__tests__/audience-and-delivery.test.ts` closes the first half: it renders
all twenty templates with real parameters and asserts the verdict for the audience each is
actually sent to. It also reads the templates directory and fails if a template is not
classified, so adding one forces a decision about who it is for.

---

## Two things worth knowing

**`RESEND_OPERATOR_EMAIL` differs between environments.** Production sends to
doug@margenticos.com; local `.env.local` sends to a personal address. If alerts are expected
at one and arriving at the other, that is why.

**`TEST_EMAIL_RECIPIENT` redirects everything.** If it is set, every email goes there
regardless of `to`. Useful in staging, confusing if you forget it is set.
